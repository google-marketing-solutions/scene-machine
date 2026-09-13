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

"""Actual-FFmpeg proof for per-candidate audio intent in rendered output."""

import re
import subprocess
from pathlib import Path

import pytest

from actions_lib.ffmpeg import FFMPEG
from actions_lib.ffmpeg import get_video_properties


def _run(command):
  return subprocess.run(command, capture_output=True, text=True, check=True)


@pytest.fixture
def source_videos(tmp_path: Path) -> tuple[Path, Path]:
  """Create two local video candidates with distinguishable source tones."""
  sources = []
  for color, frequency, name in (
      ('red', 440, 'candidate-a.mp4'),
      ('blue', 880, 'candidate-b.mp4'),
  ):
    path = tmp_path / name
    _run([
        'ffmpeg',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        f'color=c={color}:s=160x90:r=24',
        '-f',
        'lavfi',
        '-i',
        f'sine=frequency={frequency}:duration=2',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        str(path),
    ])
    sources.append(path)
  return sources[0], sources[1]


def _render(
    first: Path,
    first_audio: bool,
    second: Path | None = None,
    second_audio: bool = True,
    transition: str | None = None,
    overlap: float = 0,
) -> Path:
  output = first.parent / (
      f'render-{first_audio}-{second_audio}-{transition or "cut"}.mp4'
  )
  ffmpeg = FFMPEG().set_resolution('160:90')
  ffmpeg.add_video(
      path=str(first),
      skip_time=0,
      duration=2,
      transition=None,
      transition_overlap=0,
      include_audio=first_audio,
  )
  if second is not None:
    ffmpeg.add_video(
        path=str(second),
        skip_time=0,
        duration=2,
        transition=transition,
        transition_overlap=overlap,
        include_audio=second_audio,
    )
  ffmpeg.combine(str(output), False, 8, 20)
  return output


def _mean_volume(path: Path, start: float, duration: float) -> float:
  result = _run([
      'ffmpeg',
      '-v',
      'info',
      '-ss',
      str(start),
      '-i',
      str(path),
      '-t',
      str(duration),
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
  ])
  match = re.search(r'mean_volume:\s+(-?\d+(?:\.\d+)?) dB', result.stderr)
  assert match, result.stderr
  return float(match.group(1))


def _assert_audio_level(level: float, expected_audio: bool) -> None:
  if expected_audio:
    assert level > -40
  else:
    assert level < -80


def test_single_candidate_flag_controls_rendered_audio_level(source_videos):
  first, _ = source_videos

  silent = _render(first, False)
  audible = _render(first, True)

  # combine always maps a final audio stream; inspect level as well as stream
  # presence so this proves actual audible output rather than native-player
  # permission or the existence of a silent AAC track.
  assert get_video_properties(str(silent))['has_audio'] is True
  assert get_video_properties(str(audible))['has_audio'] is True
  assert _mean_volume(silent, 0.25, 1) < -80
  assert _mean_volume(audible, 0.25, 1) > -40


@pytest.mark.parametrize(
    ('first_audio', 'second_audio'),
    ((False, True), (True, False), (False, False), (True, True)),
)
def test_mixed_candidates_keep_each_audio_intent_on_hard_cut(
    source_videos, first_audio, second_audio
):
  first, second = source_videos
  output = _render(first, first_audio, second, second_audio)

  first_level = _mean_volume(output, 0.25, 1)
  second_level = _mean_volume(output, 2.25, 1)
  _assert_audio_level(first_level, first_audio)
  _assert_audio_level(second_level, second_audio)


@pytest.mark.parametrize(
    ('first_audio', 'second_audio'), ((False, True), (True, False))
)
def test_mixed_candidates_keep_each_audio_intent_through_transition(
    source_videos, first_audio, second_audio
):
  first, second = source_videos
  output = _render(
      first,
      first_audio,
      second,
      second_audio,
      transition='fade',
      overlap=0.5,
  )

  # Sample away from the 0.5 second crossfade window (1.5-2.0 seconds).
  first_level = _mean_volume(output, 0.25, 1)
  second_level = _mean_volume(output, 2.25, 1)
  _assert_audio_level(first_level, first_audio)
  _assert_audio_level(second_level, second_audio)
