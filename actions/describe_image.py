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

"""Describes an image."""

from __future__ import annotations

import json

from actions_lib import image_describer
from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    workflow_params: Params,
    image: NodeInput,
    guidance: NodeInput,
    gemini_model: str,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    workflow_params: The workflow parameters.
    image: The input image.
    guidance: The guidance on how to describe the image.
    gemini_model: The name of the Gemini model to use.

  Returns:
    A NodeOutput object containing the path to the image description file.
  """
  image_path = gcs.get_uri(image[0][Key.FILE.value])
  guidance_str = gcs.load_text(guidance[0][Key.FILE.value]) if guidance else ''
  description = image_describer.describe_image(
      image_path,
      guidance_str,
      workflow_params[Key.GCP_PROJECT.value],
      gemini_model,
  )
  image_description_file_path = gcs.store(
      json.dumps(description), 'image_description.json', ContentType.JSON.value
  )
  return {'description': [{Key.FILE.value: image_description_file_path}]}
