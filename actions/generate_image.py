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

"""Creates an image given a prompt."""

from __future__ import annotations

import os

from actions_lib import image_creator
from common import Dimension
from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    workflow_params: Params,
    prompt: NodeInput,
    variant_quantity: int,
    aspect_ratio: str,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    workflow_params: The workflow parameters.
    prompt: The prompt to use to generate the image.
    variant_quantity: The number of images to generate.
    aspect_ratio: The aspect ratio of the generated image (e.g. "16:9")

  Returns:
    A NodeOutput object containing the path to the generated image(s).
  """
  prompt_path = prompt[0][Key.FILE.value]
  image_prompt = gcs.load_text(prompt_path)

  logger.info('Generating %s images...', variant_quantity)

  # generate_images now returns a list of (image_bytes, mime_type) tuples
  generated_data = image_creator.generate_images(
      gcp_project=workflow_params[Key.GCP_PROJECT.value],
      gcp_location=workflow_params[Key.GCP_LOCATION.value],
      image_prompt=image_prompt,
      amount=variant_quantity,
      aspect_ratio=aspect_ratio,
      allow_persons=True,
  )

  image_paths = []
  base_name = os.path.splitext(os.path.basename(prompt_path))[0]

  for index, (image_bytes, mime_type) in enumerate(generated_data):
    extension = mime_type.split('/')[-1]
    if extension == 'jpeg':
      extension = 'jpg'

    destination_path = f'{base_name}_generated_{index}.{extension}'

    logger.debug('Storing generated image %s to GCS.', index)
    saved_path = gcs.store(image_bytes, destination_path, mime_type)

    image_paths.append({
        Key.FILE.value: saved_path,
        Dimension.IMAGE_VARIANT_ID.value: str(index),
    })

  return {'image': image_paths}
