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
"""Builds the synthetic (FFmpeg lavfi) media fixtures used by tests and benchmarks.

No media binary is checked in: every file is generated into a temporary
directory at session start (see BENCHMARK_DESIGN section 2 for the list).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
SHOT_SIZES = ("1280x720", "1920x1080", "1080x1920", "640x360", "1024x1024")

MEDIA_FILES = (
  "shot_1.mp4",
  "shot_2.mp4",
  "shot_3.mp4",
  "shot_4.mp4",
  "shot_5.mp4",
  "short_2s.mp4",
  "short_1s.mp4",
  "long_8s.mp4",
  "clip_4s.mp4",
  "flat_gray.mp4",
  "vfr_30fps.mp4",
  "clip_1080p.mp4",
  "shot_with_audio.mp4",
  "voiceover.wav",
  "voiceover_noise.wav",
  "music.wav",
  "keyframe_800x600.png",
)


def _ffmpeg(args: list[str]) -> None:
  env = dict(os.environ)
  env["PYTHONDONTWRITEBYTECODE"] = "1"
  cmd = ["ffmpeg", "-v", "error", "-y", *args]
  proc = subprocess.run(cmd, capture_output=True, text=True, check=False, env=env)
  if proc.returncode != 0:
    raise RuntimeError(f"fixture build failed: {' '.join(cmd)}\n{proc.stderr}")


def _testsrc(out: Path, size: str, rate: int = 24, duration: float = 6.0) -> None:
  _ffmpeg(
    ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={duration}", *X264, str(out)]
  )


def build_media(media_dir: Path) -> Path:
  """Creates every fixture under media_dir (idempotent) and returns the directory."""
  media_dir = Path(media_dir)
  media_dir.mkdir(parents=True, exist_ok=True)
  for i, size in enumerate(SHOT_SIZES, start=1):
    _testsrc(media_dir / f"shot_{i}.mp4", size)
  _testsrc(media_dir / "short_2s.mp4", "1280x720", duration=2)
  _testsrc(media_dir / "short_1s.mp4", "1280x720", duration=1)
  _testsrc(media_dir / "long_8s.mp4", "1280x720", duration=8)
  _testsrc(media_dir / "clip_4s.mp4", "1280x720", duration=4)
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:size=1280x720:rate=24:duration=6",
      *X264,
      str(media_dir / "flat_gray.mp4"),
    ]
  )
  vfr = media_dir / "vfr_30fps.mp4"
  try:
    _ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=6.04",
        "-fps_mode",
        "vfr",
        *X264,
        str(vfr),
      ]
    )
  except RuntimeError:  # ffmpeg < 5.1 (ubuntu-22.04) only knows -vsync
    _ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=6.04",
        "-vsync",
        "vfr",
        *X264,
        str(vfr),
      ]
    )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=24:duration=6",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      *X264,
      "-c:a",
      "aac",
      "-shortest",
      str(media_dir / "clip_1080p.mp4"),
    ]
  )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=24:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=48000:duration=6",
      *X264,
      "-c:a",
      "aac",
      "-shortest",
      str(media_dir / "shot_with_audio.mp4"),
    ]
  )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=24000:duration=25",
      "-af",
      "tremolo=f=2:d=0.9,volume=-18dB",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      str(media_dir / "voiceover.wav"),
    ]
  )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:sample_rate=24000:duration=25:seed=7",
      "-af",
      "tremolo=f=3:d=1,volume=-20dB",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      str(media_dir / "voiceover_noise.wav"),
    ]
  )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=10",
      "-af",
      "volume=-12dB",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      str(media_dir / "music.wav"),
    ]
  )
  _ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=800x600:rate=1:duration=1",
      "-frames:v",
      "1",
      str(media_dir / "keyframe_800x600.png"),
    ]
  )
  missing = [name for name in MEDIA_FILES if not (media_dir / name).is_file()]
  if missing:
    raise RuntimeError(f"fixture build incomplete: {missing}")
  return media_dir


def png_bytes(size: str = "64x36", color: str = "blue") -> bytes:
  """A tiny PNG produced by ffmpeg (used as the fake image model output)."""
  proc = subprocess.run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      f"color=c={color}:s={size}:d=1",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "-",
    ],
    capture_output=True,
    check=True,
  )
  return proc.stdout


def jpeg_bytes(size: str = "64x36", color: str = "red") -> bytes:
  proc = subprocess.run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      f"color=c={color}:s={size}:d=1",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "mjpeg",
      "-",
    ],
    capture_output=True,
    check=True,
  )
  return proc.stdout


def mp4_bytes(duration: int = 6, size: str = "320x180") -> bytes:
  """A small silent H.264 clip of the requested length (fake Veo output)."""
  proc = subprocess.run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      f"testsrc2=size={size}:rate=24:duration={duration}",
      *X264,
      "-movflags",
      "+faststart+frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "-",
    ],
    capture_output=True,
    check=True,
  )
  return proc.stdout


def pcm_bytes(seconds: float = 2.0, sample_rate: int = 24000) -> bytes:
  """Raw 16-bit mono PCM (fake Gemini TTS output)."""
  proc = subprocess.run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      f"sine=frequency=300:sample_rate={sample_rate}:duration={seconds}",
      "-af",
      "volume=-18dB",
      "-ac",
      "1",
      "-f",
      "s16le",
      "-c:a",
      "pcm_s16le",
      "-",
    ],
    capture_output=True,
    check=True,
  )
  return proc.stdout


def wav_bytes(seconds: float = 2.0, sample_rate: int = 48000) -> bytes:
  """A short stereo RIFF WAV (fake Lyria output)."""
  proc = subprocess.run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      f"sine=frequency=220:sample_rate={sample_rate}:duration={seconds}",
      "-af",
      "volume=-12dB",
      "-ac",
      "2",
      "-f",
      "wav",
      "-c:a",
      "pcm_s16le",
      "-",
    ],
    capture_output=True,
    check=True,
  )
  return proc.stdout
