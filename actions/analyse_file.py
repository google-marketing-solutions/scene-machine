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

"""Analyses a file using Gemini."""

from __future__ import annotations

import json
from typing import Any
from typing import Dict

from actions_lib import gemini
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    params: Params,
    prompt: str,
    file: NodeInput,
    generation_prompt: NodeInput,
    response_schema: Dict[str, Any],
    gemini_model: str = 'gemini-2.5-flash',
) -> NodeOutput:
    """Executes the analyse_file action.

    Args:
      gcs: The GCS client.
      params: Workflow parameters.
      prompt: The prompt to send to Gemini.
      file: The path to the file in GCS.
      generation_prompt: Optional prompt to send to compare with the file.
      response_schema: Optional JSON schema for the response.
      gemini_model: The Gemini model to use.

    Returns:
      A NodeOutput containing the Gemini response.
    """
    workflow_params = params.get(Key.WORKFLOW_PARAMS.value, {})
    gcp_project = workflow_params.get(Key.GCP_PROJECT.value)

    if generation_prompt:
        prompt += f"""
      The file was generated using the following prompt (in <ORIGINAL_PROMPT> tags):
      <ORIGINAL_PROMPT>{gcs.load_text(generation_prompt[0][Key.FILE.value])}</ORIGINAL_PROMPT>
    """

    file_path = file[0][Key.FILE.value]
    file_uri = gcs.get_uri(file_path)
    response = gemini.prompt(
        gcp_project=gcp_project,
        text_prompt=prompt,
        file_uris=[file_uri],
        response_schema=response_schema,
        model=gemini_model,
    )
    return {"text": [{"value": json.dumps(response)}]}
