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

"""Provides functions relating to the mapping of node outputs to inputs."""

import itertools
from typing import Any

from common import Key
from common import NodeOutput


def map_output_to_input(
    predecessor_node_id: str,
    output: NodeOutput,
    input_structure: dict[str, Any],
) -> dict[str, Any]:
  """Maps the output of a predecessor node to the input of the current node.

  Args:
    predecessor_node_id: The ID of the predecessor node.
    output: The output dictionary of the predecessor node.
    input_structure: The input structure of the current node, specifying
      the expected inputs and their sources (predecessor node and output key).

  Returns:
    A dictionary mapping the input keys of the current node to the
    corresponding values from the predecessor's output.

  Raises:
    KeyError: invalid output key
  """
  result = {}
  for input_key, source in input_structure.items():
    if source.get(Key.NODE.value) == predecessor_node_id:
      output_key = source.get(Key.OUTPUT.value)
      if output_key not in output:
        print(output)
        raise KeyError(
            f'{output_key} not among {"/".join(map(str, output.keys()))}'
        )
      result[input_key] = output[output_key]
  return result


def expand_parameters(parameters: dict[str, Any]) -> list[dict[str, Any]]:
  """Generates all possible combinations of the given parameters.

  For example, the input
    {"sourceLang": "en", "targetLang": ["de", "fr"]}
  will result in
   [{"sourceLang": "en", "targetLang": "de"},
    {"sourceLang": "en", "targetLang": "fr"}].

  Args:
    parameters: The parameters whose values are to be combined.

  Returns:
    The combined parameters.
  """
  normalized_params = {
      k: v if isinstance(v, list) else [v] for k, v in parameters.items()
  }
  if not normalized_params:
    return [{}]
  keys = list(normalized_params.keys())
  values = list(normalized_params.values())
  expanded = []
  for combination in itertools.product(*values):
    expanded.append(dict(zip(keys, combination)))
  return expanded


def determine_successors(
    workflow_definition: dict[str, Any], current_node_id: str
) -> list[str]:
  """Determines the successor nodes of a given node.

  Args:
    workflow_definition: The workflow definition dictionary.
    current_node_id: The ID of the current node.

  Returns:
    A list of successor node IDs.
  """
  successors = []
  for node_id, node in workflow_definition.items():
    if node_id != current_node_id:
      input_sources = node.get(Key.INPUT.value, {})
      if not input_sources and current_node_id == 'root':
        successors.append(node_id)
      else:
        for input_source in input_sources.values():
          if (
              isinstance(input_source, dict)
              and input_source.get(Key.NODE.value) == current_node_id
          ):
            successors.append(node_id)
            break
  return successors
