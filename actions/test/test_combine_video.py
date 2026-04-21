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

import json
import unittest
from unittest import mock

from actions import combine_video
from common import Key


class TestCombineVideo(unittest.TestCase):
  """Tests for combine_video action."""

  def setUp(self):
    super().setUp()
    self.mock_gcs = mock.Mock()
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

    # Mock open and os.remove since execute tries to files
    with mock.patch(
        'builtins.open', mock.mock_open(read_data=b'video_data')
    ), mock.patch('os.remove'):
      # Execute
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


if __name__ == '__main__':
  unittest.main()
