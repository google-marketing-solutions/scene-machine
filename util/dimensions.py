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

"""Helps to manage dimensions in the input/output data of action functions.

For example, if an action is executed on data belonging to a single language,
these functions allow the action to ignore this, yet to still have that language
attached to its output.
"""

import copy
from typing import Any

from common import Key
from common import logger


def rename_dimensions(
    obj: dict[str, list[Any]], mapping: dict[str, str], inverse: bool = False
) -> Any:
  """Renames object properties according to the provided mapping.

  Args:
    obj: Object to modify, structured { a: [ {r1: ..., ...}, ... ], b: ... }.
    mapping: Mapping to rename properties (r1 etc. in the above example).
      Targets must be unique!
    inverse: If set, applies the mapping the other way around.

  Returns:
    The object with renamed properties.
  """
  if inverse:
    mapping = {v: k for k, v in mapping.items()}
  new_dict = {}
  for key, value in obj.items():
    new_dict[key] = [
        {mapping.get(k, k): v for k, v in item.items()} for item in value
    ]
  return new_dict


def merge_dimensions(
    output: dict[str, Any], dimensions: dict[str, Any]
) -> dict[str, Any]:
  """Assigns the input values' common dimensions to the output values.

  This ensures that the action functions do not have to worry about retaining
  these values.

  Args:
    output: The output values.
    dimensions: The dimensions to attach to the output.

  Returns:
    The output, enriched with the input's common dimensions.
  """
  if isinstance(output, dict):
    new_output = {}
    for key, value in output.items():
      new_output[key] = merge_dimensions(value, dimensions)
    return new_output
  elif isinstance(output, list):
    new_list = []
    for item in output:
      new_item = copy.deepcopy(item)
      new_item.update(dimensions)
      new_list.append(new_item)
    return new_list
  else:
    return output


def get_dimensions(
    input_files: dict[str, list[dict[str, Any]]],
    dimensions_consumed: list[str],
) -> dict[str, Any]:
  """Identifies the common dimensions of the inputs.

  For example, the input to an action may be texts with a dimension "language"
  and images with a dimension "audience". These would have been paired up for
  individual executions, each having a specific pair of language and audience.
  This function would identify which pair this is for the given input.

  Note that mismatching dimensions are discarded.

  Args:
    input_files: The input to be analysed.
    dimensions_consumed: The dimensions to be ignored because they are not
      expected to be common in the input.

  Returns:
    A mapping from dimension names to values.
  """
  dimensions: dict[str, Any] = {}
  for input_key, value_list in input_files.items():
    if not isinstance(value_list, list):
      raise TypeError(f'Input for {input_key} must be a list')
    for entry in value_list:
      if not isinstance(entry, dict):
        raise TypeError('Each element in lists must be a dictionary')
      for key, value in entry.items():
        if key != Key.FILE.value and key not in dimensions_consumed:
          if key in dimensions:
            if dimensions[key] != value:
              logger.warning('Discarding inconsistent dimension %s', key)
              del dimensions[key]
          else:
            dimensions[key] = value
  return dimensions
