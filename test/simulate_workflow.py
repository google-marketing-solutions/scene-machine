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

"""Tests the viability and theoretical output of workflows."""

import collections
import itertools
import json
from typing import Any


from common import Key
from orchestrator import ACTIONS_JSON_PATH
from util import dimensions as util_dimensions
from util import group_input
from util import workflow as util_workflow

_WORKFLOW_FILE = 'workflow_examples/image2video.json'

with open(ACTIONS_JSON_PATH, 'r', encoding='utf-8') as file:
  actions = json.load(file)


def simulate_execution(workflow: dict[str, Any]) -> list[str]:
  """Roughly simulates the execution of a workflow.

  The simulation is conducted in terms of the dimensions of the flowing data:
  based on a topological sorting of the nodes, the workflow is traversed in the
  order it would be executed, and each time determines a fake set of output data
  based on the input and config.

  Args:
      workflow: The workflow object, modified by adding inputFiles and
        outputFiles for all nodes.

  Returns:
      A list of node IDs reachable from start_node in a topologically sorted
      order, representing a valid execution sequence. Returns an empty list
      if the workflow is invalid.
  """
  workflow_definition = workflow[Key.WORKFLOW_DEF.value]
  start_node = workflow[Key.NODE_ID.value]
  if not isinstance(workflow_definition, dict):
    print('Workflow definition must be a dictionary.')
    return []
  if start_node not in workflow_definition:
    print(f'Node "{start_node}" not found in workflow.')
    return []

  in_degree = {node_id: 0 for node_id in workflow_definition}
  all_nodes = set(workflow_definition.keys())
  for node_id, node_data in workflow_definition.items():
    if not isinstance(node_data, dict):
      print(f'Invalid data format for node "{node_id}".')
      return []
    inputs = node_data.get(Key.INPUT.value, {})
    if not isinstance(inputs, dict):
      print(f'Invalid node "{node_id}"')
      return []
    # Keep track of unique predecessors *for this node* to calculate in-degree
    predecessors_counted_for_node = set()
    for input_name, source in inputs.items():
      if isinstance(source, dict):
        predecessor_id = source.get(Key.NODE.value)
        if predecessor_id and predecessor_id in all_nodes:
          # Increment in-degree once per unique predecessor for this node
          if predecessor_id not in predecessors_counted_for_node:
            if node_id not in in_degree:
              return []
            in_degree[node_id] += 1
            predecessors_counted_for_node.add(predecessor_id)
        elif predecessor_id:
          print(
              f'Predecessor "{predecessor_id}" of node "{node_id}" not found.'
          )
          return []
      # Handle the case where input might be null (like in the root node)
      elif source is None:
        pass  # Root node has no predecessors
      else:
        print(
            f'Invalid input source format for "{input_name}" in node'
            f' "{node_id}".'
        )

  # queue = deque([start_node])
  # Record nodes added to the queue to avoid processing them multiple times if
  # they are reachable via multiple paths before their in-degree becomes 0.
  queue = collections.deque(
      [node_id for node_id, degree in in_degree.items() if degree == 0]
  )
  queued_nodes = set(
      queue
  )  # Keep track of nodes initially added or added later

  sorted_nodes = []
  processed_nodes_count = 0

  while queue:
    current_node_id = queue.popleft()
    sorted_nodes.append(current_node_id)

    current_node = workflow_definition[current_node_id]
    action = current_node[Key.ACTION.value]

    # Determine output files of the current node
    print(f'Visiting {current_node_id}: {action} turns')
    outputs = (
        actions[action][Key.OUTPUT.value].keys()
        if action != 'pass'
        else current_node.get(Key.INPUT.value, {})
    )
    input_files = current_node.get(Key.INPUT.value, {})
    dimensions_consumed = current_node.get(Key.DIMENSIONS_CONSUMED.value, [])
    print(json.dumps(input_files, indent=2))
    if action == 'pass':
      output_files = input_files
    else:
      if not set(input_files.keys()).issubset(
          actions[action][Key.INPUT.value].keys()
      ):
        print('  Not all inputs are supported by the action.')
        return []
      output_files = {key: [] for key in outputs}
      if in_degree[current_node_id] == 0:
        input_groups = [{'dummy': [{'file': '...'}]}]
      else:
        input_groups = group_input.group_input(
            input_files,
            dimensions_consumed,
        )
      expanded_parameters = util_workflow.expand_parameters(
          current_node.get(Key.PARAMETERS.value, {})
      )
      output_groups = []
      for input_group in input_groups:
        for input_key, input_list in input_group.items():
          if len(input_list) > 1 and not actions[action][Key.INPUT.value][
              input_key
          ].get(Key.MULTI.value, False):
            print(f'  Received multiple inputs for a scalar input {input_key}.')
            return []
        for _ in expanded_parameters:
          output_group = {key: [{Key.FILE.value: '...'}] for key in outputs}
          for output_key in outputs:
            output = actions[action][Key.OUTPUT.value][output_key]
            dimensions = output.get(Key.DIMENSIONS.value, [])
            possible_values = (
                ['1', '2'] if output.get(Key.MULTI.value, False) else ['x']
            )
            combined_objects = []
            for obj in output_group[output_key]:
              value_combinations = itertools.product(
                  possible_values, repeat=len(dimensions)
              )
              for values in value_combinations:
                new_obj = obj.copy()
                for i, key in enumerate(dimensions):
                  new_obj[key] = values[i]
                combined_objects.append(new_obj)
            output_group[output_key] = combined_objects
          completed_output = util_dimensions.merge_dimensions(
              output_group,
              util_dimensions.get_dimensions(input_group, dimensions_consumed),
          )
          output_groups.append(completed_output)
      output_files = {
          key: [item for d in output_groups if key in d for item in d[key]]
          for key in outputs
      }
    current_node[Key.OUTPUT_FILES.value] = output_files
    print('  into')
    print(json.dumps(output_files, indent=2))

    processed_nodes_count += 1
    successors = util_workflow.determine_successors(
        workflow_definition, current_node_id
    )
    for successor_node_id in successors:
      successor_node = workflow_definition[successor_node_id]
      if successor_node_id not in in_degree:
        print(
            f'Successor node "{successor_node_id}" of node "{current_node_id}"'
            ' not found.'
        )
        return []
      in_degree[successor_node_id] -= 1

      # Supply successor nodes
      print(f'  Supplying {successor_node_id}')
      inputs = successor_node.get(Key.INPUT.value, {})
      for input_name in inputs:
        if (
            successor_node[Key.INPUT.value][input_name]['node']
            == current_node_id
        ):
          output_key = successor_node[Key.INPUT.value][input_name]['output']
          print(f'    adding input {input_name} from {output_key}')
          successor_node[Key.INPUT_FILES.value] = successor_node.get(
              Key.INPUT_FILES.value, {}
          )
          successor_node[Key.INPUT_FILES.value][input_name] = output_files[
              output_key
          ]

      if (
          in_degree[successor_node_id] == 0
          and successor_node_id not in queued_nodes
      ):
        queue.append(successor_node_id)
        queued_nodes.add(successor_node_id)

  # Check for cycles: re-check successors for any ending with positive in-degree
  if len(sorted_nodes) != len(workflow_definition):
    print(
        'Cycle detected or graph is disconnected. Processed'
        f' {len(sorted_nodes)} nodes out of {len(workflow_definition)}.'
    )
    # You might want more sophisticated cycle detection here if needed,
    # but this is the standard check after Kahn's algorithm.
    return []
  return sorted_nodes


# Attach fictitious input files to root node
with open(_WORKFLOW_FILE, 'r', encoding='utf-8') as file:
  wf = json.load(file)
  wf[Key.WORKFLOW_DEF.value][wf[Key.NODE_ID.value]][Key.INPUT_FILES.value] = {
      key: [{Key.FILE.value: '...'}]
      for key in wf[Key.WORKFLOW_DEF.value][wf[Key.NODE_ID.value]][
          Key.INPUT.value
      ]
  }
  if simulate_execution(wf):
    print(json.dumps(wf[Key.WORKFLOW_DEF.value], indent=2))
