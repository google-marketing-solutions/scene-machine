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

"""Tests for convert_video action."""

import concurrent.futures
import pathlib
import re
import threading

import pytest

from actions import convert_video
from common import Key
from util.gcs_wrapper import MAX_LOCAL_INPUT_BYTES


def test_concurrent_same_basename_conversions_use_distinct_local_paths(
    monkeypatch,
):
  ffmpeg_inputs = []
  inputs_lock = threading.Lock()
  both_calls_ready = threading.Barrier(2)

  class RecordingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def convert_video(self, input_path, _extension):
      with inputs_lock:
        ffmpeg_inputs.append(input_path)
      both_calls_ready.wait(timeout=5)
      output_path = pathlib.Path(input_path).parent / (
          f'{threading.get_ident()}-output.mp4'
      )
      output_path.write_bytes(b'converted')
      return str(output_path)

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      path = pathlib.Path(local_path)
      assert path.resolve().parent == path.parent.resolve()
      path.write_bytes(b'input')

    def store_file(self, source, name, _content_type):
      assert pathlib.Path(source).is_file()
      return f'convert_video/checksum/{name}'

  monkeypatch.setattr(convert_video, 'FFMPEG', RecordingFFMPEG)

  def run_conversion():
    return convert_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: f'../../clips/{"x" * 1000}.mp4'}],
        '1280:720',
        'mp4',
    )

  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    results = list(executor.map(lambda _: run_conversion(), range(2)))

  assert len(set(ffmpeg_inputs)) == 2
  assert all(
      re.fullmatch(r'input-[0-9a-f]{64}\.mp4', pathlib.Path(path).name)
      for path in ffmpeg_inputs
  )
  assert all(len(pathlib.Path(path).name) <= 81 for path in ffmpeg_inputs)
  assert all(not pathlib.Path(path).parent.exists() for path in ffmpeg_inputs)
  assert results == [
      {'video': [{Key.FILE.value: 'convert_video/checksum/output.mp4'}]},
      {'video': [{Key.FILE.value: 'convert_video/checksum/output.mp4'}]},
  ]


def test_conversion_over_local_size_limit_fails_before_download(monkeypatch):
  downloads = []

  class UnexpectedFFMPEG:

    def __init__(self):
      raise AssertionError('FFmpeg must not start for oversized input')

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return MAX_LOCAL_INPUT_BYTES + 1, 1

    def save_locally(self, gcs_path, _local_path, *, if_generation_match):
      del if_generation_match
      downloads.append(gcs_path)

  monkeypatch.setattr(convert_video, 'FFMPEG', UnexpectedFFMPEG)

  with pytest.raises(ValueError, match='8 GiB'):
    convert_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'uploads/oversize.mp4'}],
        '1280:720',
        'mp4',
    )

  assert downloads == []


def test_generation_change_stops_before_ffmpeg(monkeypatch):

  class UnexpectedFFMPEG:

    def __init__(self):
      raise AssertionError('FFmpeg must not start after a generation change')

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return 1, 29

    def save_locally(self, _gcs_path, _local_path, *, if_generation_match):
      assert if_generation_match == 29
      raise RuntimeError('object generation changed')

  monkeypatch.setattr(convert_video, 'FFMPEG', UnexpectedFFMPEG)

  with pytest.raises(RuntimeError, match='generation changed'):
    convert_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'uploads/replaced.mp4'}],
        '1280:720',
        'mp4',
    )


def test_long_extension_is_not_copied_to_local_filename(monkeypatch):
  ffmpeg_inputs = []

  class RecordingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def convert_video(self, input_path, _extension):
      ffmpeg_inputs.append(input_path)
      output_path = pathlib.Path(input_path).parent / 'converted.mp4'
      output_path.write_bytes(b'converted')
      return str(output_path)

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      pathlib.Path(local_path).write_bytes(b'input')

    def store_file(self, _source, name, _content_type):
      return f'convert_video/checksum/{name}'

  monkeypatch.setattr(convert_video, 'FFMPEG', RecordingFFMPEG)

  convert_video.execute(
      FakeGCS(),
      {},
      [{Key.FILE.value: f'uploads/clip.{"x" * 1000}'}],
      '1280:720',
      'mp4',
  )

  assert len(ffmpeg_inputs) == 1
  assert re.fullmatch(
      r'input-[0-9a-f]{64}', pathlib.Path(ffmpeg_inputs[0]).name
  )


def test_conversion_uploads_from_file_before_workspace_cleanup(monkeypatch):
  uploaded_sources = []

  class FileProducingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def convert_video(self, input_path, _extension):
      output_path = pathlib.Path(f'{input_path}_converted.mp4')
      output_path.write_bytes(b'converted')
      return str(output_path)

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      pathlib.Path(local_path).write_bytes(b'input')

    def store_file(self, source, name, content_type):
      source_path = pathlib.Path(source)
      assert source_path.is_file()
      assert name == 'output.mp4'
      assert content_type == 'video/mp4'
      uploaded_sources.append(source_path)
      return f'convert_video/checksum/{name}'

  monkeypatch.setattr(convert_video, 'FFMPEG', FileProducingFFMPEG)

  result = convert_video.execute(
      FakeGCS(),
      {},
      [{Key.FILE.value: 'uploads/input.mp4'}],
      '1280:720',
      'mp4',
  )

  assert result == {
      'video': [{Key.FILE.value: 'convert_video/checksum/output.mp4'}]
  }
  assert len(uploaded_sources) == 1
  assert not uploaded_sources[0].parent.exists()


def test_conversion_cleans_workspace_when_ffmpeg_fails(monkeypatch):
  workspace_paths = []

  class FailingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def convert_video(self, input_path, _extension):
      workspace_paths.append(pathlib.Path(input_path))
      raise RuntimeError('ffmpeg failed')

  class FakeGCS:

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      pathlib.Path(local_path).write_bytes(b'input')

  monkeypatch.setattr(convert_video, 'FFMPEG', FailingFFMPEG)

  with pytest.raises(RuntimeError, match='ffmpeg failed'):
    convert_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'uploads/input.mp4'}],
        '1280:720',
        'mp4',
    )

  assert len(workspace_paths) == 1
  assert not workspace_paths[0].parent.exists()
