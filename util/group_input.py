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

"""Provides functions to group input to action functions as they can handle.

For example, if a text is to be translated to a number of languages, this would
pair each language with the input text.
"""

import copy
import itertools
from typing import Any
from typing import cast

from common import Key


def _group_dictionaries(
    data: list[dict[str, Any]], ignore: list[str]
) -> tuple[list[Any], dict[tuple[str, ...], list[Any]]]:
  """Groups dictionaries based on the combined values of their properties.

  For example, given dictionaries with common properties "color" and "size",
  this identifies all the combinations of color and size that are actually
  present and groups the dictionaries by those pairs.

  Args:
      data: The list of dictionaries to group.
      ignore: The keys, besides "file", to ignore in the grouping.

  Returns:
      grouping_keys: The keys underlying the identified groups.
      groups: The identified groups.
  """
  if not data:
    return [], {tuple(): []}

  if not isinstance(data, list) or not isinstance(data[0], dict):
    raise ValueError('Input must be a list of dictionaries.')

  grouping_keys = [
      key for key in data[0] if (key != Key.FILE.value and key not in ignore)
  ]
  if not grouping_keys:
    return [], {tuple(): [item for item in data]}
  groups: dict[tuple[str, ...], Any] = (
      {}
  )  # Use a dictionary to store groups, keyed by a tuple of grouping values
  for item in data:
    group_key = tuple(item[key] for key in grouping_keys)
    if group_key not in groups:
      groups[group_key] = []
    groups[group_key].append(item)
  return grouping_keys, groups


def _partition_parameters(input_dict: dict[str, Any]) -> list[dict[str, Any]]:
  """Creates a cross-product structure based on parameters' dimension values.

  This function takes an input dictionary whose keys are parameter names and
  values are tuples containing dimensions and a mapping of dimension values to
  parameter values. It constructs a recursive structure that aligns parameters
  based on shared dimension values, effectively creating a cross-product of
  parameters where dimension values match.

  Args:
    input_dict: The input dictionary.

  Returns:
    A list of dictionaries, where each dictionary represents a combination of
    parameter values aligned by shared dimension values.
  """

  def _build_recursive_structure(
      current_structure: (
          tuple[list[str], dict[tuple[str, ...], dict[str, Any]]] | None
      ),
      remaining_params: dict[str, Any],
  ) -> tuple[list[str], dict[tuple[str, ...], dict[str, Any]]]:
    """Recursively builds a parameter partition structure.

    Args:
      current_structure: The current structure being built.
      remaining_params: The dictionary of remaining parameters to process.

    Returns:
      The constructed parameter partition structure.

    Raises:
      RuntimeError: If there is nothing to build
    """
    if not remaining_params:
      if current_structure is None:
        raise RuntimeError('Nothing to build')
      return current_structure
    param_name, (dimensions, value_map) = remaining_params.popitem()

    if current_structure is None:  # First parameter
      new_structure: tuple[list[str], dict[tuple[str, ...], dict[str, Any]]] = (
          dimensions,
          {},
      )
      for dim_values, param_values in value_map.items():
        new_structure[1][dim_values] = {param_name: param_values}
      return _build_recursive_structure(new_structure, remaining_params)

    current_dims, current_map = current_structure
    new_dims = list(set(current_dims + dimensions))
    new_map: dict[tuple[str, ...], dict[str, Any]] = {}

    # Create a mapping from dimension indices in current_dims and dimensions
    # to their positions in new_dims
    current_dim_indices = {dim: new_dims.index(dim) for dim in current_dims}
    new_dim_indices = {dim: new_dims.index(dim) for dim in dimensions}

    for current_dim_tuple, current_param_dict in current_map.items():
      for new_dim_tuple, new_param_values in value_map.items():
        # Check for compatibility (matching dimension values)
        compatible = True
        for dim in set(current_dims).intersection(dimensions):
          current_index = current_dims.index(dim)
          new_index = dimensions.index(dim)
          if current_dim_tuple[current_index] != new_dim_tuple[new_index]:
            compatible = False
            break

        if compatible:
          # Create combined dimension tuple
          combined_dim_list: list[str | None] = [None] * len(new_dims)
          for dim, index in current_dim_indices.items():
            combined_dim_list[index] = current_dim_tuple[
                current_dims.index(dim)
            ]
          for dim, index in new_dim_indices.items():
            combined_dim_list[index] = new_dim_tuple[dimensions.index(dim)]
          combined_dim_tuple = cast(tuple[str, ...], tuple(combined_dim_list))

          # Merge parameter dictionaries
          if combined_dim_tuple in new_map:
            new_map[combined_dim_tuple].update({param_name: new_param_values})
            # Merge potentially existing values. Important for the recursion.
            for k, v in current_param_dict.items():
              if k in new_map[combined_dim_tuple]:
                new_map[combined_dim_tuple][k] = v
              else:
                new_map[combined_dim_tuple][k] = v

          else:
            new_map[combined_dim_tuple] = {param_name: new_param_values}
            new_map[combined_dim_tuple].update(current_param_dict)

    # Add entries for dimension value tuples that only occur with either the
    # current parameters or the new parameter
    all_dim_combis = set()
    for key in current_map.keys():
      expanded_list: list[str | None] = [None] * len(new_dims)
      for dim, index in current_dim_indices.items():
        expanded_list[index] = key[current_dims.index(dim)]
      all_dim_combis.add(cast(tuple[str, ...], tuple(expanded_list)))
    for key in value_map.keys():
      expanded_list = [None] * len(new_dims)
      for dim, index in new_dim_indices.items():
        expanded_list[index] = key[dimensions.index(dim)]
      all_dim_combis.add(cast(tuple[str, ...], tuple(expanded_list)))
    for dim_combi in all_dim_combis:
      if dim_combi not in new_map:
        new_map[dim_combi] = {}
        current_combi = tuple(
            [dim_combi[current_dim_indices[d]] for d in current_dims]
        )
        if current_combi in current_map:
          new_map[dim_combi].update(current_map[current_combi])
        new_combi = tuple([dim_combi[new_dim_indices[d]] for d in dimensions])
        if new_combi in value_map:
          new_map[dim_combi][param_name] = value_map[new_combi]
        # Fill in empty lists for missing parameter data.
        for existing_param_name in input_dict.keys():
          if existing_param_name not in new_map[dim_combi]:
            new_map[dim_combi][existing_param_name] = []
    new_map = _remove_redundant_entries(new_map)

    return _build_recursive_structure((new_dims, new_map), remaining_params)

  def _remove_redundant_entries(
      data_map: dict[tuple[str, ...], dict[str, Any]],
  ) -> dict[tuple[str, ...], dict[str, Any]]:
    """Removes redundant entries from the dimension-parameter mapping.

    Redundant entries are those where a dimension tuple contains None and
    another tuple exists with concrete values for the same dimensions.

    Args:
      data_map: The dictionary mapping dimension tuples to parameter dicts.

    Returns:
      The cleaned data_map with redundant entries removed.
    """
    keys_to_remove = set()
    for t in data_map:  # Iterate through tuples (t)
      if None in t:  # Check if t has a None value
        for other in data_map:  # Iterate through all other tuples
          if t == other:
            continue

          match = True
          has_non_none = False

          for i, this_tuple in enumerate(t):
            if this_tuple is not None and this_tuple != other[i]:
              match = False
              break
            if this_tuple is None and other[i] is not None:
              has_non_none = True

          # Only consider removing t if other has data
          other_has_data = any(data_map[other].values())

          if match and has_non_none and other_has_data:
            keys_to_remove.add(t)
            break  # No need to check other tuples once t is marked for removal

    for key in keys_to_remove:
      del data_map[key]
    return data_map

  initial_structure = None
  remaining_params = input_dict.copy()
  final_structure = _build_recursive_structure(
      initial_structure, remaining_params
  )
  # Extract the list of dictionaries
  return list(final_structure[1].values())


