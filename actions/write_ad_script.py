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

"""Writes a script for a video ad fitting the given briefing."""

from __future__ import annotations
import typing
from typing import Any

from actions_lib import gemini
from common import ContentType
from common import Dimension
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


ResponseSchema = dict[str, Any]


def execute(
    gcs: GCS,
    workflow_params: Params,
    briefing: NodeInput,
    theme: NodeInput,
    story_variant_quantity: int,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    workflow_params: Workflow parameters.
    briefing: The style briefing.
    theme: The theme for the intended variations.
    story_variant_quantity: The number of variants to generate per variation.

  Returns:
    A NodeOutput object containing the ad script.
  """
  briefing_text = gcs.load_text(briefing[0][Key.FILE.value])

  text_prompt = 'Write a script for an ad according to the following guidance:'
  text_prompt += f'\n\nBriefing: {briefing_text}'
  if len(theme) > 0:
    theme_text = gcs.load_text(theme[0][Key.FILE.value])
    theme_title = theme[0][Dimension.THEME_TITLE.value]
    text_prompt += f'\n\nTheme: {theme_title}\n{theme_text}'
  else:
    theme_title = '-'
  style_paths = []
  script_paths = []
  image_desc_paths = []
  response_schema = {
      'type': 'object',
      'properties': {
          'style': {'type': 'string'},
          'scenes': {
              'type': 'array',
              'items': {
                  'type': 'object',
                  'properties': {
                      'video_prompt': {'type': 'string'},
                      'starting_image_description': {'type': 'string'},
                  },
                  'required': ['video_prompt', 'starting_image_description'],
              },
              'minItems': 3,
              'maxItems': 6,
          },
      },
      'required': ['style', 'scenes'],
  }
  for story_variant_id in range(story_variant_quantity):
    result: ResponseSchema = typing.cast(
        ResponseSchema,
        gemini.prompt(
            workflow_params[Key.GCP_PROJECT.value], text_prompt, response_schema
        ),
    )
    style_path = gcs.store(
        result['style'], f'style_{story_variant_id}.txt', ContentType.TEXT.value
    )
    style_paths.append({
        Key.FILE.value: style_path,
        Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
        Dimension.THEME_TITLE.value: theme_title,
    })
    for scene_id, scene in enumerate(result['scenes']):
      filename = f'script_{story_variant_id}_{scene_id}.txt'
      script_path = gcs.store(
          scene['video_prompt'], filename, ContentType.TEXT.value
      )
      script_paths.append({
          Key.FILE.value: script_path,
          Dimension.SCENE_ID.value: str(scene_id),
          Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
          Dimension.THEME_TITLE.value: theme_title,
      })
      filename = f'image_desc_{story_variant_id}_{scene_id}.txt'
      image_desc_path = gcs.store(
          scene['starting_image_description'], filename, ContentType.TEXT.value
      )
      image_desc_paths.append({
          Key.FILE.value: image_desc_path,
          Dimension.SCENE_ID.value: str(scene_id),
          Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
          Dimension.THEME_TITLE.value: theme_title,
      })
  return {
      'style': style_paths,
      'video_prompt': script_paths,
      'starting_image_description': image_desc_paths,
  }
