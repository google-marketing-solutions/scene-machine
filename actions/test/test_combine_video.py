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

"""Tests for combine_video action."""

import concurrent.futures
import json
import pathlib
import re
import threading
import unittest
from unittest import mock

import pytest

from actions import combine_video
from common import Key
from util.gcs_wrapper import MAX_LOCAL_INPUT_BYTES


def test_concurrent_long_same_basename_inputs_use_bounded_local_paths(
    monkeypatch, tmp_path
):
  long_basename = f'{"x" * 1000}.mp4'
  arrangement = [
      {'file_type': 'video', 'file_path': f'../../clips/{long_basename}'},
      {'file_type': 'video', 'file_path': f'/absolute/{long_basename}'},
  ]
  input_groups = []
  groups_lock = threading.Lock()
  both_calls_ready = threading.Barrier(2)

  class RecordingFFMPEG:

    def __init__(self):
      self.paths = []

    def set_resolution(self, _resolution):
      return self

    def add_video(self, *, path, **_kwargs):
      self.paths.append(path)

    def combine(self, _output_name, *_args):
      with groups_lock:
        input_groups.append(list(self.paths))
      both_calls_ready.wait(timeout=5)
      output_path = pathlib.Path(self.paths[0]).parent / (
          f'{threading.get_ident()}-output.mp4'
      )
      output_path.write_bytes(b'combined')
      return str(output_path)

  class FakeGCS:

    def load_text(self, _path):
      return json.dumps(arrangement)

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      pathlib.Path(local_path).write_bytes(b'input')

    def store_file(self, source, name, _content_type):
      assert pathlib.Path(source).is_file()
      return f'combine_video/checksum/{name}'

  monkeypatch.chdir(tmp_path)
  monkeypatch.setattr(combine_video, 'FFMPEG', RecordingFFMPEG)

  def run_combine():
    return combine_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'arrangement.json'}],
        '1280:720',
        6,
        20,
    )

  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    results = list(executor.map(lambda _: run_combine(), range(2)))

  all_paths = [path for group in input_groups for path in group]
  assert len(all_paths) == 4
  assert len(set(all_paths)) == 4
  assert all(pathlib.Path(path).is_absolute() for path in all_paths)
  assert all(
      re.fullmatch(r'input-[0-9a-f]{64}\.mp4', pathlib.Path(path).name)
      for path in all_paths
  )
  assert all(len(pathlib.Path(path).name) <= 81 for path in all_paths)
  for group in input_groups:
    parents = {pathlib.Path(path).parent for path in group}
    assert len(parents) == 1
    assert not parents.pop().exists()
  assert results == [
      {'video': [{Key.FILE.value: 'combine_video/checksum/output.mp4'}]},
      {'video': [{Key.FILE.value: 'combine_video/checksum/output.mp4'}]},
  ]


def test_repeated_large_object_is_downloaded_once_and_reused(monkeypatch):
  object_path = 'clips/repeated.mp4'
  arrangement = [
      {'file_type': 'video', 'file_path': object_path},
      {'file_type': 'video', 'file_path': object_path},
  ]
  size_checks = []
  downloads = []
  download_generations = []
  ffmpeg_inputs = []

  class RecordingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def add_video(self, *, path, **_kwargs):
      ffmpeg_inputs.append(path)

    def combine(self, output_path, *_args):
      pathlib.Path(output_path).write_bytes(b'combined')
      return output_path

  class FakeGCS:

    def load_text(self, _path):
      return json.dumps(arrangement)

    def get_size_and_generation(self, gcs_path):
      size_checks.append(gcs_path)
      return MAX_LOCAL_INPUT_BYTES, 37

    def save_locally(self, gcs_path, local_path, *, if_generation_match):
      downloads.append(gcs_path)
      download_generations.append(if_generation_match)
      pathlib.Path(local_path).write_bytes(b'input')

    def store_file(self, _source, name, _content_type):
      return f'combine_video/checksum/{name}'

  monkeypatch.setattr(combine_video, 'FFMPEG', RecordingFFMPEG)

  combine_video.execute(
      FakeGCS(),
      {},
      [{Key.FILE.value: 'arrangement.json'}],
      '1280:720',
      6,
      20,
  )

  assert size_checks == [object_path]
  assert downloads == [object_path]
  assert download_generations == [37]
  assert len(ffmpeg_inputs) == 2
  assert ffmpeg_inputs[0] == ffmpeg_inputs[1]


def test_distinct_inputs_over_local_size_limit_fail_before_download(
    monkeypatch,
):
  arrangement = [
      {'file_type': 'video', 'file_path': 'clips/one.mp4'},
      {'file_type': 'video', 'file_path': 'clips/two.mp4'},
  ]
  downloads = []

  class UnexpectedFFMPEG:

    def __init__(self):
      raise AssertionError('FFmpeg must not start for oversized inputs')

  class FakeGCS:

    def load_text(self, _path):
      return json.dumps(arrangement)

    def get_size_and_generation(self, _gcs_path):
      return MAX_LOCAL_INPUT_BYTES // 2 + 1, 1

    def save_locally(self, gcs_path, _local_path, *, if_generation_match):
      del if_generation_match
      downloads.append(gcs_path)

  monkeypatch.setattr(combine_video, 'FFMPEG', UnexpectedFFMPEG)

  with pytest.raises(ValueError, match='8 GiB'):
    combine_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'arrangement.json'}],
        '1280:720',
        6,
        20,
    )

  assert downloads == []


