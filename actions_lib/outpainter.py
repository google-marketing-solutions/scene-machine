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

"""Outpaints images.

Provides a function to outpaint an image using Google Gemini. Outpainting is the
act of increasing an image's size, while filling in the new space to make it
look like the image has been zoomed out.

The main entry point is outpaint_image(). This takes bytes of image data and
returns an outpainted PNG.
"""

import io
from typing import Tuple

from google import genai
from google.genai import types as gtypes
import PIL.Image


_IMAGE_MODEL = "gemini-2.5-flash-image"


def outpaint_image(
    image_bytes: bytes, gcp_project: str, gcp_location: str, target_ratio: str
) -> Tuple[bytes, str]:
    """Outpaints the given image using Google Gemini Image.

    Args:
      image_bytes: the bytes of the image to outpaint. These must be a JPEG or PNG
        image.
      gcp_project: the ID of Google Cloud project to use with Imagen.
      gcp_location: the Google Cloud location to use with the model.
      target_ratio: the aspect ratio of the outpainted image. This is a string in
        the form of "width:height" (e.g. "16:9")

    Returns:
      A tuple of the bytes of the outpainted image and its mime type.

    Raises:
      ValueError: if the response from the model doesn't contain any data.
    """
    with io.BytesIO(image_bytes) as input_bytes:
        image = PIL.Image.open(input_bytes)
        image.load()

    outpaint_prompt = "Outpaint the image to the required aspect ratio"

    client = genai.Client(
        vertexai=True, project=gcp_project, location=gcp_location
    )
    contents = [outpaint_prompt, image]
    generate_config = gtypes.GenerateContentConfig(
        response_modalities=["IMAGE"],
        image_config=gtypes.ImageConfig(
            aspect_ratio=target_ratio,
        ),
    )

    outpaint_response = client.models.generate_content(
        model=_IMAGE_MODEL, contents=contents, config=generate_config
    )

    if not outpaint_response.candidates:
        raise ValueError(
            "The response from the model did not contain any candidates."
        )
    candidate = outpaint_response.candidates[0]
    if not candidate.content or not candidate.content.parts:
        raise ValueError(
            "The first candidate from the model did not contain any content or"
            " parts."
        )
    part = candidate.content.parts[0]
    # The part may be a text part with an error message, so we check for data.
    if not hasattr(part, "inline_data") or not part.inline_data:
        raise ValueError(
            "The first part of the first candidate from the model did not contain"
            f" any inline data: {part}"
        )

    outpaint_blob = part.inline_data
    if not outpaint_blob.data or not outpaint_blob.mime_type:
        raise ValueError("No data found in the outpainting result")

    return outpaint_blob.data, outpaint_blob.mime_type
