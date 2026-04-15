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

"""Converts an image from one format to another."""

from __future__ import annotations

import io
import os

from actions_lib import image_converter
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
import PIL.Image
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS, _: Params, file: NodeInput, output_mime_types: str
) -> NodeOutput:
  """Executes the image-conversion action.

  A list of acceptable output MIME types is provided as a comma-separated list.
  If the image is already in one of the output MIME types, the image will be
  returned as is. Otherwise, it will be converted to the first type on the list.

  Args:
    gcs: The GCS client.
    file: The input file.
    output_mime_types: A comma-separated list of MIME types to convert to.

  Returns:
    A NodeOutput object containing the path to the converted image file.

  Raises:
    ValueError: If the output file extension is not supported.
    IndexError: If the output_mime_types string is malformed.
  """

  output_type_list = output_mime_types.split(",")
  output_mime_type = output_type_list[0]  # saved for later if we convert
  output_type_list = [o.strip().upper().split("/")[1] for o in output_type_list]

  image_path = file[0][Key.FILE.value]
  image_bytes = gcs.load_bytes(image_path)
  image = PIL.Image.open(io.BytesIO(image_bytes))
  image.load()

  if image.format in output_type_list:
    return {"image": [{Key.FILE.value: image_path}]}

  image.close()

  output_extension = output_type_list[0].lower()
  converted_bytes = image_converter.convert(image_bytes, output_extension)
  converted_path = gcs.store(
      converted_bytes,
      f"{os.path.basename(image_path)}_converted.{output_extension}",
      output_mime_type,
  )
  return {"image": [{Key.FILE.value: converted_path}]}
