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

"""Generates a list of variants according to the given briefing.

The idea is that the briefing can ask to enumerate environments/weather
conditions, audiences/personas, locations/cultures, visual styles/tints, story
genres, everyday contexts etc.
"""

from __future__ import annotations
import typing

from actions_lib import gemini
from common import ContentType
from common import Dimension
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


ResponseSchema = list[dict[str, str]]


def execute(
    gcs: GCS,
    workflow_params: Params,
    briefing: NodeInput,
    variants_min: int,
    variants_max: int,
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    workflow_params: The workflow parameters.
    briefing: The briefing defining the variants.
    variants_min: The minimum number of variants to generate.
    variants_max: The maximum number of variants to generate.

  Returns:
    A NodeOutput object containing the path to the variant descriptions.

  Raises:
    RuntimeError: The model returned an invalid response.
  """
  briefing_text = gcs.load_text(briefing[0][Key.FILE.value])
  text_prompt = """You are to come up with possible variants for an
  advertisement given a briefing. For example, if the briefing states that ads
  are to be localised to a certain set of places, then provide a list of those
  along with a description of their characteristics. If the briefing states that
  the ads are to have different colours schemes, then list colours or colour
  combinations along with examples of what has this colour. The
  descriptive_title should be short but pertinent, in the mentioned examples it
  would be the name of the place or colour."""
  text_prompt += f'\n\nBriefing: {briefing_text}'

  response_schema = {
      'type': 'array',
      'items': {
          'type': 'object',
          'properties': {
              'descriptive_title': {'type': 'string'},
              'description': {'type': 'string'},
          },
          'required': ['descriptive_title', 'description'],
      },
      'minItems': variants_min,
      'maxItems': variants_max,
  }

  variant_paths = []

  # 2. Rename this to reflect that it's raw text
  variants: ResponseSchema = typing.cast(
      ResponseSchema,
      gemini.prompt(
          workflow_params[Key.GCP_PROJECT.value], text_prompt, response_schema
      ),
  )

  for variant in variants:
    name = variant.get('descriptive_title')
    description = variant.get('description')

    if not name or not description:
      raise RuntimeError('The model did not adhere to response schema.')

    filename = f'variant_{name}.txt'
    variant_path = gcs.store(description, filename, ContentType.TEXT.value)

    variant_paths.append({
        Key.FILE.value: variant_path,
        Dimension.VARIANT_NAME.value: name,
    })

  return {'variant': variant_paths}
