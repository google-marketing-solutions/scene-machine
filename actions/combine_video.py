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

"""Concatenates video and audio files.

This yields one file with (optional) an audio track.
- Arrays of video and audio files currently each get concatenated in the order
  of their appearance.
- Videos are allowed not to already have an audio track.

Alternatively to requiring a complete arrangement, there could be separate
actions that iteratively construct commands that then get executed in one go in
a subsequent execution action, so that no compression loss accumulates. This
would also better support mixed use cases in which a series of auto-generated
videos are to be concatenated with pre-defined videos at the beginning and end:
Instead of needing workflow-level functionality to merge inputs with potentially
different dimensions, the individual steps would be taken in tailor-made
actions.
"""

from __future__ import annotations

import json
import os
import uuid

from actions_lib.ffmpeg import FFMPEG
from common import ContentType
from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    workflow_params: Params,  # pylint: disable=unused-argument
    arrangement: NodeInput,
    resolution: str,
    encoding_speed: int,
    quality_level: int,
) -> NodeOutput:
  """Combines video and audio files.

  Args:
      gcs: The GCS object to use when accessing files.
      workflow_params: workflow-level parameters.
      arrangement: A reference to a JSON file with an array of objects
        describing the media arrangement. Each object can contain:
          - file_type (str): "video", "audio", or "image".
          - file_path (str): Relative GCS path to the file.
          - start_time (float): Start time in the final video (in seconds).
          - skip_time (float): Time to skip from the start of the clip (in
            seconds).
          - duration (float): Duration in the final video (in seconds).
          - transition (str): FFmpeg xfade transition name.
          - transition_overlap (float): Duration of the transition (in seconds).
          - offset_x (int): For images, distance from the left in pixels.
          - offset_y (int): For images, distance from the top in pixels.
          - width (int): For images, target width in pixels.
          - height (int): For images, target height in pixels.
      resolution: the target resolution in the format x:y
      encoding_speed: the FFmpeg encoding-speed setting to use
      quality_level: the FFmpeg quality level to use

  Returns:
    object referencing the resulting video
  """
  logger.info('Starting combine_video')
  arrangement_path = arrangement[0][Key.FILE.value]
  arrangement_file = gcs.load_text(arrangement_path)
  try:
    arrangement_content = json.loads(arrangement_file)
  except json.JSONDecodeError as ex:
    logger.error('Error decoding arrangement json: %s', ex)
    raise ex

  ffmpeg = FFMPEG()
  ffmpeg.set_resolution(resolution)
  files_to_delete = []

  for arr in arrangement_content:
    skip_time = arr.get('skip_time', 0)
    duration = arr.get('duration', -1)
    offset_x = arr.get('offset_x', 0)
    offset_y = arr.get('offset_y', 0)

    try:
      local_path = arr['file_path'].replace('/', '_')
    except KeyError as ke:
      logger.error('Arrangement entry missing file_path.')
      raise ke

    gcs.save_locally(arr['file_path'], local_path)
    files_to_delete.append(local_path)
    if 'video' == arr['file_type']:
      transition = arr.get('transition')
      transition_overlap = arr.get('transition_overlap')
      if transition and not transition_overlap:
        transition_overlap = 0.5

      ffmpeg.add_video(
          path=local_path,
          skip_time=skip_time,
          duration=duration,
          transition=transition,
          transition_overlap=transition_overlap,
      )
    elif 'audio' == arr['file_type']:
      ffmpeg.add_audio(local_path, arr['start_time'], skip_time, duration)
    elif 'image' == arr['file_type']:
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
      logger.error('Unsupported file type: %s', arr['file_type'])
      raise ValueError('Unsupported file type')
  output_filename = uuid.uuid4().hex + '_output.mp4'

  logger.info('Combining video')
  output_file_path = ffmpeg.combine(
      output_filename, False, encoding_speed, quality_level
  )
  logger.info('Done')
  files_to_delete.append(output_file_path)
  with open(output_file_path, 'rb') as output_file:
    output_file_bites = output_file.read()

  logger.info('Read contents of combined video')
  for file in set(files_to_delete):
    os.remove(file)
  logger.info('Deleted component videos locally')

  return {
      'video': [{
          Key.FILE.value: gcs.store(
              output_file_bites, 'output.mp4', str(ContentType.MP4.value)
          )
      }]
  }
