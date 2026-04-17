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

"""Tests for FFMPEG utility class."""

import unittest
from unittest import mock

from actions_lib.ffmpeg import FFMPEG


class TestFFMPEG(unittest.TestCase):
  """Tests for FFMPEG class."""

  def setUp(self):
    super().setUp()
    self.ffmpeg = FFMPEG()

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  @mock.patch('subprocess.run')
  def test_combine_with_transitions(self, mock_run, mock_get_props):
    """Tests that combine generates correct xfade commands."""
    # Setup mocks
    mock_get_props.return_value = {
        'duration': 5.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True
    }

    # Add two videos
    # Video 1: No transition (first one)
    self.ffmpeg.add_video(
        path='video1.mp4',
        skip_time=0,
        duration=5.0,
        transition=None,
        transition_overlap=0
    )

    # Video 2: 'circlecrop' transition, 1.0s overlap
    self.ffmpeg.add_video(
        path='video2.mp4',
        skip_time=0,
        duration=5.0,
        transition='circlecrop',
        transition_overlap=1.0
    )

    # Run combine
    self.ffmpeg.combine('output.mp4')

    # Verify command
    args, _ = mock_run.call_args
    command = args[0]

    # Check if xfade is present with correct parameters
    # Expected: xfade=transition=circlecrop:duration=1.0:offset=4.0
    # because video1 is 5.0s, overlap is 1.0s, so offset = 5.0 - 1.0 = 4.0

    full_command = ' '.join(command)
    print(f'Generated Command: {full_command}')

    self.assertIn('xfade', full_command)
    self.assertIn('transition=circlecrop', full_command)
    self.assertIn('duration=1.0', full_command)
    self.assertIn('offset=4.0', full_command)

if __name__ == '__main__':
  unittest.main()
