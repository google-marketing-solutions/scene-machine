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

"""Tests whether the actions match actions.json (inputs and parameters)."""

import importlib
import inspect
import json
import pkgutil
from typing import Any

from common import Key
from common import NodeInput
from common import Params
from util.gcs_wrapper import GCS


_ACTIONS_PACKAGE_NAME = 'actions'
_EXEC_FUNCTION_NAME = 'execute'


def _get_action_functions() -> dict[str, Any]:
  """Discovers and returns all action functions from the "actions" package.

  Functions are expected to be directly defined in their respective modules
  and not start with an underscore (e.g., _helper_func).

  Returns:
    A dictionary mapping action names to their corresponding functions.
  """
  functions: dict[str, Any] = {}

  try:
    actions_package = importlib.import_module(_ACTIONS_PACKAGE_NAME)
  except ModuleNotFoundError:
    print('Error: Actions package not found.')
    return functions

  for _, modname, ispkg in pkgutil.iter_modules(actions_package.__path__):
    if ispkg or modname == '__init__':
      continue

    full_module_name = f'{_ACTIONS_PACKAGE_NAME}.{modname}'
    try:
      module = importlib.import_module(full_module_name)
      if hasattr(module, _EXEC_FUNCTION_NAME) and inspect.isfunction(
          getattr(module, _EXEC_FUNCTION_NAME)
      ):
        execute_func = getattr(module, _EXEC_FUNCTION_NAME)
        # Ensure the execution function is defined directly in this module
        if execute_func.__module__ == module.__name__:
          # Use the module's base name (modname) as the key
          functions[modname] = execute_func
    except ModuleNotFoundError:
      print(f'Error: Action {modname} not found.')
  return functions


def verify_signatures() -> None:
  """Verifies that function signatures match the JSON definitions."""
  with open('ui/definitions/actions.json', 'r', encoding='utf-8') as file:
    actions_def = json.load(file)
  action_funcs = _get_action_functions()
  defined_action_names = set(actions_def.keys())
  implemented_func_names = set(action_funcs.keys())

  print('--- Verifying actions defined in actions.json ---')
  for action_name, definition in actions_def.items():
    print(f'Checking action: "{action_name}"...')

    if action_name not in action_funcs:
      print(f'  ERROR: "{action_name}" not found among actions.')
      continue

    func = action_funcs[action_name]
    try:
      sig = inspect.signature(func)
      func_params = sig.parameters
    except ValueError:
      print(f'  ERROR: Function "{action_name}" missing.')
      continue

    all_actual_param_names = list(func_params.keys())
    actual_params_to_compare = set(all_actual_param_names[2:])
    expected_params_from_json = set()
    action_inputs = definition.get(Key.INPUT.value, {})
    for input_name in action_inputs.keys():
      expected_params_from_json.add(input_name)
    action_params = definition.get(Key.PARAMETERS.value, {})
    for param_name in action_params.keys():
      expected_params_from_json.add(param_name)
    missing_in_func = expected_params_from_json - actual_params_to_compare
    extra_in_func = actual_params_to_compare - expected_params_from_json
    if missing_in_func:
      print(
          f'  ERROR: Function "{action_name}" is missing:'
          f' {", ".join(sorted(missing_in_func))}'
      )

    if extra_in_func:
      # Filter out allowed variable arguments like **kwargs if necessary.
      # (Adjust if your actions use *args or **kwargs intentionally beyond the
      # defined parameters.)
      true_extra = {
          p
          for p in extra_in_func
          if func_params[p].kind
          not in (
              inspect.Parameter.VAR_POSITIONAL,
              inspect.Parameter.VAR_KEYWORD,
          )
      }
      if true_extra:
        print(
            f'  ERROR: Function "{action_name}" has unexpected:'
            f' {", ".join(sorted(true_extra))}'
        )

    simple_types = ('str', 'int', 'float', 'bool')
    # Optional: Basic type-hint verification
    for name, param in func_params.items():
      if param.annotation is inspect.Parameter.empty:
        print(
            f'  WARNING: Parameter "{name}" in function "{action_name}" is'
            ' missing a type hint.'
        )
        continue  # Skip check if no hint

      if name == 'gcs' and param.annotation != 'GCS':
        print(
            f'  WARNING: Parameter "gcs" in "{action_name}" should have type'
            f' "GCS", found "{param.annotation}".'
        )
      elif name in action_inputs and param.annotation != 'NodeInput':
        print(
            f'  WARNING: Input "{name}" in "{action_name}" should have type'
            f' "NodeInput", found "{param.annotation}".'
        )
      # Parameters (non-input) can have various simple types, harder to check
      # strictly against JSON without more info.
      elif name in action_params and param.annotation not in simple_types:
        if not isinstance(param.annotation, type) or param.annotation in (
            NodeInput,
            GCS,
            Params,
        ):
          print(
              f'  WARNING: Parameter "{name}" in function "{action_name}" has'
              f' unexpected type hint "{param.annotation}". Expected simple'
              ' type (e.g., str, int, float).'
          )

  print('\n--- Verifying implemented actions ---')
  implemented_but_not_defined = implemented_func_names - defined_action_names
  if implemented_but_not_defined:
    print('WARNING: The following actions are not defined in actions.json:')
    for func_name in sorted(implemented_but_not_defined):
      # Optional: Ignore functions starting with '_' as potential helpers
      if not func_name.startswith('_'):
        print(f'  - {func_name}')
  else:
    print('All found implemented actions match actions.json.')


verify_signatures()
