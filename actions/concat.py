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

"""Concatenates strings."""

from __future__ import annotations

from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS, _: Params, text1: NodeInput, text2: NodeInput, separator: str
) -> NodeOutput:
  """Executes the concatenation action.

  Args:
    gcs: The GCS client.
    text1: The first input file.
    text2: The second input file.
    separator: The string to put between the input texts.

  Returns:
    A NodeOutput object containing the path to the concatenated text file.
  """
  concatenation = (
      (gcs.load_text(text1[0][Key.FILE.value]) if text1 else '')
      + separator
      + (gcs.load_text(text2[0][Key.FILE.value]) if text2 else '')
  )
  concatenation_filepath = gcs.store(
      concatenation, 'concatenation.txt', ContentType.TEXT.value
  )
  return {'text': [{Key.FILE.value: concatenation_filepath}]}
