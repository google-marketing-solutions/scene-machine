#!/usr/bin/env python3
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Deterministic FFmpeg assembly pipeline for Scene Machine ad videos.

Normalizes user or generated keyframes and video clips, renders crisp RGBA
brand lower-thirds and closing CTA endcards via Pillow, mixes voiceover and
background music with two-pass loudness normalization (-14.0 LUFS), and
exports web-ready MP4 deliverables (+faststart).

Contract: on success the `render` command prints one JSON line on stdout
(`status`, `primary_video`, `video_stream_duration_seconds`, ...). On failure
one JSON line goes to stderr, `{"error": ..., "message": ..., "shotIndex": ...,
"hint": ...}`, with exit code 2 (usage), 3 (missing input), 4 (dependency
missing or ffmpeg failure), 5 (invalid storyboard) or 6 (output verification
failed). Warnings are JSON lines on stderr as well. Set SCENE_MACHINE_DEBUG=1
to get tracebacks and the failing ffmpeg log.
"""

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from typing import Any

try:
  from PIL import Image, ImageDraw, ImageFont  # pylint: disable=g-import-not-at-top

  HAS_PILLOW = True
except ImportError:
  HAS_PILLOW = False

EXIT_USAGE = 2
EXIT_MISSING_INPUT = 3
EXIT_DEPENDENCY = 4
EXIT_INVALID_STORYBOARD = 5
EXIT_VERIFICATION = 6

MIN_SHOTS = 2
MAX_SHOTS = 6
SUPPORTED_ASPECT_RATIOS = ("16:9", "9:16")
DEFAULT_SHOT_SECONDS = 6.0
DEFAULT_TARGET_LUFS = -14.0
LOUDNESS_RANGE_LU = 11.0
TRUE_PEAK_CEILING_DBTP = -1.5
SHORT_CLIP_TOLERANCE_SECONDS = 0.25
DURATION_TOLERANCE_SECONDS = 0.05
SQUARE_CROP_HINT = (
  "1:1 is produced as a crop of the 9:16 render: set aspectRatio 9:16 and exportSquareCrop true"
)
PILLOW_HINT = "pip install pillow or pass --allow-no-overlays"
FFMPEG_HINT = "install ffmpeg (it provides ffmpeg and ffprobe) and make sure it is on PATH"

DEFAULT_PALETTE = {
  "backgroundHex": "#0F172A",
  "primaryAccentHex": "#38BDF8",
  "secondaryAccentHex": "#F59E0B",
  "textLightHex": "#F8FAFC",
}

HEX_COLOR_RE = re.compile(r"^#([0-9A-Fa-f]{6})$")
LOUDNORM_JSON_RE = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.DOTALL)

FONT_BOLD_CANDIDATES = (
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
)
FONT_REGULAR_CANDIDATES = (
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "C:/Windows/Fonts/arial.ttf",
)


class AssemblyError(RuntimeError):
  """Structured failure: reported as one JSON line on stderr plus an exit code."""

  def __init__(
    self,
    exit_code: int,
    error: str,
    message: str,
    shot_index: int | None = None,
    hint: str | None = None,
    details: str | None = None,
  ):
    super().__init__(message)
    self.exit_code = exit_code
    self.error = error
    self.message = message
    self.shot_index = shot_index
    self.hint = hint
    self.details = details

  def to_payload(self) -> dict[str, Any]:
    payload: dict[str, Any] = {"error": self.error, "message": one_line(self.message)}
    if self.shot_index is not None:
      payload["shotIndex"] = self.shot_index
    if self.hint:
      payload["hint"] = self.hint
    return payload


def one_line(text: Any) -> str:
  """Collapses whitespace so a message always fits on a single line."""
  return " ".join(str(text).split())


def emit_stderr_json(payload: dict[str, Any]) -> None:
  print(json.dumps(payload), file=sys.stderr, flush=True)


def warn(code: str, **fields: Any) -> None:
  """Prints a one-line JSON warning on stderr without aborting the render."""
  emit_stderr_json({"warning": code, **fields})


def missing_input(message: str, shot_index: int | None = None) -> AssemblyError:
  return AssemblyError(EXIT_MISSING_INPUT, "missing_input", message, shot_index=shot_index)


def invalid_storyboard(
  message: str, shot_index: int | None = None, hint: str | None = None
) -> AssemblyError:
  return AssemblyError(
    EXIT_INVALID_STORYBOARD, "invalid_storyboard", message, shot_index=shot_index, hint=hint
  )


def dependency_missing(message: str, hint: str | None = None) -> AssemblyError:
  return AssemblyError(EXIT_DEPENDENCY, "dependency_missing", message, hint=hint)


def verification_failed(message: str) -> AssemblyError:
  return AssemblyError(EXIT_VERIFICATION, "verification_failed", message)


def resolve_local_path(raw_uri_or_path: str | None) -> Path | None:
  """Strips URI schemes and query suffixes to locate a local workspace file."""
  if not raw_uri_or_path:
    return None
  cleaned = raw_uri_or_path.strip()
  if not cleaned:
    return None
  if "?" in cleaned:
    cleaned = cleaned.split("?", 1)[0]
  if "://" in cleaned:
    _, rest = cleaned.split("://", 1)
    cleaned = "/" + rest.lstrip("/")
  return Path(cleaned)


def parse_hex_rgba(hex_str: str, alpha: int = 255) -> tuple[int, int, int, int]:
  """Converts a #RRGGBB string into an RGBA tuple."""
  match = HEX_COLOR_RE.match((hex_str or "").strip())
  if not match:
    return (15, 23, 42, alpha)
  raw = match.group(1)
  return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), alpha)


def sanitize_hex(hex_str: str | None, fallback: str) -> str:
  """Returns a validated #RRGGBB string."""
  if hex_str and HEX_COLOR_RE.match(hex_str.strip()):
    return hex_str.strip()
  return fallback


def hex_color_arg(value: str) -> str:
  """argparse type: accepts only #RRGGBB (usage error, exit 2, otherwise)."""
  if not HEX_COLOR_RE.match((value or "").strip()):
    raise argparse.ArgumentTypeError(f"expected a #RRGGBB colour, got {value!r}")
  return value.strip()


