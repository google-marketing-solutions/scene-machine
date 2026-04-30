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

"""Resizes a given image to the target dimensions.

The image is first resized to fit the target canvas, then filled with
additional content to achieve the intended aspect ratio (and hence size).
"""

from __future__ import annotations

import enum
import io
import os

from actions_lib import outpainter
from common import ContentType
from common import Dimension
from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
import PIL.Image
from util.gcs_wrapper import GCS

PIXEL_DIFFERENCE_THRESHOLD = 5


class ImageInstructionType(enum.Enum):
  """Enumerates ways of fixing an image's aspect ratio."""

  CROP = 'crop'
  OUTPAINT = 'outpaint'
  NOTHING = 'none'


def _check_aspect_ratio(
    img: PIL.Image.Image, expected_ratio: float
) -> tuple[int, int, bool]:
  """Checks if the given image needs cropping.

  Args:
    img: The image object to check.
    expected_ratio: The target aspect ratio.

  Returns:
    A tuple with the needed cropping dimensions and a flag whether to crop.
  """
  width, height = img.size
  current_ratio = width / height
  if current_ratio == expected_ratio:
    return width, height, True
  elif current_ratio > expected_ratio:
    target_width = round(height * expected_ratio)
    target_height = height
  else:
    target_width = width
    target_height = round(width / expected_ratio)
  return target_width, target_height, False


def _crop_image(
    img: PIL.Image.Image,
    target_width: int,
    target_height: int,
) -> PIL.Image.Image:
  """Crops the given image if needed.

  Args:
    img: The image object to trim.
    target_width: The width of the target image.
    target_height: The height of the target image.

  Returns:
    The image cropped to the center.
  """
  width, height = img.size
  left = (width - target_width) // 2
  top = (height - target_height) // 2
  right = left + target_width
  bottom = top + target_height
  return img.crop((left, top, right, bottom))


def _image_to_bytes(img: PIL.Image.Image, image_format: str = 'PNG') -> bytes:
  """Converts a PIL Image to bytes."""
  with io.BytesIO() as output_stream:
    img.save(output_stream, format=image_format)
    return output_stream.getvalue()


def execute(
    gcs: GCS,
    workflow_params: Params,
    image: NodeInput,
    target_ratio: str,
    outpainter_model: str,
    outpainter_model_location: str,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS object to use when accessing files.
    workflow_params: the parameters common to all nodes in the workflow. The
      required parameters are gcp_project and gcp_location, which are,
      respectively, the project to use when querying gemini and the gcp_location
      to use.
    image: the relative path of the image to outpaint.
    target_ratio: the aspect ratio of the finished image in the format
      width:height (e.g. 9:16)


  Returns:
    A NodeOutput with a one-entry dict with the key "outpainted_image".
  """
  try:
    target_w, target_h = map(int, target_ratio.split(':'))
    expected_ratio = target_w / target_h
  except ValueError as exc:
    raise ValueError(
        f'Invalid target_ratio: "{target_ratio}". '
        'Format must be width:height with integers (e.g. "16:9").'
    ) from exc

  image_path = image[0][Key.FILE.value]
  image_instruction = image[0].get(
      Dimension.IMAGE_INSTRUCTION.value, ImageInstructionType.NOTHING.value
  )
  logger.info('Applying %s to %s', image_instruction, image_path)
  if image_instruction == ImageInstructionType.NOTHING.value:
    logger.info('Forwarding image untouched')
    return {'outpainted_image': [{Key.FILE.value: image_path}]}

  image_bytes = gcs.load_bytes(image_path)
  mime_type = None

  if image_instruction == ImageInstructionType.OUTPAINT.value:
    logger.info('Outpainting...')
    image_bytes, mime_type = outpainter.outpaint_image(
        image_bytes,
        workflow_params[Key.GCP_PROJECT.value],
        outpainter_model_location,
        outpainter_model,
        target_ratio,
    )

  with io.BytesIO(image_bytes) as input_stream:
    img = PIL.Image.open(input_stream)
    target_width, target_height, correct_ratio = _check_aspect_ratio(
        img, expected_ratio
    )

    if not correct_ratio:
      logger.info('Cropping image...')
      img = _crop_image(img, target_width, target_height)
      mime_type = ContentType.JPEG.value
      save_format = 'JPEG'
      image_bytes = _image_to_bytes(img, save_format)
    elif not mime_type:
      detected_mime = PIL.Image.MIME.get(img.format) if img.format else None
      mime_type = detected_mime or ContentType.JPEG.value

  extension = mime_type.split('/')[-1]
  if extension == 'jpeg':
    extension = 'jpg'

  logger.debug('Storing resulting image to GCS.')
  destination_path = f'{os.path.basename(image_path)}_outpainted.{extension}'
  outpainted_path = gcs.store(image_bytes, destination_path, mime_type)
  logger.debug('Resulting image stored at: %s', outpainted_path)
  return {'outpainted_image': [{Key.FILE.value: outpainted_path}]}
