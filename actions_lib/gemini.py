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

"""Encapsulates access to Gemini via the Vertex AI API."""

import json
import logging
import mimetypes
from typing import Any, Dict, List

from common import get_api_client_headers
from common import TrackingType
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)


def get_mime_type(uri: str) -> str:
  """Checks the file and returns its MIME type if supported.

  Args:
    uri: the URI of the file to get the type for.

  Returns:
    the mimetype string.
  """
  file_extension = uri.split(".")[-1].lower()
  allowed_types = [
      "png",
      "jpeg",
      "jpg",
      "webp",
      "heic",
      "heif",
      "mp4",
      "mov",
      "avi",
      "webm",
      "mkv",
  ]
  if file_extension in allowed_types:
    return mimetypes.types_map["." + file_extension]

  raise ValueError(f"File extension '{file_extension}' ({uri}) is not allowed.")


def remove_md_notation(s: str) -> str:
  """Removes the json wrapper from a Gemini response."""
  return s.replace("```json", "").replace("```", "")


def prompt(
    gcp_project: str,
    text_prompt: str,
    response_schema: Dict[str, Any] | None = None,
    file_uris: List[str] | None = None,
    need_to_remove_md_notation=True,
    location="us-central1",
    model="gemini-2.5-flash",
    temperature: float = 0.2,
    top_p: float = 0.2,
    tracking_type: TrackingType | None = None,
):
  """Prompts Gemini for a response.

  Args:
    gcp_project: The Google Cloud project ID.
    text_prompt: The text prompt to send to the model.
    response_schema: Optional dictionary defining the desired JSON response
      schema. If provided, the function returns a parsed JSON object.
    file_uris: Optional list of Cloud Storage URIs of files to include in the
      prompt.
    need_to_remove_md_notation: If True and response_schema is not provided,
      removes markdown code block notations (like ```json) from the output.
    location: The Vertex AI location to use (default: "us-central1").
    model: The Gemini model to use (default: "gemini-2.5-flash").
    temperature: Sampling temperature to control creativity.
    top_p: Nucleus sampling probability.
    call_type: Type of this call to reflect in a user-agent string.

  Returns:
    A dictionary containing the parsed JSON response if response_schema is
    provided, or a raw string containing the response text otherwise.
  """
  client = genai.Client(
      vertexai=True,
      project=gcp_project,
      location=location,
  )

  parts = [types.Part.from_text(text=text_prompt)]
  if file_uris is None:
    file_uris = []
  for file_uri in file_uris:
    parts.append(
        types.Part.from_uri(
            file_uri=file_uri, mime_type=get_mime_type(file_uri)
        )
    )
  contents = [types.Content(role="user", parts=parts)]

  safety_settings = [
      types.SafetySetting(
          category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH.value,
          threshold=types.HarmBlockThreshold.OFF.value,
      ),
      types.SafetySetting(
          category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT.value,
          threshold=types.HarmBlockThreshold.OFF.value,
      ),
      types.SafetySetting(
          category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT.value,
          threshold=types.HarmBlockThreshold.OFF.value,
      ),
      types.SafetySetting(
          category=types.HarmCategory.HARM_CATEGORY_HARASSMENT.value,
          threshold=types.HarmBlockThreshold.OFF.value,
      ),
  ]

  generate_content_config = types.GenerateContentConfig(
      temperature=temperature,
      top_p=top_p,
      max_output_tokens=8192,
      response_modalities=[types.Modality.TEXT.value]
      if not response_schema
      else None,
      response_mime_type="application/json" if response_schema else None,
      response_schema=response_schema,
      safety_settings=safety_settings,
      thinking_config=types.ThinkingConfig(thinking_budget=0)
      if model != "gemini-2.5-pro"
      else None,
  )
  http_options = (
      types.HttpOptions(headers=get_api_client_headers(tracking_type))
      if tracking_type
      else None
  )
  response = client.models.generate_content(
      model=model,
      contents=contents,
      config=generate_content_config,
      http_options=http_options,
  )
  if response.candidates and response.candidates[0].content.parts:
    output = "".join(
        part.text
        for part in response.candidates[0].content.parts
        if hasattr(part, "text")
    )
  else:
    output = ""

  if response_schema:
    return json.loads(output)
  if need_to_remove_md_notation:
    return remove_md_notation(output)

  return output
