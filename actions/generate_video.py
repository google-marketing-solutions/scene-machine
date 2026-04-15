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

"""Generates videos using Veo."""

from __future__ import annotations
from typing import cast

from actions_lib import veo
from common import Dimension
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS,
    workflow_params: Params,
    prompt: NodeInput,
    image: NodeInput,
    aspect_ratio: str,
    duration_seconds: int,
    video_variant_quantity: int,
    gcp_project: str,
    gcp_location: str,
    model: str,
    generate_audio: bool,
    resolution: str,
) -> NodeOutput:
  """Executes the action."""
  if not prompt:
    return {'video': []}

  prompt_text = gcs.load_text(prompt[0][Key.FILE.value])
  has_image = len(image) > 0
  image_url = gcs.get_uri(image[0][Key.FILE.value]) if has_image else None
  image_type = (
      gcs.get_mime_type(image[0][Key.FILE.value]) if has_image else None
  )
  video_uris = veo.generate(
      gcp_project=gcp_project or workflow_params[Key.GCP_PROJECT.value],
      gcp_location=gcp_location or workflow_params[Key.GCP_LOCATION.value],
      prompt=prompt_text,
      image_url=image_url,
      image_type=image_type,
      duration_seconds=duration_seconds,
      amount=video_variant_quantity,
      aspect_ratio=aspect_ratio,
      resolution=cast(veo.Resolution, resolution),
      output_gcs=gcs.get_path_uri(),
      model=model,
      generate_audio=generate_audio,
  )
  if not video_uris:
    video_paths = []
  else:
    video_paths = [
        {
            Key.FILE.value: gcs.strip_prefix(video_uri),
            Dimension.VIDEO_VARIANT_ID.value: str(index),
        }
        for index, video_uri in enumerate(video_uris)
    ]
  return {'video': video_paths}
