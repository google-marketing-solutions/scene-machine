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

"""Converts a video from one format to another."""

from __future__ import annotations
from actions_lib.ffmpeg import FFMPEG
from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    _: Params,
    file: NodeInput,
    output_file_dimension: str,
    output_file_extension: str,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    file: The input file.
    output_file_dimension: the output resolution in the format x:y
    output_file_extension: the output file extension

  Returns:
    A NodeOutput object containing the path to the converted video file.
  """
  file_path = file[0][Key.FILE.value]
  local_path = file_path.split("/")[-1]
  gcs.save_locally(file_path, local_path)

  ffmpeg = FFMPEG().set_resolution(output_file_dimension)
  converted_video_path = ffmpeg.convert_video(local_path, output_file_extension)

  with open(converted_video_path, "rb") as output_file:
    output_file_bites = output_file.read()
    return {
        "video": [{
            Key.FILE.value: gcs.store(
                output_file_bites,
                f"output.{output_file_extension}",
                ContentType.MP4.value,
            )
        }]
    }