def test_combine_uploads_from_file_before_workspace_cleanup(monkeypatch):
  uploaded_sources = []
  arrangement = [{'file_type': 'video', 'file_path': 'clips/input.mp4'}]

  class FileProducingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def add_video(self, **_kwargs):
      pass

    def combine(self, output_path, *_args):
      pathlib.Path(output_path).write_bytes(b'combined')
      return output_path

  class FakeGCS:

    def load_text(self, _path):
      return json.dumps(arrangement)

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
      return f'combine_video/checksum/{name}'

  monkeypatch.setattr(combine_video, 'FFMPEG', FileProducingFFMPEG)

  result = combine_video.execute(
      FakeGCS(),
      {},
      [{Key.FILE.value: 'arrangement.json'}],
      '1280:720',
      6,
      20,
  )

  assert result == {
      'video': [{Key.FILE.value: 'combine_video/checksum/output.mp4'}]
  }
  assert len(uploaded_sources) == 1
  assert not uploaded_sources[0].parent.exists()


def test_combine_cleans_workspace_when_ffmpeg_fails(monkeypatch):
  workspace_paths = []
  arrangement = [{'file_type': 'video', 'file_path': 'clips/input.mp4'}]

  class FailingFFMPEG:

    def set_resolution(self, _resolution):
      return self

    def add_video(self, *, path, **_kwargs):
      workspace_paths.append(pathlib.Path(path))

    def combine(self, _output_path, *_args):
      raise RuntimeError('ffmpeg failed')

  class FakeGCS:

    def load_text(self, _path):
      return json.dumps(arrangement)

    def get_size_and_generation(self, _gcs_path):
      return 1, 1

    def save_locally(self, _gcs_path, local_path, *, if_generation_match):
      assert if_generation_match == 1
      pathlib.Path(local_path).write_bytes(b'input')

  monkeypatch.setattr(combine_video, 'FFMPEG', FailingFFMPEG)

  with pytest.raises(RuntimeError, match='ffmpeg failed'):
    combine_video.execute(
        FakeGCS(),
        {},
        [{Key.FILE.value: 'arrangement.json'}],
        '1280:720',
        6,
        20,
    )

  assert len(workspace_paths) == 1
  assert not workspace_paths[0].parent.exists()


class TestCombineVideo(unittest.TestCase):
  """Tests for combine_video action."""

  def setUp(self):
    super().setUp()
    self.mock_gcs = mock.Mock()
    self.mock_gcs.get_size_and_generation.return_value = (1, 1)
    self.mock_workflow_params = {}
    self.mock_ffmpeg_cls = mock.patch('actions.combine_video.FFMPEG').start()
    self.mock_ffmpeg = self.mock_ffmpeg_cls.return_value

    # Setup default return values
    self.mock_ffmpeg.combine.return_value = '/tmp/output.mp4'

  def tearDown(self):
    super().tearDown()
    mock.patch.stopall()

  def test_execute_defaults_transition_overlap(self):
    """Tests that transition overlap defaults to 0.5 if missing."""
    # Setup arrangement with transition but NO overlap
    # (transition_overlap is MISSING)
    arrangement = [{
        'file_type': 'video',
        'file_path': 'video1.mp4',
        'transition': 'circlecrop',
    }]

    # Mock GCS load to return valid JSON
    self.mock_gcs.load_text.return_value = json.dumps(arrangement)

    combine_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        [{Key.FILE.value: 'arrangement.json'}],
        '1280:720',
        6,
        20,
    )

    # Verify add_video called with overlap=0.5
    self.mock_ffmpeg.add_video.assert_called_with(
        path=mock.ANY,
        skip_time=0,
        duration=-1,
        transition='circlecrop',
        transition_overlap=0.5,
    )

  def test_execute_preserves_explicit_zero_transition_overlap(self):
    """An explicit 0 overlap means a hard cut and must not become 0.5."""
    arrangement = [{
        'file_type': 'video',
        'file_path': 'video1.mp4',
        'transition': 'circlecrop',
        'transition_overlap': 0,
    }]
    self.mock_gcs.load_text.return_value = json.dumps(arrangement)

    combine_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        [{Key.FILE.value: 'arrangement.json'}],
        '1280:720',
        6,
        20,
    )

    self.mock_ffmpeg.add_video.assert_called_with(
        path=mock.ANY,
        skip_time=0,
        duration=-1,
        transition='circlecrop',
        transition_overlap=0,
    )


if __name__ == '__main__':
  unittest.main()
