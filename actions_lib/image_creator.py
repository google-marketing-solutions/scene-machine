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

"""Generates images from scratch."""

from typing import List, Tuple

from google import genai
from google.genai import types as gtypes


IMAGE_MODEL = "gemini-2.5-flash-image"


def generate_images(
    gcp_project: str,
    gcp_location: str,
    image_prompt: str,
    amount: int = 1,
    aspect_ratio: str = "16:9",
    allow_persons: bool = True,
) -> List[Tuple[bytes, str]]:
  """Generates images from a text prompt and returns them as bytes.

  Args:
    gcp_project: The ID of the Google Cloud project to use.
    gcp_location: The Google Cloud location to use.
    image_prompt: The text prompt describing the image to generate.
    amount: The number of images to generate.
    aspect_ratio: The aspect ratio of the generated image. This is a
      string in the form of "width:height" (e.g. "16:9").
    allow_persons: Whether to allow the generation of adult persons.

  Returns:
    A list of tuples, where each tuple contains the bytes of the generated
    image and its mime type.

  Raises:
    ValueError: If the response from the model doesn't contain any candidates
      or if the resulting images lack data.
  """
  client = genai.Client(
      vertexai=True, project=gcp_project, location=gcp_location
  )

  # Map boolean to the expected PersonGeneration string values
  person_generation = (
      gtypes.PersonGeneration.ALLOW_ADULT
      if allow_persons
      else gtypes.PersonGeneration.DONT_ALLOW
  )

  generate_config = gtypes.GenerateContentConfig(
      response_modalities=["IMAGE"],
      candidate_count=amount,
      image_config=gtypes.ImageConfig(
          aspect_ratio=aspect_ratio,
          person_generation=person_generation,
      ),
  )

  response = client.models.generate_content(
      model=IMAGE_MODEL,
      contents=[image_prompt],
      config=generate_config,
  )

  if not response.candidates:
    raise ValueError(
        "The response from the model did not contain any candidates."
    )

  output_images = []
  for candidate in response.candidates:
    if not candidate.content or not candidate.content.parts:
      raise ValueError(
          "A candidate from the model did not contain any content or parts."
      )

    part = candidate.content.parts[0]

    # The part may be a text part with an error message, so we check for data.
    if not hasattr(part, "inline_data") or not part.inline_data:
      raise ValueError(
          "A part from the model candidate did not contain any inline data: "
          f"{part}"
      )

    image_blob = part.inline_data
    if not image_blob.data or not image_blob.mime_type:
      raise ValueError("No data found in the generation result")

    output_images.append((image_blob.data, image_blob.mime_type))

  return output_images
