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
import threading

import pytest

from actions import convert_video
from common import Key


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

    def save_locally(self, _gcs_path, local_path):
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
        [{Key.FILE.value: '..'}],
        '1280:720',
        'mp4',
    )

  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    results = list(executor.map(lambda _: run_conversion(), range(2)))

  assert len(set(ffmpeg_inputs)) == 2
  assert all(pathlib.Path(path).name == '0000_..' for path in ffmpeg_inputs)
  assert all(not pathlib.Path(path).parent.exists() for path in ffmpeg_inputs)
  assert results == [
      {'video': [{Key.FILE.value: 'convert_video/checksum/output.mp4'}]},
      {'video': [{Key.FILE.value: 'convert_video/checksum/output.mp4'}]},
  ]


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

    def save_locally(self, _gcs_path, local_path):
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

    def save_locally(self, _gcs_path, local_path):
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