def _cross_product_dicts(a: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
  """Calculates the "cross product" of an array of arrays of dictionaries.

  Args:
    a: A list of lists of dictionaries.

  Returns:
    A list of dictionaries, where each dictionary is a merged result of
    taking one dictionary from each inner list in 'a'.
  """

  if not a:
    return []  # Handle empty input array

  # Use itertools.product to generate all combinations of dictionaries,
  # one from each inner list.
  combinations = itertools.product(*a)

  result = []
  for combination in combinations:
    merged_dict = {}
    for dictionary in combination:
      # Deepcopy to prevent unintended modifications of original dictionaries
      merged_dict.update(copy.deepcopy(dictionary))
    result.append(merged_dict)

  return result


def group_input(
    input_dict: dict[str, Any], ignore: list[str] | None = None
) -> list[dict[str, Any]]:
  """Generates a cross-product of aligned input values.

  Args:
    input_dict: The input to process.
    ignore: The dimensions to ignore.

  Returns:
    The cross-product of aligned input values.
  """
  # 1: For each input, identify its relevant dimensions
  #    and group input values by their dimension values
  grouped_values = {}
  for key, value_list in input_dict.items():
    value_list = [d for d in value_list if '_error' not in d]
    grouping_keys, groups = _group_dictionaries(value_list, ignore or [])
    grouped_values[key] = (grouping_keys, groups)
  # 2: Partition inputs into groups that overlap in terms of relevant dimensions
  overlap_partition = []
  processed_keys = set()

  def _find_connected_group(key: str, current_group: dict[str, Any]) -> None:
    """Recursively groups dictionary keys that share common dimensions' values.

    This function relies on the outer existence of processed_keys and
    grouped_values. It updates the former only consider every key once. It uses
    the argument current_group to collect the group that actually shares common
    dimension.

    Args:
      key: The key to check.
      current_group: The group to potentially grow until no overlap remains.
    """
    if key in processed_keys:
      return
    processed_keys.add(key)
    current_group[key] = grouped_values[key]
    dimensions = set(grouped_values[key][0])
    for other_key, (other_dimensions, _) in grouped_values.items():
      if other_key != key and not processed_keys.issuperset({other_key}):
        if dimensions.intersection(other_dimensions):
          _find_connected_group(other_key, current_group)

  for key in grouped_values:
    if key not in processed_keys:
      new_group: dict[str, Any] = {}
      _find_connected_group(key, new_group)
      overlap_partition.append(new_group)
  # 3: Per partition, create the (aligned) cross product
  #    of all input values whose dimension values match
  partitioned_products = []
  for dictionary in overlap_partition:
    partitioned_products.append(_partition_parameters(dictionary))
  # 4: Merge all values of all partitions with each other
  return _cross_product_dicts(partitioned_products)
