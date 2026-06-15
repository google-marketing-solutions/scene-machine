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

"""Translates text."""

from __future__ import annotations

from actions_lib import gemini
from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


TEXT_MODEL = "gemini-2.5-flash"


def execute(
    gcs: GCS, workflow_params: Params, text: NodeInput, target_language: str
) -> NodeOutput:
  """Executes the translation action using Google Gemini.

  Reads text from a GCS file, translates it into the target language
  using Gemini, and stores the resulting translation back into GCS.

  Args:
    gcs: The GCS wrapper instance for loading and storing files.
    workflow_params: Pipeline parameters, used for GCP project extraction.
    text: The input node containing the reference to the source file.
    target_language: The language to translate the text into (e.g., 'fr',
      'Spanish', 'Japanese').

  Returns:
    A NodeOutput dictionary containing the translated file's GCS path
    and language metadata.

  Raises:
    ValueError: If the source file is empty or if the model fails to
      return a valid text response.
  """
  source_text = gcs.load_text(text[0][Key.FILE.value])
  prompt = (
      f"Translate the following text into {target_language}. "
      "Return only the translated text, without any markdown formatting, "
      "conversational filler, or quotes.\n\n"
      f"{source_text}"
  )

  response = gemini.prompt(
      gcp_project=workflow_params[Key.GCP_PROJECT.value],
      text_prompt=prompt,
      model=TEXT_MODEL,
  )

  if not response:
    raise ValueError("The model did not return any text for the translation.")

  # Ensure the response is handled as a string
  translation = (
      response.strip() if isinstance(response, str) else str(response).strip()
  )

  translation_filepath = gcs.store(
      translation, "translation.txt", ContentType.TEXT.value
  )

  return {
      "text": [
          {Key.FILE.value: translation_filepath, "language": target_language}
      ]
  }
