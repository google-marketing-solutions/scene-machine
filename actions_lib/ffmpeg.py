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

"""Encapsulates use of FFmpeg."""

import json
import shlex
import subprocess
from typing import Any
from typing import Dict

from common import logger

FFMPEG_PATH = 'ffmpeg'
FFPROBE_PATH = 'ffprobe'

properties_cache = {}


def get_video_properties(file_path: str) -> Dict[str, Any]:
  """Gets video properties and checks for an audio stream in an ffprobe call.

  Args:
    file_path: Video whose properties are to be obtained.

  Returns:
    dictionary with video properties
  """
  if file_path in properties_cache:
    return properties_cache[file_path]

  command = [
      FFPROBE_PATH,
      '-v',
      'error',
      '-show_entries',
      'stream=width,height,r_frame_rate,codec_type:format=duration',
      '-of',
      'json',
      file_path,
  ]
  logger.info('Probing media properties for: %s', file_path)
  result = subprocess.run(command, capture_output=True, text=True, check=True)
  properties = json.loads(result.stdout)

  video_info = {
      'duration': float(properties['format'].get('duration', 0)),
      'dimensions': 'N/A',
      'fps': 30.0,  # Default to a sensible float
      'has_audio': False,
  }

  if 'streams' in properties:
    for stream in properties['streams']:
      if stream.get('codec_type') == 'video':
        video_info['dimensions'] = (
            f"{stream.get('width', 0)}:{stream.get('height', 0)}"
        )
        if 'r_frame_rate' in stream and stream['r_frame_rate'] != '0/0':
          try:
            num, den = stream['r_frame_rate'].split('/')
            video_info['fps'] = float(num) / float(den)
          except (ValueError, ZeroDivisionError):
            logger.warning(
                'Could not parse r_frame_rate: %s', stream['r_frame_rate']
            )
            # Keep default fps if parsing fails
      elif stream.get('codec_type') == 'audio':
        video_info['has_audio'] = True

  properties_cache[file_path] = video_info
  return video_info


def get_media_duration(file_path: str) -> float:
  """Retrieves the duration of any media file.

  Args:
    file_path: Video whose duration is to be obtained.

  Returns:
    duration of the video
  """
  command = [
      FFPROBE_PATH,
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file_path,
  ]
  result = subprocess.run(command, capture_output=True, text=True, check=True)
  return float(result.stdout.strip())


