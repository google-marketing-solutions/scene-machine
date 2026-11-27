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
"""Synthetic storyboard.json builders for the assembler and generator tests.

``render_variants(media_dir)`` returns the named assembler cases (clips point
at the lavfi fixtures); ``generator_storyboard(...)`` builds a valid v2.1
generator input (no clip files, 50-65-word voiceover, ASCII music prompt).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STAGES = ["Attract", "Brand", "Connect", "Proof", "Direct", "Direct"]
PALETTE = {
  "backgroundHex": "#0F172A",
  "primaryAccentHex": "#38BDF8",
  "secondaryAccentHex": "#F59E0B",
  "textLightHex": "#F8FAFC",
}
MOTION = (
  "[VISUAL ANCHOR LOCK] Frosted cloudberries on dark slate remain sharp and fixed. "
  "[CAMERA TRAJECTORY] Slow Dolly Push-In toward the central cluster. "
  "[LIGHTING & MICRO-PHYSICS] Warm dawn light sweeps gently across the frost."
)
VISUAL = (
  "Cinematic macro photography of frosted Arctic cloudberries on dark slate (#0F172A) "
  "with ice-blue (#38BDF8) rim light, shallow depth of field. Clean commercial cinema "
  "frame with no overlaid UI text, buttons, subtitles, or watermarks."
)
# 58 words, ASCII only.
VOICEOVER_58 = (
  "Cold mornings leave skin feeling tired and tight. Meet NordicGlow Radiant Renewal "
  "Serum, made with wild Arctic cloudberries and pure hyaluronic acid. One drop delivers "
  "deep, lasting hydration and restores a luminous, balanced glow in twenty-four hours. "
  "Dermatologically tested, fragrance free, and gentle enough for every morning. Reveal "
  "your natural radiance today with NordicGlow."
)
MUSIC_PROMPT = (
  "Modern Scandinavian electronic ambient pop commercial soundtrack, warm synth "
  "arpeggios, crisp minimal percussion, uplifting build, 112 BPM, instrumental."
)


def word_count(text: str) -> int:
  return len([w for w in text.split() if w.strip()])


def words(n: int) -> str:
  """Returns an ASCII sentence of exactly n words."""
  base = VOICEOVER_58.split()
  out: list[str] = []
  while len(out) < n:
    out.extend(base)
  return " ".join(out[:n])


def shot(i: int, clip: Path | str | None, overlay: bool = True, dur: float = 6.0) -> dict[str, Any]:
  s: dict[str, Any] = {
    "shotIndex": i,
    "abcdStage": STAGES[min(i, len(STAGES)) - 1],
    "durationSeconds": dur,
    "visualPrompt": f"Synthetic test frame {i}. {VISUAL}",
    "motionPrompt": MOTION,
    "voiceoverSegment": f"Segment {i}.",
    "typoOverlay": {"headline": f"Headline {i}", "subtext": f"Subtext line {i}"} if overlay else {},
  }
  if clip is not None:
    s["clipFile"] = str(clip)
  return s


def base(
  media: Path,
  n: int = 5,
  aspect: str = "16:9",
  square: bool = False,
  clips: list[Path | str] | None = None,
  vo: bool = True,
  music: bool = True,
  dur: float = 6.0,
  overlays: bool = True,
  vo_file: str = "voiceover.wav",
) -> dict[str, Any]:
  media = Path(media)
  clips = clips or [media / f"shot_{(i - 1) % 5 + 1}.mp4" for i in range(1, n + 1)]
  sb: dict[str, Any] = {
    "brandName": "NordicGlow",
    "campaignTitle": "Synthetic Benchmark Spot",
    "language": "en-US",
    "aspectRatio": aspect,
    "exportSquareCrop": square,
    "totalDurationSeconds": dur * n,
    "brandPalette": dict(PALETTE),
    "endcardSpec": {
      "enabled": True,
      "durationSec": 3.0,
      "headline": "Synthetic Endcard Headline",
      "subheadline": "Benchmark subheadline",
      "ctaText": "Learn More",
      "ctaUrl": "nordicglow.example",
    },
    "audioSpec": {
      "voiceoverScript": VOICEOVER_58,
      "musicPrompt": MUSIC_PROMPT,
      "musicDuckVolume": 0.28,
      "targetLufs": -14.0,
      "fadeOutSeconds": 1.5,
    },
    "shots": [shot(i, clips[i - 1], overlay=overlays, dur=dur) for i in range(1, n + 1)],
  }
  if vo:
    sb["audioSpec"]["voiceoverFile"] = str(media / vo_file)
  if music:
    sb["audioSpec"]["musicFile"] = str(media / "music.wav")
  return sb


def render_variants(media: Path) -> dict[str, Any]:
  """All assembler cases keyed by name; the value is the storyboard (or raw text)."""
  media = Path(media)
  v: dict[str, Any] = {}
  v["sb_5x6_16x9"] = base(media, 5)
  v["sb_5x6_9x16_square"] = base(media, 5, aspect="9:16", square=True)
  v["sb_3x6_16x9"] = base(media, 3)
  v["sb_1x1"] = base(media, 5, aspect="1:1")
  v["sb_bad_aspect"] = base(media, 5, aspect="4:3")
  v["sb_one_shot"] = base(media, 1)
  v["sb_seven_shots"] = base(media, 7)
  v["sb_zero_duration"] = base(media, 3, dur=0)
  bad_hex = base(media, 3)
  bad_hex["brandPalette"]["primaryAccentHex"] = "notahex"
  v["sb_bad_hex"] = bad_hex
  null_head = base(media, 3)
  null_head["shots"][1]["typoOverlay"] = {"headline": None, "subtext": None}
  v["sb_null_headline"] = null_head

  short = base(media, 3)
  short["shots"][1]["clipFile"] = str(media / "short_2s.mp4")
  v["sb_short_2s"] = short
  short_no = base(media, 3, overlays=False)
  short_no["shots"][1]["clipFile"] = str(media / "short_2s.mp4")
  v["sb_short_2s_no_overlay"] = short_no
  short1 = base(media, 3)
  short1["shots"][1]["clipFile"] = str(media / "short_1s.mp4")
  v["sb_short_1s"] = short1
  short1_no = base(media, 3, overlays=False)
  short1_no["shots"][1]["clipFile"] = str(media / "short_1s.mp4")
  v["sb_short_1s_no_overlay"] = short1_no

  long8 = base(media, 3)
  long8["shots"][1]["clipFile"] = str(media / "long_8s.mp4")
  v["sb_long_8s"] = long8
  v["sb_4s_shots"] = base(media, 5, clips=[media / "clip_4s.mp4"] * 5, dur=4)
  vfr = base(media, 3)
  vfr["shots"][0]["clipFile"] = str(media / "vfr_30fps.mp4")
  v["sb_vfr_30fps"] = vfr
  p1080 = base(media, 3)
  p1080["shots"][0]["clipFile"] = str(media / "clip_1080p.mp4")
  v["sb_1080p_silent_audio"] = p1080
  v["sb_flat_gray"] = base(media, 3, clips=[media / "flat_gray.mp4"] * 3)

  missing = base(media, 5)
  missing["shots"][3]["clipFile"] = str(media / "does_not_exist.mp4")
  v["sb_missing_clip"] = missing
  v["sb_embedded_audio"] = base(
    media, 3, clips=[media / "shot_with_audio.mp4"] * 3, vo=False, music=False
  )
  v["sb_no_audio"] = base(media, 3, vo=False, music=False)
  v["sb_vo_only"] = base(media, 3, music=False)
  v["sb_music_only"] = base(media, 3, vo=False)
  v["sb_noise_vo"] = base(media, 3, vo_file="voiceover_noise.wav")
  uri = base(media, 5)
  for s in uri["shots"]:
    s["clipFile"] = "file://" + s["clipFile"] + "?encoding=base64"
  v["sb_uri_clips"] = uri
  v["malformed"] = "{ this is not json"
  return v


def write_variants(media: Path, out_dir: Path) -> dict[str, Path]:
  out_dir = Path(out_dir)
  out_dir.mkdir(parents=True, exist_ok=True)
  paths: dict[str, Path] = {}
  for name, sb in render_variants(media).items():
    p = out_dir / f"{name}.json"
    p.write_text(sb if isinstance(sb, str) else json.dumps(sb, indent=2) + "\n", encoding="utf-8")
    paths[name] = p
  return paths


def generator_storyboard(
  n: int = 5,
  aspect: str = "16:9",
  durations: list[int] | None = None,
  voiceover_words: int = 58,
  music_prompt: str = MUSIC_PROMPT,
  language: str = "en-US",
  square: bool = False,
) -> dict[str, Any]:
  """A valid generator input: no clips, 50-65-word voiceover, ASCII music prompt."""
  durations = durations or [6] * n
  sb: dict[str, Any] = {
    "brandName": "NordicGlow",
    "campaignTitle": "Radiant Renewal Launch",
    "language": language,
    "aspectRatio": aspect,
    "exportSquareCrop": square,
    "totalDurationSeconds": sum(durations),
    "brandPalette": dict(PALETTE),
    "endcardSpec": {
      "enabled": True,
      "durationSec": 3.0,
      "headline": "Reveal Your Natural Radiance",
      "subheadline": "NordicGlow Radiant Renewal Serum",
      "ctaText": "Discover More",
      "ctaUrl": "nordicglow.example",
    },
    "audioSpec": {
      "voiceoverScript": words(voiceover_words),
      "musicPrompt": music_prompt,
      "musicDuckVolume": 0.28,
      "targetLufs": -14.0,
      "fadeOutSeconds": 1.5,
    },
    "shots": [
      {
        "shotIndex": i,
        "abcdStage": STAGES[min(i, len(STAGES)) - 1],
        "durationSeconds": durations[i - 1],
        "visualPrompt": f"Scene {i}. {VISUAL}",
        "motionPrompt": f"mp{i} {MOTION}",
        "voiceoverSegment": f"Segment {i}.",
        "typoOverlay": {"headline": f"Headline {i}", "subtext": f"Subtext {i}"},
      }
      for i in range(1, n + 1)
    ],
  }
  return sb


def write_json(path: Path, data: Any) -> Path:
  path = Path(path)
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
  return path