def load_font(candidates: tuple[str, ...], size: int) -> Any:
  """Loads the first available TrueType font, else Pillow's scalable default font."""
  for font_path in candidates:
    if Path(font_path).is_file():
      try:
        return ImageFont.truetype(font_path, size=size)
      except OSError:
        continue
  try:
    # Pillow >= 10.1 ships a scalable FreeType default; older versions only have a bitmap font.
    return ImageFont.load_default(size=size)
  except TypeError:
    return ImageFont.load_default()


def wrap_text(draw: Any, text: str, font: Any, max_width: int) -> list[str]:
  """Wraps text into lines fitting within max_width pixels."""
  words = (text or "").strip().split()
  if not words:
    return []
  lines: list[str] = []
  current = words[0]
  for word in words[1:]:
    candidate = f"{current} {word}"
    bbox = draw.textbbox((0, 0), candidate, font=font)
    if (bbox[2] - bbox[0]) <= max_width:
      current = candidate
    else:
      lines.append(current)
      current = word
  lines.append(current)
  return lines


def render_lower_third_png(
  output_png: Path,
  width: int,
  height: int,
  headline: str,
  subtext: str,
  palette: dict[str, str],
) -> bool:
  """Renders an anti-aliased RGBA lower-third banner PNG."""
  headline = headline or ""
  subtext = subtext or ""
  if not HAS_PILLOW or (not headline.strip() and not subtext.strip()):
    return False

  img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
  draw = ImageDraw.Draw(img)

  is_vertical = height > width
  margin_x = int(width * (0.06 if is_vertical else 0.045))
  margin_bottom = int(height * (0.10 if is_vertical else 0.08))
  max_card_w = int(width * (0.88 if is_vertical else 0.56))

  title_size = max(22, int(height * (0.026 if is_vertical else 0.040)))
  sub_size = max(16, int(height * (0.018 if is_vertical else 0.026)))
  font_bold = load_font(FONT_BOLD_CANDIDATES, title_size)
  font_reg = load_font(FONT_REGULAR_CANDIDATES, sub_size)

  pad_x = 22
  pad_y = 16
  accent_w = 6
  inner_max_w = max_card_w - (pad_x * 2) - accent_w - 12

  head_lines = wrap_text(draw, headline, font_bold, inner_max_w)[:2]
  sub_lines = wrap_text(draw, subtext, font_reg, inner_max_w)[:2]

  measured_w = 0
  total_text_h = 0
  line_gap = 6

  for line in head_lines:
    bbox = draw.textbbox((0, 0), line, font=font_bold)
    measured_w = max(measured_w, bbox[2] - bbox[0])
    total_text_h += (bbox[3] - bbox[1]) + line_gap

  if head_lines and sub_lines:
    total_text_h += 4

  for line in sub_lines:
    bbox = draw.textbbox((0, 0), line, font=font_reg)
    measured_w = max(measured_w, bbox[2] - bbox[0])
    total_text_h += (bbox[3] - bbox[1]) + line_gap

  card_w = min(max_card_w, measured_w + (pad_x * 2) + accent_w + 16)
  card_h = total_text_h + (pad_y * 2)
  x0 = margin_x
  y0 = height - margin_bottom - card_h
  x1 = x0 + card_w
  y1 = y0 + card_h

  bg_rgba = parse_hex_rgba(palette["backgroundHex"], alpha=218)
  accent_rgba = parse_hex_rgba(palette["primaryAccentHex"], alpha=255)
  text_rgba = parse_hex_rgba(palette["textLightHex"], alpha=255)
  sub_rgba = (
    max(180, text_rgba[0]),
    max(185, text_rgba[1]),
    max(195, text_rgba[2]),
    230,
  )

  draw.rounded_rectangle([x0, y0, x1, y1], radius=12, fill=bg_rgba)
  draw.rounded_rectangle(
    [x0 + 12, y0 + 12, x0 + 12 + accent_w, y1 - 12],
    radius=3,
    fill=accent_rgba,
  )

  cursor_x = x0 + 12 + accent_w + 14
  cursor_y = y0 + pad_y
  for line in head_lines:
    draw.text((cursor_x, cursor_y), line, font=font_bold, fill=text_rgba)
    bbox = draw.textbbox((0, 0), line, font=font_bold)
    cursor_y += (bbox[3] - bbox[1]) + line_gap

  if head_lines and sub_lines:
    cursor_y += 4

  for line in sub_lines:
    draw.text((cursor_x, cursor_y), line, font=font_reg, fill=sub_rgba)
    bbox = draw.textbbox((0, 0), line, font=font_reg)
    cursor_y += (bbox[3] - bbox[1]) + line_gap

  img.save(output_png, format="PNG")
  return True


