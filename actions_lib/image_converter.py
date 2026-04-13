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

"""Image converter action library."""

import io
import PIL.Image


def convert(file_bytes: bytes, output_extension: str) -> bytes:
  """Converts an image to the specified output file type.

  Args:
    file_bytes: The image file bytes.
    output_extension: The output image file extension.

  Returns:
    The converted image file bytes.
  """
  with io.BytesIO(file_bytes) as input_bytes:
    image = PIL.Image.open(input_bytes)
    image.load()

  if image.format.lower() == output_extension.lower():
    return file_bytes

  with io.BytesIO() as converted_bytes:
    try:
      image.save(converted_bytes, output_extension)
    except (PIL.UnidentifiedImageError, KeyError) as e:
      raise ValueError(
          f"Failed to convert image to {output_extension}. Please use an"
          " image format supported by Pillow."
      ) from e

    return converted_bytes.getvalue()