class FFMPEG:
  """FFMPEG is a utility class for performing common ffmpeg actions."""

  encoding_speed_presets = [
      'veryslow',
      'slower',
      'slow',
      'medium',
      'fast',
      'faster',
      'veryfast',
      'superfast',
      'ultrafast',
  ]

  def __init__(self) -> None:
    self.inputs = []
    self.resolution = '1280:720'
    self.target_fps = 24

  def set_resolution(self, res: str) -> 'FFMPEG':
    """Sets the resolution of output artifacts.

    Args:
      res: the resolution to use in the format "x:y"

    Returns:
      the instance of FFMPEG so that calls can be chained.
    """
    self.resolution = res
    return self

  def add_video(
      self,
      *,
      path: str,
      skip_time: float,
      duration: float,
      transition: str,
      transition_overlap: float,
  ) -> 'FFMPEG':
    """Adds a video to the list of videos to be concatenated together.

    Args:
      path: the local path to the video clip to combine into the final.
      skip_time: the amount of time to skip from the start of the clip.
      duration: the duration of the clip in the final. ≤0 means to use the rest
        of the clip.
      transition: the FFmpeg xfade transition to use
      transition_overlap: the time that the transition should take

    Returns:
      the instance of FFMPEG so that calls can be chained.
    """
    properties = get_video_properties(path)
    if properties['fps'] > self.target_fps:
      self.target_fps = properties['fps']
    # Recompute the duration to be an integer multiple of frames
    frame_duration = 1.0 / self.target_fps
    if duration > 0:
      total_frames = round(duration / frame_duration)
      clean_duration = total_frames * frame_duration
    else:
      clean_duration = properties['duration']
    self.inputs.append({
        'type': 'video',
        'path': path,
        'skip': skip_time,
        'duration': clean_duration,
        'has_audio': properties['has_audio'],
        'transition': transition,
        'transition_overlap': transition_overlap,
    })
    return self

  def add_audio(
      self, path: str, start_time: float, skip_time: float, duration: float
  ) -> 'FFMPEG':
    """Adds an audio track to the list of audio tracks to be concatenated.

    Args:
      path: the local path to the audio clip to combine into the final.
      start_time: the time in seconds that the clip will start in the final.
      skip_time: the amount of time to skip from the start of the clip.
      duration: the duration of the clip in the final.

    Returns:
      the instance of FFMPEG so that calls can be chained.
    """
    self.inputs.append({
        'type': 'audio',
        'path': path,
        'start': start_time,
        'skip': skip_time,
        'duration': duration if duration > 0 else get_media_duration(path),
        'has_audio': True,
    })
    return self

  def add_image(
      self,
      *,
      path: str,
      start_time: float,
      duration: float,
      offset_x: int,
      offset_y: int,
      width: int,
      height: int,
  ) -> 'FFMPEG':
    """Adds an image list of images to be merged into a video.

    Args:
      path: the local path to the image
      start_time: time in seconds that the clip will start in the final video
      duration: how long to show the image
      offset_x: distance from the left, in pixels
      offset_y: distance from the top, in pixels
      width: target width in pixels
      height: target height in pixels (-1 implies auto)

    Returns:
      the instance of FFMPEG so that calls can be chained.

    TODO: use the start_time to start the clip at the right place.
    """
    self.inputs.append({
        'type': 'image',
        'path': path,
        'start': start_time,
        'end': start_time + duration,
        'offset_x': offset_x,
        'offset_y': offset_y,
        'width': width,
        'height': height,
        'has_audio': False,
    })
    return self

  def combine(
      self,
      output_filename,
      shortest_stream=False,
      encoding_speed=6,
      video_crf=20,
  ) -> str:
    """Builds and runs the ffmpeg command from all stored inputs.

    Args:
      output_filename: the desired name of the output file
      shortest_stream: whether to finish with the shortest input
      encoding_speed: higher values sacrifice quality for speed
      video_crf: compression - higher values sacrifice quality for compactness

    Returns:
      name of the written output file
    """
    if not any(i['type'] == 'video' for i in self.inputs):
      raise ValueError(
          'Cannot generate video without at least one video input.'
      )

    # --- 1. Build Input List and -i flags ---
    ffmpeg_command = [FFMPEG_PATH, '-v', 'error', '-y']
    for item in self.inputs:
      ffmpeg_command.extend(['-i', item['path']])
    filter_complex_parts = []

    # --- 2. Build Filter Chains for Each Input in Order ---
    video_segments = []
    audio_segments = []
    delayed_audio_segments = []

    video_seg_counter = 0
    extra_audio_seg_counter = 0

    for i, item in enumerate(self.inputs):
      if item['type'] == 'video':
        v_stream, a_stream = f'[{i}:v:0]', f'[{i}:a:0]'
        v_out, a_out = f'v_seg{video_seg_counter}', f'a_seg{video_seg_counter}'

        filter_complex_parts.append(
            f'{v_stream}fps={self.target_fps},'
            f"trim=start={item['skip']}:duration={item['duration']},"
            f'setpts=PTS-STARTPTS,scale={self.resolution},'
            f'setsar=1:1,format=yuv420p,fps={self.target_fps}[{v_out}]'
        )
        video_segments.append(v_out)

        if item['has_audio']:
          filter_complex_parts.append(
              f"{a_stream}atrim=start={item['skip']},"
              f'asetpts=PTS-STARTPTS,'
              f'apad,'  # Pads with silence if audio ends before video
              f"atrim=duration={item['duration']},"  # Caps audio video length
              f'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[{a_out}]'
          )
        else:
          # Generate silence that perfectly matches the format above
          filter_complex_parts.append(
              f'anullsrc=channel_layout=stereo:sample_rate=44100,'
              f"atrim=duration={item['duration']},"
              f'asetpts=PTS-STARTPTS,'
              f'aformat=sample_fmts=fltp[{a_out}]'
          )
        audio_segments.append(a_out)
        video_seg_counter += 1

      elif item['type'] == 'audio':
        trimmed_stream = f'trimmed_extra_a{extra_audio_seg_counter}'
        delayed_stream = f'delayed_extra_a{extra_audio_seg_counter}'

        filter_complex_parts.append(
            f"[{i}:a:0]atrim=start={item['skip']}:duration={item['duration']},"
            f'asetpts=PTS-STARTPTS[{trimmed_stream}]'
        )
        delay_ms = int(item['start'] * 1000)
        filter_complex_parts.append(
            f'[{trimmed_stream}]adelay={delay_ms}|{delay_ms}[{delayed_stream}]'
        )
        delayed_audio_segments.append(delayed_stream)
        extra_audio_seg_counter += 1

    # --- 3. Create Video/Audio Foundation (Transitions & Concatenation) ---
    video_items = [i for i in self.inputs if i['type'] == 'video']
    v_foundation = 'v_foundation'
    a_foundation = 'a_foundation'

    if len(video_segments) > 1:
      last_v_seg = video_segments[0]
      last_a_seg = audio_segments[0]
      total_duration = video_items[0]['duration']

      for i in range(1, len(video_segments)):
        transition = video_items[i].get('transition')
        overlap = video_items[i].get('transition_overlap')
        v_out = f'v_chain{i-1}'
        a_out = f'a_chain{i-1}'
        is_cut = not (transition and overlap and overlap > 0)
        if is_cut:
          filter_complex_parts.append(
              f'[{last_v_seg}][{video_segments[i]}]concat=n=2:v=1:a=0,'
              f'fps={self.target_fps}[{v_out}]'
          )
          total_duration += video_items[i]['duration']
          filter_complex_parts.append(
              f'[{last_a_seg}][{audio_segments[i]}]concat=n=2:v=0:a=1[{a_out}]'
          )
        else:
          offset = total_duration - overlap
          filter_complex_parts.append(
              f'[{last_v_seg}][{video_segments[i]}]xfade='
              f'transition={transition}:duration={overlap}:offset={offset},'
              f'fps={self.target_fps}[{v_out}]'
          )
          total_duration += video_items[i]['duration'] - overlap
          filter_complex_parts.append(
              f'[{last_a_seg}][{audio_segments[i]}]'
              f'acrossfade=d={overlap}:o=1:c1=tri:c2=tri[{a_out}]'
          )
        last_v_seg = v_out
        last_a_seg = a_out

      v_foundation = last_v_seg
      a_foundation = last_a_seg
    else:  # Only one video segment, just pass it through
      filter_complex_parts.append(f'[{video_segments[0]}]null[{v_foundation}]')
      filter_complex_parts.append(f'[{audio_segments[0]}]anull[{a_foundation}]')

    # --- 4. Overlay Images ---
    last_v_stream = v_foundation
    image_indices = [
        i for i, item in enumerate(self.inputs) if item['type'] == 'image'
    ]
    if not image_indices:
      final_video_stream = 'outv'
      filter_complex_parts.append(f'[{v_foundation}]null[{final_video_stream}]')
    else:
      for i, img_idx in enumerate(image_indices):
        img_item = self.inputs[img_idx]
        scaled_img, overlay_out = f'img{i}', f'v_overlay{i}'
        if i == len(image_indices) - 1:
          overlay_out = 'outv'

        filter_complex_parts.append(
            f"[{img_idx}:v:0]scale={img_item['width']}:{img_item['height']}[{scaled_img}]"
        )
        filter_complex_parts.append(
            f"[{last_v_stream}][{scaled_img}]overlay={img_item['offset_x']}:{img_item['offset_y']}:"
            f"enable='between(t,{img_item['start']},{img_item['end']})'[{overlay_out}]"
        )
        last_v_stream = overlay_out
      final_video_stream = last_v_stream

    # --- 5. Mix All Audio ---
    all_audio_to_mix = [a_foundation] + delayed_audio_segments
    if len(all_audio_to_mix) > 1:
      mix_inputs = ''.join(f'[{s}]' for s in all_audio_to_mix)
      num_inputs = len(all_audio_to_mix)
      filter_complex_parts.append(
          f'{mix_inputs}amix=inputs={num_inputs}:duration=first,'
          f'volume={num_inputs},'
          'alimiter=limit=-1dB[final_audio]'
      )
      final_audio_stream = 'final_audio'
    else:
      filter_complex_parts.append(
          f'[{a_foundation}]alimiter=limit=-1dB[final_audio]'
      )
      final_audio_stream = 'final_audio'

    # --- 6. Finalize and Run Command ---
    encoding_speed = max(
        0, min(encoding_speed, len(self.encoding_speed_presets) - 1)
    )
    ffmpeg_command.extend([
        '-c:v',
        'libx264',
        '-preset',
        self.encoding_speed_presets[encoding_speed],
        '-crf',
        f'{video_crf}',
    ])
    ffmpeg_command.extend(['-filter_complex', ';'.join(filter_complex_parts)])
    ffmpeg_command.extend(
        ['-map', f'[{final_video_stream}]', '-map', f'[{final_audio_stream}]']
    )
    if shortest_stream:
      ffmpeg_command.append('-shortest')
    ffmpeg_command.append(output_filename)

    logger.info('Running command: %s', shlex.join(ffmpeg_command))
    try:
      subprocess.run(
          ffmpeg_command,
          capture_output=True,
          text=True,
          check=True,
      )
    except subprocess.CalledProcessError as e:
      logger.error(
          'ERROR: ffmpeg command failed: %s. **Stdout**: %s. **Stderr**: %s.'
          ' **Command**: %s',
          e.output,
          e.stdout,
          e.stderr,
          e.cmd,
      )
      raise e
    logger.info('FFmpeg done')
    return output_filename

  def convert_video(self, input_file_path: str, output_file_extension: str):
    """Converts a video file to another format.

    Args:
      input_file_path: the local path to the video to be converted.
      output_file_extension: the file extension to use when saving the converted
        file. This will also be used to determine the target file type.

    Returns:
      the local path to the converted file.
    """
    # Check the type and dimensions to see if conversion is needed
    input_dimensions = get_video_properties(input_file_path)['dimensions']
    input_extension = input_file_path.split('.')[-1]
    if (
        input_extension == output_file_extension
        and input_dimensions == self.resolution
    ):
      return input_file_path
    # Actual conversion
    target_width, target_height = self.resolution.split(':')
    output_file_path = f'{input_file_path}_converted.{output_file_extension}'
    ffmpeg_command = [
        FFMPEG_PATH,
        '-i',
        input_file_path,
        '-vf',
        (
            f"scale='iw*min({target_width}/iw,"
            f"{target_height}/ih)':'ih*min({target_width}/iw,{target_height}/ih)',"
            f'pad={self.resolution}:(ow-iw)/2:(oh-ih)/2:black'
        ),
        '-c:a',
        'copy',
        output_file_path,
    ]
    try:
      logger.info('Running command: %s', shlex.join(ffmpeg_command))
      subprocess.run(
          ffmpeg_command,
          capture_output=True,
          text=True,
          check=True,
      )
    except subprocess.CalledProcessError as e:
      logger.error(
          'ERROR: ffmpeg command failed: %s. **Stdout**: %s. **Stderr**: %s.'
          ' **Command**: %s',
          e.output,
          e.stdout,
          e.stderr,
          e.cmd,
      )
      raise e

    return output_file_path
