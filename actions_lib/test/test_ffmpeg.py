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

import json
import unittest
from unittest import mock

from actions_lib.ffmpeg import FFMPEG
from actions_lib.ffmpeg import get_video_properties


class TestFFMPEG(unittest.TestCase):
  """Tests for FFMPEG class."""

  def setUp(self):
    super().setUp()
    self.ffmpeg = FFMPEG()

  @mock.patch('actions_lib.ffmpeg.subprocess.run')
  def test_reused_local_path_is_probed_again(self, mock_run):
    mock_run.side_effect = [
        mock.Mock(
            stdout=json.dumps({
                'format': {'duration': '1.0'},
                'streams': [{
                    'codec_type': 'video',
                    'width': 640,
                    'height': 360,
                    'r_frame_rate': '24/1',
                }],
            })
        ),
        mock.Mock(
            stdout=json.dumps({
                'format': {'duration': '2.0'},
                'streams': [{
                    'codec_type': 'video',
                    'width': 1280,
                    'height': 720,
                    'r_frame_rate': '30/1',
                }],
            })
        ),
    ]

    first = get_video_properties('/tmp/reused-request-path.mp4')
    second = get_video_properties('/tmp/reused-request-path.mp4')

    self.assertEqual(first['duration'], 1.0)
    self.assertEqual(second['duration'], 2.0)
    self.assertEqual(second['dimensions'], '1280:720')
    self.assertEqual(mock_run.call_count, 2)

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  @mock.patch('subprocess.run')
  def test_combine_with_transitions(self, mock_run, mock_get_props):
    """Tests that combine generates correct xfade commands."""
    # Setup mocks
    mock_get_props.return_value = {
        'duration': 5.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    # Add two videos
    # Video 1: No transition (first one)
    self.ffmpeg.add_video(
        path='video1.mp4',
        skip_time=0,
        duration=5.0,
        transition=None,
        transition_overlap=0,
    )

    # Video 2: 'circlecrop' transition, 1.0s overlap
    self.ffmpeg.add_video(
        path='video2.mp4',
        skip_time=0,
        duration=5.0,
        transition='circlecrop',
        transition_overlap=1.0,
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

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  @mock.patch('subprocess.run')
  def test_add_video_can_exclude_source_audio(self, mock_run, mock_get_props):
    mock_get_props.return_value = {
        'duration': 5.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    self.ffmpeg.add_video(
        path='video.mp4',
        skip_time=0,
        duration=5.0,
        transition=None,
        transition_overlap=0,
        include_audio=False,
    )
    self.ffmpeg.combine('output.mp4')

    command = ' '.join(mock_run.call_args.args[0])
    self.assertIn('anullsrc=', command)
    self.assertNotIn('[0:a:0]', command)

  def test_set_resolution_rejects_filter_injection(self):
    for bad in ('1280:720,movie=/etc/passwd', '720p', '', 1280):
      with self.assertRaises(ValueError):
        self.ffmpeg.set_resolution(bad)
    self.ffmpeg.set_resolution('1280:720')
    self.assertEqual(self.ffmpeg.resolution, '1280:720')
    self.ffmpeg.set_resolution('720:1280')
    self.assertEqual(self.ffmpeg.resolution, '720:1280')

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_add_video_rejects_invalid_transition_and_non_numeric_times(
      self, mock_get_props
  ):
    mock_get_props.return_value = {
        'duration': 5.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }
    # transition injection
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='video.mp4',
          skip_time=0,
          duration=5.0,
          transition='fade:duration=1,movie=x',
          transition_overlap=1.0,
      )
    # non-numeric skip_time
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='video.mp4',
          skip_time='0,null',
          duration=5.0,
          transition=None,
          transition_overlap=0,
      )
    # non-numeric duration
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='video.mp4',
          skip_time=0,
          duration='5;null',
          transition=None,
          transition_overlap=0,
      )
    # non-numeric transition_overlap
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='video.mp4',
          skip_time=0,
          duration=5.0,
          transition=None,
          transition_overlap='1:offset=0',
      )

  def test_add_audio_rejects_non_numeric_parameters(self):
    for bad_param in ('start_time', 'skip_time', 'duration'):
      for bad_val in ('bad', True, False):
        kwargs = {'path': 'a.mp3', 'start_time': 0.0, 'skip_time': 0.0, 'duration': 1.0}
        kwargs[bad_param] = bad_val
        with self.assertRaises(ValueError):
          self.ffmpeg.add_audio(**kwargs)

  def test_add_image_rejects_string_concatenation_and_overlay_injection(self):
    # string concatenation bypass on start_time + duration
    with self.assertRaises(ValueError):
      self.ffmpeg.add_image(
          path='img.png',
          start_time="0)''[out];movie=x",
          duration='1',
          offset_x=0,
          offset_y=0,
          width=100,
          height=100,
      )
    # boolean / string dimension parameters
    for bad_param in ('width', 'height', 'offset_x', 'offset_y'):
      for bad_val in ('100', True, False):
        kwargs = {
            'path': 'img.png',
            'start_time': 0.0,
            'duration': 1.0,
            'offset_x': 0,
            'offset_y': 0,
            'width': 100,
            'height': 100,
        }
        kwargs[bad_param] = bad_val
        with self.assertRaises(ValueError):
          self.ffmpeg.add_image(**kwargs)

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_convert_video_rejects_invalid_resolution_or_extension(
      self, mock_get_props
  ):
    mock_get_props.return_value = {
        'duration': 5.0,
        'dimensions': '640:360',
        'fps': 30.0,
        'has_audio': True,
    }
    self.ffmpeg.resolution = '1280:720;null'
    with self.assertRaises(ValueError):
      self.ffmpeg.convert_video('input.mp4', 'mp4')

    self.ffmpeg.resolution = '1280:720'
    for bad_ext in ('mp4;rm', '../mp4', 'mp4/avi', ''):
      with self.assertRaises(ValueError):
        self.ffmpeg.convert_video('input.mp4', bad_ext)


if __name__ == '__main__':
  unittest.main()
