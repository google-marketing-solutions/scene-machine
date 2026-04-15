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

"""Generates videos."""

import json
import time
from typing import Any
from typing import Literal

from common import get_api_client_headers
from google import genai
from google.genai import types


Resolution = Literal['720p', '1080p', '4k']


def generate(
    gcp_project: str,
    gcp_location: str,
    prompt: str,
    image_url: str | None,
    image_type: str | None,
    duration_seconds: int = 8,
    amount: int = 1,
    aspect_ratio: str = '16:9',
    resolution: Resolution = '720p',
    output_gcs: str = 'gs://',
    enhance_prompt: bool = True,
    allow_persons: bool = True,
    model: str = 'veo-3.0-generate-preview',
    generate_audio: bool = False,
) -> list[str] | None:
  """Generates videos using Veo."""
  client = genai.Client(
      vertexai=True,
      project=gcp_project,
      location=gcp_location,
      http_options=types.HttpOptions(headers=get_api_client_headers()),
  )
  # Note: Below, types.GenerateVideosConfigDict led to linting problems.
  config_params: dict[str, Any] = {
      'aspect_ratio': aspect_ratio,
      'resolution': resolution,
      'output_gcs_uri': output_gcs,
      'number_of_videos': min(max(amount, 1), 4),
      'duration_seconds': min(max(duration_seconds, 4), 8),
      'person_generation': (
          types.PersonGeneration.ALLOW_ADULT.value
          if allow_persons
          else types.PersonGeneration.DONT_ALLOW.value
      ),
      'enhance_prompt': enhance_prompt,
  }
  if model > 'veo-3':
    # Veo 3 doesn't allow disabling enhance_prompt
    config_params['enhance_prompt'] = True
    config_params['generate_audio'] = generate_audio
  image = (
      types.Image(gcs_uri=image_url, mime_type=image_type)
      if image_url
      else None
  )
  operation = client.models.generate_videos(
      model=model,
      prompt=prompt,
      image=image,
      config=types.GenerateVideosConfig(**config_params),  # pyright: ignore[reportArgumentType], pylint: disable=linetoolong
  )
  while not operation.done:
    time.sleep(5)
    operation = client.operations.get(operation)
    print(('Veo status: ', operation))
  if (
      hasattr(operation, 'result')
      and operation.result
      and hasattr(operation.result, 'generated_videos')
      and operation.result.generated_videos
  ):
    return [
        entry.video.uri
        for entry in operation.result.generated_videos
        if entry.video and entry.video.uri
    ]
  if hasattr(operation, 'error') and operation.error:
    message = operation.error.get('message') or ''
  else:
    message = json.dumps(operation.__dict__, indent=2)
  raise RuntimeError('No videos generated: ' + message)
