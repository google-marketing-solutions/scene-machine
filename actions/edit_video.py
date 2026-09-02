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

"""Edits a video with a text prompt using Gemini Omni."""

from __future__ import annotations

from actions_lib import omni
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    workflow_params: Params,
    video: NodeInput,
    prompt: NodeInput,
    model: str,
    gcp_location: str,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS object to use when accessing files.
    workflow_params: The parameters common to all nodes in the workflow.
      The required parameter is gcp_project, the project to use when
      calling Gemini Omni.
    video: The video to edit.
    prompt: The text prompt describing the edit.
    model: The Omni model to use for editing.
    gcp_location: The location of the model to use.

  Returns:
    A NodeOutput with a one-entry dict with the key "edited_video".
  """
  if not video or not prompt:
    return {'edited_video': []}

  video_path = video[0][Key.FILE.value]
  prompt_text = gcs.load_text(prompt[0][Key.FILE.value])
  edited_uri = omni.edit(
      gcp_project=workflow_params[Key.GCP_PROJECT.value],
      gcp_location=gcp_location,
      prompt=prompt_text,
      video_uri=gcs.get_uri(video_path),
      video_mime=gcs.get_mime_type(video_path),
      model=model,
      output_gcs=gcs.get_path_uri(),
  )
  return {'edited_video': [{Key.FILE.value: gcs.strip_prefix(edited_uri)}]}
