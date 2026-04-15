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

"""Generates an arrangement for videos.

For now, this merely combines the input "somehow" for testing, and no guidance
on ordering etc. is possible or derived from the data (e.g. scene IDs). UI-based
solutions generate their own arrangements, anyway.
"""

from __future__ import annotations
import json
from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS, _: Params, video: NodeInput, audio: NodeInput, image: NodeInput
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    _: The workflow parameters.
    video: The videos to be arranged.
    audio: The audio to be arranged.
    image: The images to be arranged.

  Returns:
    The reference to the resulting JSON arrangement.
  """

  arrangement = []
  duration = 8

  for i, video_item in enumerate(video):
    arrangement.append({
        'file_type': 'video',
        'file_path': video_item[Key.FILE.value],
        'start_time': i * duration,
        'skip_time': 0,
        'duration': duration,
    })
  for i, audio_item in enumerate(audio):
    arrangement.append({
        'file_type': 'audio',
        'file_path': audio_item[Key.FILE.value],
        'start_time': i * duration,
        'skip_time': 0,
        'duration': duration,
    })
  for i, image_item in enumerate(image):
    arrangement.append({
        'file_type': 'image',
        'file_path': image_item[Key.FILE.value],
        'start_time': 0,
        'duration': 1,
        'offset_x': 10 * i,
        'offset_y': 10 * i,
        'width': 100,
    })

  arrangement_json = json.dumps(arrangement)
  path = gcs.store(arrangement_json, 'arrangement.txt', ContentType.TEXT.value)
  return {'arrangement': [{Key.FILE.value: path}]}
