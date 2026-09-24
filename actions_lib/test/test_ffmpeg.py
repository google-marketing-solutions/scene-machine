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
from pathlib import Path
import subprocess
import tempfile
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


  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_add_video_duration_clamp_and_controls(self, mock_get_props):
    mock_get_props.return_value = {
        'duration': 10.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    # Case 1: skip_time=3, duration=-1 on a 10 s source yields 7.0 s (not 10.0)
    ffmpeg1 = FFMPEG()
    ffmpeg1.add_video(
        path='clip.mp4',
        skip_time=3.0,
        duration=-1.0,
        transition=None,
        transition_overlap=0,
    )
    self.assertEqual(ffmpeg1.inputs[0]['duration'], 7.0)

    # Case 2: skip_time=3, duration=10 also yields 7.0 s (second branch)
    ffmpeg2 = FFMPEG()
    ffmpeg2.add_video(
        path='clip.mp4',
        skip_time=3.0,
        duration=10.0,
        transition=None,
        transition_overlap=0,
    )
    self.assertEqual(ffmpeg2.inputs[0]['duration'], 7.0)

    # Control 1: skip_time=0, duration=-1 is unchanged (10.0 s)
    ffmpeg3 = FFMPEG()
    ffmpeg3.add_video(
        path='clip.mp4',
        skip_time=0.0,
        duration=-1.0,
        transition=None,
        transition_overlap=0,
    )
    self.assertEqual(ffmpeg3.inputs[0]['duration'], 10.0)

    # Control 2: skip_time=3, duration=4 (< available 7 s) is unchanged (4.0 s)
    ffmpeg4 = FFMPEG()
    ffmpeg4.add_video(
        path='clip.mp4',
        skip_time=3.0,
        duration=4.0,
        transition=None,
        transition_overlap=0,
    )
    self.assertEqual(ffmpeg4.inputs[0]['duration'], 4.0)

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_unknown_source_duration_uses_requested_duration(
      self, mock_get_props
  ):
    mock_get_props.return_value = {
        'duration': 0.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    ffmpeg = FFMPEG()
    ffmpeg.add_video(
        path='unknown-duration.mp4',
        skip_time=3.0,
        duration=4.0,
        transition=None,
        transition_overlap=0,
    )

    self.assertEqual(ffmpeg.inputs[0]['skip'], 3.0)
    self.assertEqual(ffmpeg.inputs[0]['duration'], 4.0)

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_unknown_source_duration_requires_explicit_duration(
      self, mock_get_props
  ):
    mock_get_props.return_value = {
        'duration': 0.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    ffmpeg = FFMPEG()
    with self.assertRaisesRegex(ValueError, 'Explicit positive duration'):
      ffmpeg.add_video(
          path='unknown-duration.mp4',
          skip_time=0.0,
          duration=-1.0,
          transition=None,
          transition_overlap=0,
      )
    self.assertEqual(ffmpeg.inputs, [])

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_negative_times_and_excessive_skip_raise(self, mock_get_props):
    mock_get_props.return_value = {
        'duration': 10.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }

    # Negative skip_time in add_video
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='clip.mp4',
          skip_time=-1.0,
          duration=5.0,
          transition=None,
          transition_overlap=0,
      )

    # Negative transition_overlap in add_video
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='clip.mp4',
          skip_time=0.0,
          duration=5.0,
          transition='fade',
          transition_overlap=-0.5,
      )

    # skip_time >= source duration in add_video
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='clip.mp4',
          skip_time=10.0,
          duration=-1.0,
          transition=None,
          transition_overlap=0,
      )
    with self.assertRaises(ValueError):
      self.ffmpeg.add_video(
          path='clip.mp4',
          skip_time=12.0,
          duration=5.0,
          transition=None,
          transition_overlap=0,
      )

    # Negative start_time and skip_time in add_audio
    with self.assertRaises(ValueError):
      self.ffmpeg.add_audio(
          path='audio.mp3', start_time=-1.0, skip_time=0.0, duration=5.0
      )
    with self.assertRaises(ValueError):
      self.ffmpeg.add_audio(
          path='audio.mp3', start_time=0.0, skip_time=-1.0, duration=5.0
      )

    # Negative start_time and duration in add_image
    with self.assertRaises(ValueError):
      self.ffmpeg.add_image(
          path='img.png',
          start_time=-0.5,
          duration=1.0,
          offset_x=0,
          offset_y=0,
          width=100,
          height=100,
      )
    with self.assertRaises(ValueError):
      self.ffmpeg.add_image(
          path='img.png',
          start_time=0.0,
          duration=-1.0,
          offset_x=0,
          offset_y=0,
          width=100,
          height=100,
      )

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  def test_target_fps_order_independent_determinism(self, mock_get_props):
    props = {
        'clip24.mp4': {
            'duration': 5.0,
            'dimensions': '160:90',
            'fps': 24.0,
            'has_audio': False,
        },
        'clip60.mp4': {
            'duration': 5.0,
            'dimensions': '160:90',
            'fps': 60.0,
            'has_audio': False,
        },
    }
    mock_get_props.side_effect = lambda path: dict(props[path])

    f1 = FFMPEG()
    f1.add_video(
        path='clip24.mp4',
        skip_time=0,
        duration=1.05,
        transition=None,
        transition_overlap=0,
    )
    f1.add_video(
        path='clip60.mp4',
        skip_time=0,
        duration=1.05,
        transition=None,
        transition_overlap=0,
    )

    f2 = FFMPEG()
    f2.add_video(
        path='clip60.mp4',
        skip_time=0,
        duration=1.05,
        transition=None,
        transition_overlap=0,
    )
    f2.add_video(
        path='clip24.mp4',
        skip_time=0,
        duration=1.05,
        transition=None,
        transition_overlap=0,
    )

    self.assertEqual(f1.target_fps, 60.0)
    self.assertEqual(f2.target_fps, 60.0)
    self.assertEqual(f1.inputs[0]['duration'], f2.inputs[1]['duration'])
    self.assertEqual(f1.inputs[1]['duration'], f2.inputs[0]['duration'])

  def test_real_ffmpeg_render_av_sync(self):
    with tempfile.TemporaryDirectory() as tmp_dir:
      clip1 = Path(tmp_dir) / 'clip1.mp4'
      clip2 = Path(tmp_dir) / 'clip2.mp4'
      for p, c, f in [(clip1, 'red', 440), (clip2, 'blue', 880)]:
        subprocess.run(
            [
                'ffmpeg',
                '-y',
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                f'color=c={c}:s=160x90:r=24',
                '-f',
                'lavfi',
                '-i',
                f'sine=frequency={f}:duration=3',
                '-t',
                '3',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-shortest',
                str(p),
            ],
            check=True,
        )

      # 1. Single clip with skip_time=1.0, duration=-1.0
      ffmpeg = FFMPEG().set_resolution('160:90')
      ffmpeg.add_video(
          path=str(clip1),
          skip_time=1.0,
          duration=-1.0,
          transition=None,
          transition_overlap=0,
      )
      out_single = Path(tmp_dir) / 'out_single.mp4'
      ffmpeg.combine(
          str(out_single), shortest_stream=False, encoding_speed=8, video_crf=28
      )

      probe_cmd = [
          'ffprobe',
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,duration:format=duration',
          '-of',
          'json',
          str(out_single),
      ]
      res = subprocess.run(
          probe_cmd, capture_output=True, text=True, check=True
      )
      probe_data = json.loads(res.stdout)

      v_dur, a_dur = None, None
      for s in probe_data.get('streams', []):
        if s.get('codec_type') == 'video':
          v_dur = float(s['duration'])
        elif s.get('codec_type') == 'audio':
          a_dur = float(s['duration'])

      self.assertIsNotNone(v_dur)
      self.assertIsNotNone(a_dur)
      self.assertAlmostEqual(v_dur, 2.0, places=2)
      self.assertAlmostEqual(a_dur, 2.0, places=2)
      self.assertAlmostEqual(abs(a_dur - v_dur), 0.0, places=2)

      # 2. Concat with crossfade transition and skip_time
      ffmpeg_xfade = FFMPEG().set_resolution('160:90')
      ffmpeg_xfade.add_video(
          path=str(clip1),
          skip_time=1.0,
          duration=-1.0,
          transition=None,
          transition_overlap=0,
      )
      ffmpeg_xfade.add_video(
          path=str(clip2),
          skip_time=1.0,
          duration=-1.0,
          transition='fade',
          transition_overlap=0.5,
      )
      out_xfade = Path(tmp_dir) / 'out_xfade.mp4'
      ffmpeg_xfade.combine(
          str(out_xfade), shortest_stream=False, encoding_speed=8, video_crf=28
      )

      probe_cmd[-1] = str(out_xfade)
      res = subprocess.run(
          probe_cmd, capture_output=True, text=True, check=True
      )
      probe_data = json.loads(res.stdout)

      v_dur, a_dur = None, None
      for s in probe_data.get('streams', []):
        if s.get('codec_type') == 'video':
          v_dur = float(s['duration'])
        elif s.get('codec_type') == 'audio':
          a_dur = float(s['duration'])

      self.assertIsNotNone(v_dur)
      self.assertIsNotNone(a_dur)
      self.assertAlmostEqual(v_dur, 3.5, places=2)
      self.assertAlmostEqual(a_dur, 3.5, places=2)
      self.assertAlmostEqual(abs(a_dur - v_dur), 0.0, places=2)

  def test_add_image_requires_explicit_positive_duration(self):
    for bad_duration in (0, 0.0, -1, -5.5):
      with self.assertRaisesRegex(
          ValueError, 'Image overlay requires an explicit positive duration'
      ):
        self.ffmpeg.add_image(
            path='img.png',
            start_time=0.0,
            duration=bad_duration,
            offset_x=0,
            offset_y=0,
            width=100,
            height=100,
        )

    ffmpeg = FFMPEG()
    ffmpeg.add_image(
        path='img.png',
        start_time=1.0,
        duration=4.0,
        offset_x=10,
        offset_y=10,
        width=100,
        height=100,
    )
    self.assertEqual(len(ffmpeg.inputs), 1)
    self.assertEqual(ffmpeg.inputs[0]['start'], 1.0)
    self.assertEqual(ffmpeg.inputs[0]['end'], 5.0)

  @mock.patch('actions_lib.ffmpeg.get_media_duration')
  def test_add_audio_permits_negative_duration_fallback(self, mock_dur):
    mock_dur.return_value = 15.25
    ffmpeg = FFMPEG()
    ffmpeg.add_audio('audio.mp3', start_time=0.0, skip_time=0.0, duration=-1)
    self.assertEqual(ffmpeg.inputs[0]['duration'], 15.25)
    mock_dur.assert_called_once_with('audio.mp3')

  @mock.patch('actions_lib.ffmpeg.get_video_properties')
  @mock.patch('actions_lib.ffmpeg.get_media_duration')
  def test_shipped_workflow_examples_accepted_by_ffmpeg(
      self, mock_dur, mock_props
  ):
    mock_props.return_value = {
        'duration': 30.0,
        'dimensions': '1280:720',
        'fps': 30.0,
        'has_audio': True,
    }
    mock_dur.return_value = 30.0

    repo_root = Path(__file__).resolve().parent.parent.parent
    examples_dir = repo_root / 'workflow_examples' / 'input'
    self.assertTrue(
        examples_dir.is_dir(),
        f'Workflow examples directory not found: {examples_dir}',
    )

    example_files = sorted(examples_dir.glob('*_arrangement.json'))
    self.assertGreaterEqual(
        len(example_files),
        2,
        f'Expected at least 2 shipped arrangement files in {examples_dir}',
    )

    for jf in example_files:
      with open(jf) as f:
        arrangement = json.load(f)

      ffmpeg = FFMPEG()
      for arr in arrangement:
        skip_time = arr.get('skip_time', 0)
        duration = arr.get('duration', -1)
        offset_x = arr.get('offset_x', 0)
        offset_y = arr.get('offset_y', 0)
        local_path = '/mock/' + arr['file_path']

        if arr['file_type'] == 'video':
          transition = arr.get('transition')
          transition_overlap = arr.get('transition_overlap')
          include_audio = arr.get('include_audio', True)
          if transition and transition_overlap is None:
            transition_overlap = 0.5
          ffmpeg.add_video(
              path=local_path,
              skip_time=skip_time,
              duration=duration,
              transition=transition,
              transition_overlap=transition_overlap,
              include_audio=include_audio,
          )
        elif arr['file_type'] == 'audio':
          ffmpeg.add_audio(
              local_path, arr['start_time'], skip_time, duration
          )
        elif arr['file_type'] == 'image':
          ffmpeg.add_image(
              path=local_path,
              start_time=arr['start_time'],
              duration=duration,
              offset_x=offset_x,
              offset_y=offset_y,
              width=arr['width'],
              height=arr.get('height', -1),
          )
        else:
          self.fail(f'Unexpected file_type in {jf}: {arr.get("file_type")}')

      self.assertEqual(
          len(ffmpeg.inputs),
          len(arrangement),
          f'All entries in {jf.name} should be accepted',
      )


if __name__ == '__main__':
  unittest.main()
