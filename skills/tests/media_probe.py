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
"""Measurement helpers for the render tests and benchmarks (ffprobe/ffmpeg only).

All functions shell out to ffprobe/ffmpeg and never touch the network. Values
are returned as plain Python types so that tests can apply tolerances.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from pathlib import Path
from typing import Any

PROBE_ENTRIES = (
  "format=duration:stream=index,codec_type,codec_name,profile,width,height,"
  "r_frame_rate,avg_frame_rate,pix_fmt,sample_rate,channels,duration,nb_frames"
)


def _env() -> dict[str, str]:
  env = dict(os.environ)
  env["PYTHONDONTWRITEBYTECODE"] = "1"
  return env


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
  return subprocess.run(cmd, capture_output=True, text=True, check=False, env=_env())


def _to_float(value: Any) -> float | None:
  try:
    return float(value)
  except (TypeError, ValueError):
    return None


def _to_int(value: Any) -> int | None:
  try:
    return int(value)
  except (TypeError, ValueError):
    return None


def probe(path: Path | str) -> dict[str, Any]:
  """Returns container duration plus the first video and audio stream facts.

  Keys: ``duration`` (container), ``video`` (dict or None with ``codec_name``,
  ``profile``, ``width``, ``height``, ``r_frame_rate``, ``pix_fmt``,
  ``stream_duration``, ``nb_frames``) and ``audio`` (dict or None with
  ``codec_name``, ``sample_rate``, ``channels``, ``stream_duration``).
  """
  proc = _run(["ffprobe", "-v", "error", "-show_entries", PROBE_ENTRIES, "-of", "json", str(path)])
  if proc.returncode != 0:
    return {"error": proc.stderr.strip(), "duration": None, "video": None, "audio": None}
  data = json.loads(proc.stdout or "{}")
  streams = data.get("streams") or []
  video = next((s for s in streams if s.get("codec_type") == "video"), None)
  audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
  out: dict[str, Any] = {
    "duration": _to_float((data.get("format") or {}).get("duration")),
    "video": None,
    "audio": None,
  }
  if video:
    out["video"] = {
      "codec_name": video.get("codec_name"),
      "profile": video.get("profile"),
      "width": _to_int(video.get("width")),
      "height": _to_int(video.get("height")),
      "r_frame_rate": video.get("r_frame_rate"),
      "avg_frame_rate": video.get("avg_frame_rate"),
      "pix_fmt": video.get("pix_fmt"),
      "stream_duration": _to_float(video.get("duration")),
      "nb_frames": _to_int(video.get("nb_frames")),
    }
  if audio:
    out["audio"] = {
      "codec_name": audio.get("codec_name"),
      "sample_rate": _to_int(audio.get("sample_rate")),
      "channels": _to_int(audio.get("channels")),
      "stream_duration": _to_float(audio.get("duration")),
    }
  return out


def count_frames(path: Path | str) -> int | None:
  """Counts decoded video frames (slower than nb_frames but container-independent)."""
  proc = _run(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      str(path),
    ]
  )
  if proc.returncode != 0:
    return None
  return _to_int(proc.stdout.strip().split(",")[0])


def loudness(path: Path | str) -> dict[str, Any]:
  """Integrated loudness and true peak via ebur128, cross-checked with loudnorm."""
  proc = _run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i",
      str(path),
      "-map",
      "0:a:0",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]
  )
  txt = proc.stderr
  summary = txt[txt.rfind("Summary:") :] if "Summary:" in txt else ""
  m_i = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary)
  m_lra = re.search(r"LRA:\s+(-?[\d.]+) LU", summary)
  m_tp = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary)
  proc2 = _run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-i",
      str(path),
      "-map",
      "0:a:0",
      "-af",
      "loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json",
      "-f",
      "null",
      "-",
    ]
  )
  ln: dict[str, Any] = {}
  mj = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", proc2.stderr, re.S)
  if mj:
    ln = json.loads(mj.group(0))

  def _num(value: Any) -> float | None:
    if value in (None, "-inf", "inf"):
      return None
    return _to_float(value)

  return {
    "integrated_lufs": _num(m_i.group(1)) if m_i else None,
    "lra": _num(m_lra.group(1)) if m_lra else None,
    "true_peak_dbtp": _num(m_tp.group(1)) if m_tp else None,
    "loudnorm_input_i": _num(ln.get("input_i")),
    "loudnorm_input_tp": _num(ln.get("input_tp")),
  }


def region_luma(path: Path | str, t: float, crop: str) -> float | None:
  """Mean luma (YAVG) of one frame at time t after cropping to ``W:H:X:Y``."""
  proc = _run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-ss",
      f"{t:.3f}",
      "-i",
      str(path),
      "-frames:v",
      "1",
      "-vf",
      f"crop={crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f",
      "null",
      "-",
    ]
  )
  m = re.search(r"lavfi\.signalstats\.YAVG=([\d.]+)", proc.stdout)
  return float(m.group(1)) if m else None


def frame_luma(path: Path | str, t: float) -> float | None:
  """Whole-frame mean luma at time t (only meaningful on flat fixtures)."""
  pr = probe(path)
  if not pr.get("video"):
    return None
  w, h = pr["video"]["width"], pr["video"]["height"]
  return region_luma(path, t, f"{w}:{h}:0:0")


def lower_third_crop(width: int, height: int) -> str:
  """Region that contains the lower-third card for the given frame size."""
  if height > width:  # 9:16
    return f"{int(width * 0.86)}:{int(height * 0.10)}:{int(width * 0.06)}:{int(height * 0.80)}"
  if width == height:  # 1:1 crop of a 9:16 render keeps the horizontal layout
    return f"{int(width * 0.86)}:{int(height * 0.16)}:{int(width * 0.06)}:{int(height * 0.76)}"
  # The card is content-sized (about 210x84 px for a one-line headline + subtext at 1280x720);
  # a window fitted to the card keeps the luma delta large instead of diluting it.
  return "240:100:50:570"


def endcard_crop(width: int, height: int) -> str:
  """Centre region covered by the endcard panel."""
  if height > width:
    return f"{int(width * 0.6)}:{int(height * 0.3)}:{int(width * 0.2)}:{int(height * 0.35)}"
  if width == height:
    return f"{int(width * 0.6)}:{int(height * 0.3)}:{int(width * 0.2)}:{int(height * 0.35)}"
  return "600:300:340:210"


def frame_digest(path: Path | str, t: float) -> str | None:
  """MD5 of the decoded frame at time t (identical digests = cloned/frozen frames)."""
  proc = _run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-ss",
      f"{t:.3f}",
      "-i",
      str(path),
      "-frames:v",
      "1",
      "-f",
      "md5",
      "-",
    ]
  )
  m = re.search(r"MD5=([0-9a-f]+)", proc.stdout)
  return m.group(1) if m else None


def frame_luma_plane(path: Path | str, t: float) -> bytes:
  """Raw 8-bit luma plane of the frame at time t (empty on failure)."""
  env = _env()
  proc = subprocess.run(
    [
      "ffmpeg",
      "-hide_banner",
      "-nostats",
      "-ss",
      f"{t:.3f}",
      "-i",
      str(path),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    capture_output=True,
    check=False,
    env=env,
  )
  return proc.stdout if proc.returncode == 0 else b""


def frame_psnr(path: Path | str, t1: float, t2: float) -> float | None:
  """Luma PSNR (dB) between the frames at t1 and t2, computed in Python.

  inf means identical; >= 45 dB means a cloned frame after lossy re-encoding.
  (The ffmpeg psnr filter prints its summary only at uninit, which ffmpeg 9's
  threaded CLI drops non-deterministically with -frames:v 1.)
  """
  a = frame_luma_plane(path, t1)
  b = frame_luma_plane(path, t2)
  if not a or len(a) != len(b):
    return None
  diff_sq = sum((x - y) * (x - y) for x, y in zip(a, b))
  if diff_sq == 0:
    return float("inf")
  return 10.0 * math.log10(255.0 * 255.0 * len(a) / diff_sq)
