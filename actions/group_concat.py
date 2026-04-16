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

"""Concatenates a list of strings."""

from __future__ import annotations

from common import ContentType
from common import Key
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


def execute(
    gcs: GCS, _: Params, text: NodeInput, sorting_key: str, separator: str
) -> NodeOutput:
  """Executes the action.

  Args:
    gcs: The GCS client.
    text: The input file.
    sorting_key: The property by which to sort the input.
    separator: What to put between the elements in the output.

  Returns:
    A reference to the output file.
  """
  sorted_items = sorted(text, key=lambda x: x[sorting_key])
  concatenation = separator.join(
      gcs.load_text(item[Key.FILE.value]) for item in sorted_items
  )
  concatenation_filepath = gcs.store(
      concatenation, 'grouped_concatenation.txt', ContentType.TEXT.value
  )
  return {'text': [{Key.FILE.value: concatenation_filepath}]}