def render_endcard_png(
  output_png: Path,
  width: int,
  height: int,
  brand_name: str,
  endcard: dict[str, Any],
  palette: dict[str, str],
) -> bool:
  """Renders a sleek branded CTA endcard overlay PNG."""
  if not HAS_PILLOW or not endcard.get("enabled", True):
    return False

  brand_name = brand_name or ""
  headline = (endcard.get("headline") or brand_name or "").strip()
  subheadline = (endcard.get("subheadline") or "").strip()
  cta_text = (endcard.get("ctaText") or "Learn More").strip()
  cta_url = (endcard.get("ctaUrl") or "").strip()
  if not headline:
    return False

  img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
  draw = ImageDraw.Draw(img)

  bg_rgba = parse_hex_rgba(palette["backgroundHex"], alpha=224)
  primary_rgba = parse_hex_rgba(palette["primaryAccentHex"], alpha=255)
  secondary_rgba = parse_hex_rgba(palette["secondaryAccentHex"], alpha=255)
  text_rgba = parse_hex_rgba(palette["textLightHex"], alpha=255)

  is_vertical = height > width
  panel_margin_x = int(width * (0.07 if is_vertical else 0.14))
  panel_margin_y = int(height * (0.22 if is_vertical else 0.16))
  px0, py0 = panel_margin_x, panel_margin_y
  px1, py1 = width - panel_margin_x, height - panel_margin_y

  draw.rounded_rectangle(
    [px0, py0, px1, py1],
    radius=20,
    fill=bg_rgba,
    outline=(primary_rgba[0], primary_rgba[1], primary_rgba[2], 150),
    width=2,
  )

  panel_w = px1 - px0
  max_text_w = int(panel_w * 0.84)

  brand_font = load_font(FONT_BOLD_CANDIDATES, max(16, int(height * 0.022)))
  head_font = load_font(
    FONT_BOLD_CANDIDATES,
    max(28, int(height * (0.036 if is_vertical else 0.054))),
  )
  sub_font = load_font(
    FONT_REGULAR_CANDIDATES,
    max(18, int(height * (0.022 if is_vertical else 0.030))),
  )
  cta_font = load_font(
    FONT_BOLD_CANDIDATES,
    max(18, int(height * (0.022 if is_vertical else 0.030))),
  )
  url_font = load_font(FONT_REGULAR_CANDIDATES, max(15, int(height * 0.020)))

  head_lines = wrap_text(draw, headline, head_font, max_text_w)[:3]
  sub_lines = wrap_text(draw, subheadline, sub_font, max_text_w)[:2]

  center_x = (px0 + px1) // 2
  cursor_y = py0 + int((py1 - py0) * 0.14)

  if brand_name.strip():
    label = brand_name.strip().upper()
    bbox = draw.textbbox((0, 0), label, font=brand_font)
    bw = bbox[2] - bbox[0]
    bh = bbox[3] - bbox[1]
    draw.text(
      (center_x - bw // 2, cursor_y),
      label,
      font=brand_font,
      fill=secondary_rgba,
    )
    cursor_y += bh + 18

  for line in head_lines:
    bbox = draw.textbbox((0, 0), line, font=head_font)
    lw = bbox[2] - bbox[0]
    lh = bbox[3] - bbox[1]
    draw.text((center_x - lw // 2, cursor_y), line, font=head_font, fill=text_rgba)
    cursor_y += lh + 10

  if sub_lines:
    cursor_y += 6
    for line in sub_lines:
      bbox = draw.textbbox((0, 0), line, font=sub_font)
      lw = bbox[2] - bbox[0]
      lh = bbox[3] - bbox[1]
      draw.text(
        (center_x - lw // 2, cursor_y),
        line,
        font=sub_font,
        fill=(text_rgba[0], text_rgba[1], text_rgba[2], 215),
      )
      cursor_y += lh + 8

  if cta_text:
    cursor_y += 22
    bbox = draw.textbbox((0, 0), cta_text, font=cta_font)
    cw = bbox[2] - bbox[0]
    ch = bbox[3] - bbox[1]
    btn_w = cw + 56
    btn_h = ch + 26
    bx0 = center_x - btn_w // 2
    by0 = cursor_y
    draw.rounded_rectangle(
      [bx0, by0, bx0 + btn_w, by0 + btn_h],
      radius=btn_h // 2,
      fill=primary_rgba,
    )
    luminance = 0.299 * primary_rgba[0] + 0.587 * primary_rgba[1] + 0.114 * primary_rgba[2]
    btn_text_fill = (15, 23, 42, 255) if luminance > 155 else (248, 250, 252, 255)
    draw.text(
      (center_x - cw // 2, by0 + (btn_h - ch) // 2 - 2),
      cta_text,
      font=cta_font,
      fill=btn_text_fill,
    )
    cursor_y += btn_h + 16

  if cta_url:
    bbox = draw.textbbox((0, 0), cta_url, font=url_font)
    uw = bbox[2] - bbox[0]
    draw.text(
      (center_x - uw // 2, cursor_y),
      cta_url,
      font=url_font,
      fill=(text_rgba[0], text_rgba[1], text_rgba[2], 200),
    )

  img.save(output_png, format="PNG")
  return True


def check_tools() -> None:
  """Fails fast (exit 4) when ffmpeg or ffprobe is not on PATH."""
  for tool in ("ffmpeg", "ffprobe"):
    if shutil.which(tool) is None:
      raise dependency_missing(f"{tool} not found on PATH", hint=FFMPEG_HINT)


def run_cmd(cmd: list[str]) -> subprocess.CompletedProcess[str]:
  """Runs ffmpeg/ffprobe; a missing binary or a non-zero exit becomes an exit-4 error."""
  try:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
  except FileNotFoundError as exc:
    raise dependency_missing(f"{cmd[0]} not found on PATH", hint=FFMPEG_HINT) from exc
  if proc.returncode != 0:
    stderr_lines = [line for line in proc.stderr.splitlines() if line.strip()]
    tail = one_line(stderr_lines[-1])[:400] if stderr_lines else "no stderr output"
    raise AssemblyError(
      EXIT_DEPENDENCY,
      "ffmpeg_failed",
      f"{cmd[0]} exited with status {proc.returncode}: {tail}",
      details=f"command: {' '.join(cmd)}\n{proc.stderr.strip()}",
    )
  return proc


def ffprobe_json(media_path: Path, entries: str, extra: list[str] | None = None) -> dict[str, Any]:
  """Runs ffprobe with -of json and returns the parsed document."""
  proc = run_cmd(
    [
      "ffprobe",
      "-v",
      "error",
      *(extra or []),
      "-show_entries",
      entries,
      "-of",
      "json",
      str(media_path),
    ]
  )
  try:
    return json.loads(proc.stdout or "{}")
  except json.JSONDecodeError as exc:
    raise AssemblyError(
      EXIT_DEPENDENCY, "ffmpeg_failed", f"ffprobe returned unreadable output for {media_path}"
    ) from exc


def to_float(value: Any) -> float | None:
  """ffprobe prints 'N/A' for unknown values; map those (and -inf) to None."""
  try:
    result = float(value)
  except (TypeError, ValueError):
    return None
  if math.isnan(result) or math.isinf(result):
    return None
  return result


def probe_duration(media_path: Path) -> float:
  """Returns the container duration in seconds using ffprobe (0.0 when unknown)."""
  info = ffprobe_json(media_path, "format=duration")
  return to_float((info.get("format") or {}).get("duration")) or 0.0


def has_audio_stream(media_path: Path) -> bool:
  """Checks whether a media file contains at least one audio stream."""
  proc = subprocess.run(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      str(media_path),
    ],
    capture_output=True,
    text=True,
    check=False,
  )
  return proc.returncode == 0 and bool(proc.stdout.strip())


def probe_output(media_path: Path) -> dict[str, Any]:
  """Measures the rendered file: per-stream durations, frame count and resolution."""
  info = ffprobe_json(
    media_path, "format=duration:stream=codec_type,duration,nb_frames,width,height"
  )
  streams = info.get("streams") or []
  video = next((s for s in streams if s.get("codec_type") == "video"), None)
  audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
  frames = to_float(video.get("nb_frames")) if video else None
  if video is not None and frames is None:
    counted = ffprobe_json(
      media_path, "stream=nb_read_frames", ["-select_streams", "v:0", "-count_frames"]
    )
    counted_streams = counted.get("streams") or [{}]
    frames = to_float(counted_streams[0].get("nb_read_frames"))
  return {
    "container_duration": to_float((info.get("format") or {}).get("duration")),
    "video_duration": to_float(video.get("duration")) if video else None,
    "audio_duration": to_float(audio.get("duration")) if audio else None,
    "video_frames": int(frames) if frames is not None else None,
    "width": video.get("width") if video else None,
    "height": video.get("height") if video else None,
  }


def measure_loudness(media_path: Path, target_lufs: float) -> dict[str, float | None]:
  """loudnorm measurement pass (print_format=json) over the first audio stream."""
  proc = run_cmd(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i",
      str(media_path),
      "-map",
      "0:a:0",
      "-af",
      (
        f"loudnorm=I={target_lufs:.1f}:LRA={LOUDNESS_RANGE_LU:.0f}:"
        f"TP={TRUE_PEAK_CEILING_DBTP:.1f}:print_format=json"
      ),
      "-f",
      "null",
      "-",
    ]
  )
  match = LOUDNORM_JSON_RE.search(proc.stderr)
  if not match:
    return {}
  try:
    raw = json.loads(match.group(0))
  except json.JSONDecodeError:
    return {}
  keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
  return {key: to_float(raw.get(key)) for key in keys}


def loudnorm_filter(target_lufs: float, measured: dict[str, float | None]) -> str:
  """Second-pass loudnorm (linear, measured_*) or single-pass fallback when unmeasurable."""
  base = f"loudnorm=I={target_lufs:.1f}:LRA={LOUDNESS_RANGE_LU:.0f}:TP={TRUE_PEAK_CEILING_DBTP:.1f}"
  needed = ("input_i", "input_lra", "input_tp", "input_thresh", "target_offset")
  if any(measured.get(key) is None for key in needed):
    # Silence measures as -inf: fall back to the single-pass (dynamic) mode.
    return base
  return (
    f"{base}:linear=true"
    f":measured_I={measured['input_i']:.2f}"
    f":measured_LRA={measured['input_lra']:.2f}"
    f":measured_TP={measured['input_tp']:.2f}"
    f":measured_thresh={measured['input_thresh']:.2f}"
    f":offset={measured['target_offset']:.2f}"
  )


def normalize_image_cmd(args: argparse.Namespace) -> int:
  """Normalizes an input image to exact 16:9 (1280x720) or 9:16 (720x1280)."""
  check_tools()
  src = resolve_local_path(args.input)
  if src is None or not src.is_file():
    raise missing_input(f"input image not found: {args.input}")

  out = Path(args.output)
  out.parent.mkdir(parents=True, exist_ok=True)
  width, height = (1280, 720) if args.aspect_ratio == "16:9" else (720, 1280)
  bg_hex = sanitize_hex(args.bg_hex, DEFAULT_PALETTE["backgroundHex"])

  vf = (
    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={bg_hex},setsar=1"
  )
  run_cmd(
    [
      "ffmpeg",
      "-y",
      "-i",
      str(src),
      "-vf",
      vf,
      "-frames:v",
      "1",
      str(out),
    ]
  )
  print(json.dumps({"status": "ok", "output": str(out), "resolution": f"{width}x{height}"}))
  return 0


def build_audio_master(
  audio_spec: dict[str, Any],
  total_duration: float,
  scratch_dir: Path,
) -> Path:
  """Builds the two-pass loudness-normalized (-14 LUFS) stereo 48 kHz WAV master."""
  premix_wav = scratch_dir / "premix_audio.wav"
  master_wav = scratch_dir / "master_audio.wav"
  music_path = resolve_local_path(audio_spec.get("musicFile"))
  vo_path = resolve_local_path(audio_spec.get("voiceoverFile"))

  has_music = music_path is not None and music_path.is_file()
  has_vo = vo_path is not None and vo_path.is_file()

  duck_vol = float(audio_spec.get("musicDuckVolume", 0.28))
  target_lufs = float(audio_spec.get("targetLufs", DEFAULT_TARGET_LUFS))
  fade_out = min(float(audio_spec.get("fadeOutSeconds", 1.5)), total_duration * 0.4)
  fade_start = max(0.0, total_duration - fade_out)
  stereo48 = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
  premix_out = ["-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", "-t", f"{total_duration:.3f}"]

  if has_vo and has_music:
    filter_complex = (
      f"[0:a]{stereo48},apad=whole_dur={total_duration:.3f},atrim=0:{total_duration:.3f}[vo];"
      f"[1:a]{stereo48},atrim=0:{total_duration:.3f},volume={duck_vol:.3f}[bed];"
      f"[vo][bed]amix=inputs=2:duration=first:normalize=0[aout]"
    )
    run_cmd(
      [
        "ffmpeg",
        "-y",
        "-i",
        str(vo_path),
        "-stream_loop",
        "-1",
        "-i",
        str(music_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[aout]",
        *premix_out,
        str(premix_wav),
      ]
    )
  elif has_music:
    filter_complex = f"[0:a]{stereo48},atrim=0:{total_duration:.3f}[aout]"
    run_cmd(
      [
        "ffmpeg",
        "-y",
        "-stream_loop",
        "-1",
        "-i",
        str(music_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[aout]",
        *premix_out,
        str(premix_wav),
      ]
    )
  elif has_vo:
    filter_complex = (
      f"[0:a]{stereo48},apad=whole_dur={total_duration:.3f},atrim=0:{total_duration:.3f}[aout]"
    )
    run_cmd(
      [
        "ffmpeg",
        "-y",
        "-i",
        str(vo_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[aout]",
        *premix_out,
        str(premix_wav),
      ]
    )
  else:
    run_cmd(
      [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t",
        f"{total_duration:.3f}",
        "-ar",
        "48000",
        "-ac",
        "2",
        str(master_wav),
      ]
    )
    return master_wav

  # Pass 1 measures the mix, pass 2 applies loudnorm with the measured values
  # (linear gain when the true-peak ceiling allows it, limiter otherwise).
  measured = measure_loudness(premix_wav, target_lufs)
  run_cmd(
    [
      "ffmpeg",
      "-y",
      "-i",
      str(premix_wav),
      "-af",
      (
        f"{loudnorm_filter(target_lufs, measured)},afade=t=out:st={fade_start:.3f}:d={fade_out:.3f}"
      ),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      f"{total_duration:.3f}",
      str(master_wav),
    ]
  )
  return master_wav


def md_cell(text: Any) -> str:
  """Makes a value safe for a Markdown table cell (single line, pipes escaped)."""
  return " ".join(str(text if text is not None else "").split()).replace("|", "\\|")


def write_storyboard_markdown(storyboard: dict[str, Any], out_md: Path) -> None:
  """Generates a clean Markdown production summary (ASCII template, no emojis)."""
  brand = storyboard.get("brandName") or "Brand"
  title = storyboard.get("campaignTitle") or f"{brand} Video Ad"
  aspect = storyboard.get("aspectRatio", "16:9")
  total_dur = float(storyboard.get("totalDurationSeconds", 30.0))
  palette = storyboard.get("brandPalette") or {}
  audio_spec = storyboard.get("audioSpec") or {}

  lines = [
    f"# {md_cell(title)} - Storyboard & Production Sheet",
    "",
    f"- **Brand:** {md_cell(brand)}",
    f"- **Primary Aspect Ratio:** `{aspect}`",
    f"- **Total Duration:** `{total_dur:.1f}s`",
    (
      "- **Brand Palette:** "
      f"Background `{palette.get('backgroundHex', '#0F172A')}`, "
      f"Primary `{palette.get('primaryAccentHex', '#38BDF8')}`, "
      f"Secondary `{palette.get('secondaryAccentHex', '#F59E0B')}`, "
      f"Text `{palette.get('textLightHex', '#F8FAFC')}`"
    ),
    "",
    "## Scene Breakdown (YouTube ABCD)",
    "",
    "| Scene | Time Window | ABCD Stage | On-Screen Overlay | Voiceover / Narrative Beat |",
    "| :--- | :--- | :--- | :--- | :--- |",
  ]

  cursor = 0.0
  for idx, shot in enumerate(storyboard.get("shots") or []):
    dur = float(shot.get("durationSeconds") or DEFAULT_SHOT_SECONDS)
    window = f"{cursor:.1f}s - {cursor + dur:.1f}s"
    cursor += dur
    stage = md_cell(shot.get("abcdStage") or "")
    overlay = shot.get("typoOverlay") or {}
    overlay_parts = [
      md_cell(overlay.get("headline") or ""),
      md_cell(overlay.get("subtext") or ""),
    ]
    overlay_txt = " - ".join(p for p in overlay_parts if p) or "None"
    vo_seg = md_cell(shot.get("voiceoverSegment") or "") or "Musical visual beat"
    scene_no = shot.get("shotIndex", idx + 1)
    lines.append(
      f"| Scene {md_cell(scene_no)} | `{window}` | **{stage}** | {overlay_txt} | {vo_seg} |"
    )

  if audio_spec.get("voiceoverScript"):
    lines.extend(
      [
        "",
        "## Full Voiceover Script",
        "",
        f"> {' '.join(str(audio_spec['voiceoverScript']).split())}",
      ]
    )

  if audio_spec.get("musicPrompt"):
    lines.extend(
      [
        "",
        "## Musical Direction",
        "",
        f"`{' '.join(str(audio_spec['musicPrompt']).split())}`",
      ]
    )

  out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_storyboard(sb_path: Path) -> Any:
  """Reads the storyboard JSON (exit 3 when missing, exit 5 when malformed)."""
  if not sb_path.is_file():
    raise missing_input(f"storyboard JSON not found: {sb_path}")
  try:
    return json.loads(sb_path.read_text(encoding="utf-8"))
  except UnicodeDecodeError as exc:
    raise invalid_storyboard(f"storyboard is not UTF-8 text: {exc}") from exc
  except json.JSONDecodeError as exc:
    raise invalid_storyboard(f"storyboard JSON is malformed: {exc}") from exc


def text_or_empty(value: Any, field: str, shot_index: int | None = None) -> str:
  """Accepts a string or null (coerced to '') and rejects any other type."""
  if value is None:
    return ""
  if isinstance(value, str):
    return value
  raise invalid_storyboard(f"{field} must be a string or null", shot_index=shot_index)


def positive_number(value: Any, field: str, default: float, shot_index: int | None = None) -> float:
  """Accepts a positive number (null means default) and rejects anything else."""
  if value is None:
    return default
  if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
    raise invalid_storyboard(f"{field} must be a number greater than 0", shot_index=shot_index)
  return float(value)


def validate_palette(raw: Any) -> dict[str, str]:
  """Returns a complete #RRGGBB palette; invalid colours fail validation."""
  if raw is None:
    raw = {}
  if not isinstance(raw, dict):
    raise invalid_storyboard("brandPalette must be an object")
  palette: dict[str, str] = {}
  for key, default in DEFAULT_PALETTE.items():
    value = raw.get(key)
    if value is None or value == "":
      palette[key] = default
      continue
    if not isinstance(value, str) or not HEX_COLOR_RE.match(value.strip()):
      raise invalid_storyboard(f"brandPalette.{key} must be a #RRGGBB colour (got {value!r})")
    palette[key] = value.strip()
  return palette


def validate_storyboard(storyboard: Any) -> dict[str, Any]:
  """Validates the storyboard before any encoding and returns the render plan."""
  if not isinstance(storyboard, dict):
    raise invalid_storyboard("storyboard must be a JSON object")

  shots = storyboard.get("shots")
  if not isinstance(shots, list):
    raise invalid_storyboard(f"shots must be an array of {MIN_SHOTS} to {MAX_SHOTS} shot objects")
  if not MIN_SHOTS <= len(shots) <= MAX_SHOTS:
    raise invalid_storyboard(
      f"shots must contain between {MIN_SHOTS} and {MAX_SHOTS} entries (got {len(shots)})"
    )

  aspect_ratio = storyboard.get("aspectRatio", "16:9")
  if aspect_ratio == "1:1":
    raise invalid_storyboard(
      "aspectRatio 1:1 is not a render target; allowed values are 16:9 and 9:16",
      hint=SQUARE_CROP_HINT,
    )
  if aspect_ratio not in SUPPORTED_ASPECT_RATIOS:
    raise invalid_storyboard(
      f"unsupported aspectRatio {aspect_ratio!r}; allowed values are 16:9 and 9:16"
    )
  width, height = (1280, 720) if aspect_ratio == "16:9" else (720, 1280)

  palette = validate_palette(storyboard.get("brandPalette"))
  brand_name = text_or_empty(storyboard.get("brandName"), "brandName")

  endcard = storyboard.get("endcardSpec")
  if endcard is None:
    endcard = {"enabled": True}
  if not isinstance(endcard, dict):
    raise invalid_storyboard("endcardSpec must be an object")
  for key in ("headline", "subheadline", "ctaText", "ctaUrl"):
    text_or_empty(endcard.get(key), f"endcardSpec.{key}")
  positive_number(endcard.get("durationSec"), "endcardSpec.durationSec", 3.0)

  audio_spec = storyboard.get("audioSpec")
  if audio_spec is None:
    audio_spec = {}
  if not isinstance(audio_spec, dict):
    raise invalid_storyboard("audioSpec must be an object")
  for key in ("voiceoverFile", "musicFile"):
    value = audio_spec.get(key)
    if value is None or value == "":
      continue
    if not isinstance(value, str):
      raise invalid_storyboard(f"audioSpec.{key} must be a path or file:// URI string")
    audio_path = resolve_local_path(value)
    if audio_path is None or not audio_path.is_file():
      raise missing_input(f"audioSpec.{key} not found: {value}")
  for key in ("musicDuckVolume", "fadeOutSeconds"):
    value = audio_spec.get(key)
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
      raise invalid_storyboard(f"audioSpec.{key} must be a number")
  target = audio_spec.get("targetLufs")
  if target is not None and (isinstance(target, bool) or not isinstance(target, (int, float))):
    raise invalid_storyboard("audioSpec.targetLufs must be a number")

  plan_shots: list[dict[str, Any]] = []
  total_duration = 0.0
  for idx, shot in enumerate(shots):
    if not isinstance(shot, dict):
      raise invalid_storyboard(f"shots[{idx}] must be an object", shot_index=idx + 1)
    raw_index = shot.get("shotIndex", idx + 1)
    shot_index = (
      raw_index if isinstance(raw_index, int) and not isinstance(raw_index, bool) else idx + 1
    )
    duration = positive_number(
      shot.get("durationSeconds"), "durationSeconds", DEFAULT_SHOT_SECONDS, shot_index
    )
    clip_raw = shot.get("clipFile")
    if clip_raw is not None and not isinstance(clip_raw, str):
      raise invalid_storyboard(
        "clipFile must be a path or file:// URI string", shot_index=shot_index
      )
    clip_path = resolve_local_path(clip_raw)
    if clip_path is None or not clip_path.is_file():
      raise missing_input(
        f"clip not found for shotIndex={shot_index}: {clip_raw or '(clipFile not set)'}",
        shot_index=shot_index,
      )
    typo = shot.get("typoOverlay")
    if typo is None:
      typo = {}
    if not isinstance(typo, dict):
      raise invalid_storyboard("typoOverlay must be an object or null", shot_index=shot_index)
    plan_shots.append(
      {
        "shot_index": shot_index,
        "duration": duration,
        "clip": clip_path,
        "headline": text_or_empty(typo.get("headline"), "typoOverlay.headline", shot_index),
        "subtext": text_or_empty(typo.get("subtext"), "typoOverlay.subtext", shot_index),
      }
    )
    total_duration += duration

  return {
    "aspect_ratio": aspect_ratio,
    "width": width,
    "height": height,
    "palette": palette,
    "brand_name": brand_name,
    "endcard": endcard,
    "audio_spec": audio_spec,
    "export_square": bool(storyboard.get("exportSquareCrop")),
    "shots": plan_shots,
    "total_duration": total_duration,
  }


def probe_clips(plan: dict[str, Any]) -> None:
  """Probes every clip once; short clips are padded later but reported as a warning."""
  for shot in plan["shots"]:
    clip_seconds = probe_duration(shot["clip"])
    shot["clip_seconds"] = clip_seconds
    if clip_seconds < shot["duration"] - SHORT_CLIP_TOLERANCE_SECONDS:
      warn(
        "short_clip",
        shotIndex=shot["shot_index"],
        clip_seconds=round(clip_seconds, 3),
        slot_seconds=round(shot["duration"], 3),
      )


def render_shot(
  shot: dict[str, Any],
  idx: int,
  plan: dict[str, Any],
  scratch: Path,
  overlays_enabled: bool,
) -> tuple[Path, int]:
  """Normalizes one clip to the slot (fps, geometry, padding) and composites overlays.

  Returns the normalized clip path and the number of overlays composited.
  """
  width, height, palette = plan["width"], plan["height"], plan["palette"]
  is_last = idx == len(plan["shots"]) - 1
  shot_dur = shot["duration"]
  norm_clip = scratch / f"norm_shot_{idx + 1:02d}.mp4"
  inputs = ["-i", str(shot["clip"])]
  # tpad clones the last frame for a full slot length so that any clip shorter
  # than the slot still yields exactly shot_dur seconds after trim.
  base_vf = (
    f"[0:v]fps=24,"
    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={palette['backgroundHex']},"
    f"setsar=1,tpad=stop_mode=clone:stop_duration={shot_dur:.3f},"
    f"trim=duration={shot_dur:.3f},setpts=PTS-STARTPTS,format=rgba[v0]"
  )
  filter_parts = [base_vf]
  current_label = "[v0]"
  input_idx = 1
  overlays = 0

  if overlays_enabled:
    lt_png = scratch / f"lt_{idx + 1:02d}.png"
    if render_lower_third_png(lt_png, width, height, shot["headline"], shot["subtext"], palette):
      inputs.extend(["-loop", "1", "-t", f"{shot_dur:.3f}", "-i", str(lt_png)])
      lt_end = shot_dur - 0.35 if not is_last else max(1.2, shot_dur - 3.2)
      fade_out_st = max(0.5, lt_end - 0.35)
      next_label = f"[v{input_idx}]"
      filter_parts.append(
        f"[{input_idx}:v]format=rgba,"
        f"fade=t=in:st=0.35:d=0.35:alpha=1,"
        f"fade=t=out:st={fade_out_st:.3f}:d=0.35:alpha=1[ov{input_idx}];"
        f"{current_label}[ov{input_idx}]overlay=0:0:format=auto{next_label}"
      )
      current_label = next_label
      input_idx += 1
      overlays += 1

    if is_last:
      endcard_spec = plan["endcard"]
      ec_png = scratch / "endcard.png"
      if render_endcard_png(ec_png, width, height, plan["brand_name"], endcard_spec, palette):
        ec_dur = min(float(endcard_spec.get("durationSec") or 3.0), shot_dur - 0.5)
        ec_start = max(0.4, shot_dur - ec_dur)
        inputs.extend(["-loop", "1", "-t", f"{shot_dur:.3f}", "-i", str(ec_png)])
        next_label = f"[v{input_idx}]"
        filter_parts.append(
          f"[{input_idx}:v]format=rgba,"
          f"fade=t=in:st={ec_start:.3f}:d=0.45:alpha=1[ov{input_idx}];"
          f"{current_label}[ov{input_idx}]overlay=0:0:format=auto{next_label}"
        )
        current_label = next_label
        input_idx += 1
        overlays += 1

  filter_parts.append(f"{current_label}format=yuv420p[vout]")
  run_cmd(
    ["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filter_parts)]
    + [
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-t",
      f"{shot_dur:.3f}",
      str(norm_clip),
    ]
  )
  return norm_clip, overlays


def build_embedded_audio(plan: dict[str, Any], scratch: Path) -> Path | None:
  """Concatenates the clips' own audio when no voiceover/music was supplied."""
  shots = plan["shots"]
  if not has_audio_stream(shots[0]["clip"]):
    return None
  concat_audio = scratch / "clip_audio.wav"
  clip_inputs: list[str] = []
  filter_nodes: list[str] = []
  for idx, shot in enumerate(shots):
    s_dur = shot["duration"]
    clip_inputs.extend(["-i", str(shot["clip"])])
    if has_audio_stream(shot["clip"]):
      filter_nodes.append(
        f"[{idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
        f"apad=whole_dur={s_dur:.3f},atrim=0:{s_dur:.3f}[a{idx}]"
      )
    else:
      filter_nodes.append(
        f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{s_dur:.3f}[a{idx}]"
      )
  concat_in = "".join(f"[a{i}]" for i in range(len(shots)))
  filter_nodes.append(f"{concat_in}concat=n={len(shots)}:v=0:a=1[acat]")
  run_cmd(
    ["ffmpeg", "-y", *clip_inputs, "-filter_complex", ";".join(filter_nodes)]
    + ["-map", "[acat]", "-ar", "48000", "-ac", "2", str(concat_audio)]
  )
  return concat_audio


def mux_final(concat_txt: Path, master_wav: Path, total_duration: float, final_mp4: Path) -> None:
  """Concatenates the normalized clips and muxes the audio master (x264 high 4.1 + AAC)."""
  run_cmd(
    [
      "ffmpeg",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      str(concat_txt),
      "-i",
      str(master_wav),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level:v",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-t",
      f"{total_duration:.3f}",
      "-movflags",
      "+faststart",
      str(final_mp4),
    ]
  )


def crop_square(final_mp4: Path, square_mp4: Path) -> None:
  """Center-crops the 9:16 render to a 720x720 square deliverable."""
  run_cmd(
    [
      "ffmpeg",
      "-y",
      "-i",
      str(final_mp4),
      "-vf",
      "crop=720:720:0:(ih-720)/2,setsar=1",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "23",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      str(square_mp4),
    ]
  )


def verify_render(video_path: Path, expected_duration: float) -> dict[str, Any]:
  """Exit 6 unless the video stream (not the container) matches the storyboard length."""
  info = probe_output(video_path)
  video_duration = info["video_duration"]
  if video_duration is None:
    raise verification_failed(f"{video_path.name}: no video stream duration reported by ffprobe")
  if abs(video_duration - expected_duration) > DURATION_TOLERANCE_SECONDS:
    raise verification_failed(
      f"{video_path.name}: video stream is {video_duration:.3f} s but the storyboard "
      f"expects {expected_duration:.3f} s (tolerance {DURATION_TOLERANCE_SECONDS:.2f} s)"
    )
  return info


def resolve_mirror_dir(args: argparse.Namespace) -> Path | None:
  """--mirror-dir wins over SCENE_MACHINE_MIRROR_DIR; empty values disable mirroring."""
  raw = getattr(args, "mirror_dir", None) or os.environ.get("SCENE_MACHINE_MIRROR_DIR") or ""
  raw = raw.strip()
  return Path(raw) if raw else None


def mirror_deliverables(
  deliverables: list[Path], mirror_dir: Path | None, out_dir: Path
) -> list[str]:
  """Opt-in copy of the deliverables to a fixed folder (replaces the old /workspace side effect)."""
  if mirror_dir is None:
    return []
  mirrored: list[str] = []
  try:
    mirror_dir.mkdir(parents=True, exist_ok=True)
    if mirror_dir.resolve() == out_dir.resolve():
      return []
    for item in deliverables:
      target = mirror_dir / item.name
      shutil.copy2(item, target)
      mirrored.append(str(target))
  except OSError as exc:
    warn("mirror_failed", mirror_dir=str(mirror_dir), message=one_line(exc))
  return mirrored


def render_storyboard_cmd(args: argparse.Namespace) -> int:
  """Executes validation, clip normalization, overlay compositing, audio mix, mux, checks."""
  check_tools()
  skip_overlays = bool(getattr(args, "no_overlays", False))
  if not HAS_PILLOW and not (args.allow_no_overlays or skip_overlays):
    raise dependency_missing(
      "Pillow is required for lower-thirds and the endcard", hint=PILLOW_HINT
    )
  overlays_enabled = HAS_PILLOW and not skip_overlays

  storyboard = load_storyboard(Path(args.storyboard))
  plan = validate_storyboard(storyboard)
  probe_clips(plan)

  width, height = plan["width"], plan["height"]
  total_duration = plan["total_duration"]
  storyboard["brandPalette"] = plan["palette"]
  storyboard["totalDurationSeconds"] = round(total_duration, 3)

  out_dir = Path(args.output_dir)
  out_dir.mkdir(parents=True, exist_ok=True)
  mirror_dir = resolve_mirror_dir(args)

  with tempfile.TemporaryDirectory(prefix="scene_machine_") as tmp_str:
    scratch = Path(tmp_str)
    normalized_clips: list[Path] = []
    overlay_count = 0
    for idx, shot in enumerate(plan["shots"]):
      norm_clip, overlays = render_shot(shot, idx, plan, scratch, overlays_enabled)
      normalized_clips.append(norm_clip)
      overlay_count += overlays

    concat_txt = scratch / "concat_list.txt"
    concat_txt.write_text(
      "\n".join(f"file '{clip.name}'" for clip in normalized_clips) + "\n",
      encoding="utf-8",
    )

    audio_spec = dict(plan["audio_spec"])
    # Fall back to embedded clip audio only if neither voiceover nor music was supplied.
    if not resolve_local_path(audio_spec.get("musicFile")) and not resolve_local_path(
      audio_spec.get("voiceoverFile")
    ):
      embedded = build_embedded_audio(plan, scratch)
      if embedded is not None:
        audio_spec["musicFile"] = str(embedded)

    master_wav = build_audio_master(audio_spec, total_duration, scratch)

    suffix = "16x9" if plan["aspect_ratio"] == "16:9" else "9x16"
    final_mp4 = out_dir / f"final_video_{suffix}.mp4"
    mux_final(concat_txt, master_wav, total_duration, final_mp4)
    deliverables = [final_mp4]

    if plan["export_square"] and plan["aspect_ratio"] == "9:16":
      square_mp4 = out_dir / "final_video_1x1.mp4"
      crop_square(final_mp4, square_mp4)
      deliverables.append(square_mp4)

    out_sb_json = out_dir / "storyboard.json"
    out_sb_md = out_dir / "storyboard.md"
    out_sb_json.write_text(json.dumps(storyboard, indent=2) + "\n", encoding="utf-8")
    write_storyboard_markdown(storyboard, out_sb_md)
    deliverables.extend([out_sb_json, out_sb_md])

  primary = verify_render(final_mp4, total_duration)
  for extra_video in deliverables[1:]:
    if extra_video.suffix == ".mp4":
      verify_render(extra_video, total_duration)
  loudness = measure_loudness(final_mp4, DEFAULT_TARGET_LUFS) if has_audio_stream(final_mp4) else {}
  mirrored = mirror_deliverables(deliverables, mirror_dir, out_dir)

  summary = {
    "status": "ok",
    "primary_video": str(final_mp4),
    "expected_duration_seconds": round(total_duration, 3),
    "video_stream_duration_seconds": round(primary["video_duration"], 3),
    "audio_stream_duration_seconds": (
      round(primary["audio_duration"], 3) if primary["audio_duration"] is not None else None
    ),
    "video_frames": primary["video_frames"],
    "resolution": f"{width}x{height}",
    "integrated_lufs": loudness.get("input_i"),
    "true_peak_dbtp": loudness.get("input_tp"),
    "overlays_rendered": overlay_count > 0,
    "output_files": [str(p) for p in deliverables],
    "mirrored_to": mirrored,
    "storyboard_json": str(out_sb_json),
    "storyboard_md": str(out_sb_md),
  }
  print(json.dumps(summary), flush=True)
  return 0


def default_output_dir() -> str:
  workdir = os.environ.get("SCENE_MACHINE_WORKDIR") or "./.scene_machine"
  return str(Path(workdir) / "output")


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(
    description="Scene Machine FFmpeg assembly and normalization CLI.",
    epilog=(
      "Exit codes: 0 ok, 2 usage, 3 missing input, 4 dependency missing or ffmpeg failed, "
      "5 invalid storyboard, 6 output verification failed. Errors and warnings are "
      "one-line JSON objects on stderr; SCENE_MACHINE_DEBUG=1 adds tracebacks."
    ),
  )
  sub = parser.add_subparsers(dest="command", required=True)

  p_norm = sub.add_parser(
    "normalize-image",
    help="Letterbox/pillarbox an input image to 1280x720 (16:9) or 720x1280 (9:16).",
  )
  p_norm.add_argument("--input", required=True, help="Source image path or URI.")
  p_norm.add_argument("--output", required=True, help="Target normalized PNG/JPG path.")
  p_norm.add_argument(
    "--aspect-ratio",
    choices=["16:9", "9:16"],
    default="16:9",
    help="Target aspect ratio.",
  )
  p_norm.add_argument(
    "--bg-hex",
    type=hex_color_arg,
    default=DEFAULT_PALETTE["backgroundHex"],
    help="Padding background color in #RRGGBB format.",
  )
  p_norm.set_defaults(func=normalize_image_cmd)

  p_render = sub.add_parser(
    "render",
    help="Render final commercial MP4 video from storyboard.json.",
  )
  p_render.add_argument("--storyboard", required=True, help="Path to storyboard.json.")
  p_render.add_argument(
    "--output-dir",
    default=default_output_dir(),
    help=(
      "Output directory for the final MP4 and storyboard deliverables "
      "(default: ${SCENE_MACHINE_WORKDIR:-./.scene_machine}/output)."
    ),
  )
  p_render.add_argument(
    "--allow-no-overlays",
    action="store_true",
    help=(
      "Render even when Pillow is not installed (no lower-thirds, no endcard). "
      "Without this flag a missing Pillow is an error (exit 4)."
    ),
  )
  p_render.add_argument(
    "--no-overlays",
    action="store_true",
    help="Skip lower-thirds and the endcard even when Pillow is available (implies --allow-no-overlays).",
  )
  p_render.add_argument(
    "--mirror-dir",
    default=None,
    help=(
      "Optional folder that receives a copy of every deliverable "
      "(also read from SCENE_MACHINE_MIRROR_DIR)."
    ),
  )
  p_render.set_defaults(func=render_storyboard_cmd)
  return parser


def main(argv: list[str] | None = None) -> int:
  parser = build_parser()
  args = parser.parse_args(argv)
  debug = os.environ.get("SCENE_MACHINE_DEBUG") == "1"
  try:
    return args.func(args)
  except AssemblyError as err:
    if debug:
      traceback.print_exc()
      if err.details:
        print(err.details, file=sys.stderr)
    emit_stderr_json(err.to_payload())
    return err.exit_code
  except Exception as err:  # Unexpected bug: still one JSON line, never a bare traceback.
    if debug:
      traceback.print_exc()
    emit_stderr_json(
      {"error": "internal_error", "message": one_line(f"{type(err).__name__}: {err}")}
    )
    return 1


if __name__ == "__main__":
  sys.exit(main())
