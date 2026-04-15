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

"""Encapsulates the calling of actions.

To allow action functions to focus on their core purpose, this enriches them
with common functionality and provides them with a signature suitable to be
called in the main endpoints.
"""

from collections.abc import Callable
import datetime
import functools
import importlib
import inspect
import json
import pathlib
from typing import Any

from common import ContentType
from common import Key
from common import logger
from common import NodeOutput
from common import TypeNames
from google.cloud import storage
from util import checksum as util_checksum
from util import dimensions as util_dimensions
from util import errors as util_errors
from util import gcs_wrapper
from util.gcs_wrapper import GCS


ActionFunction = Callable[..., NodeOutput]


def get_action_by_name(action_name: str) -> ActionFunction:
  """Gets the "execute" method of the named action in the "actions" package.

  Args:
    action_name: Name of the action to get.

  Returns:
    The "execute" method of the named action.
  """
  module_path = f'actions.{action_name}'
  execute_function = 'execute'
  try:
    module = importlib.import_module(module_path)
    return getattr(module, execute_function)
  except ModuleNotFoundError as e:
    raise RuntimeError(
        f'Action module "{action_name}" not found or erroneous.'
    ) from e
  except AttributeError as e:
    raise RuntimeError(
        f'Module "{module_path}" misses execution function".'
    ) from e


def _generic_function_caller(
    gcs: GCS,
    input_files: dict[str, Any],
    parameters: dict[str, Any],
    workflow_params: dict[str, Any],
    func: ActionFunction,
) -> NodeOutput:
  """Calls an action function with the provided arguments.

  Args:
      gcs: The object handling access to GCS.
      input_files: The dictionary with the node's GCS inputs.
      parameters: The dictionary with the node's non-GCS inputs.
      workflow_params: The dictionary with the workflow's non-GCS inputs.
      func: The function to be called.

  Returns:
      The output of the called function.
  """
  kwargs = {}
  sig = inspect.signature(func)
  all_inputs = input_files.copy()
  for param_name, param in sig.parameters.items():
    # There should not be any non-named parameters.
    if param.kind in (
        inspect.Parameter.VAR_KEYWORD,
        inspect.Parameter.VAR_POSITIONAL,
    ):
      continue
    if param.annotation == TypeNames.NODE_INPUT.value:
      kwargs[param_name] = (
          all_inputs[param_name] if param_name in all_inputs else []
      )
    if param_name in parameters:
      kwargs[param_name] = parameters[param_name]
  return func(gcs, workflow_params, **kwargs)


def _generate_error_output(
    action_name: str,
    error_content: str,
    input_files: dict[str, Any],
    dimensions_consumed: list[str],
    dimensions_mapping: dict[str, str],
) -> dict[str, Any]:
  """Generates a fake result by formally serving output, but with an error.

  This ensures that the error is available in Firestore.

  Args:
    action_name: name of the failing action
    error_content: error message
    input_files: input files to inform the output structure
    dimensions_consumed: dimensions consumed to inform the output structure
    dimensions_mapping: dimensions mapping to inform the output structure

  Returns:
    Fake action result with an error.
  """
  logger.warning('Hidden error: %s', error_content)
  root_dir = pathlib.Path(__file__).parent
  with open(
      root_dir / 'ui/definitions/actions.json', 'r', encoding='utf-8'
  ) as file:
    actions_def = json.load(file)
  output = dict.fromkeys(
      actions_def[action_name][Key.OUTPUT.value], [{'_error': error_content}]
  )
  final_output = util_dimensions.merge_dimensions(
      output, util_dimensions.get_dimensions(input_files, dimensions_consumed)
  )
  return util_dimensions.rename_dimensions(final_output, dimensions_mapping)


def _update(file: storage.Blob, final_output: dict[str, Any]) -> None:
  """Update the file with the generated output.

  Args:
    file: the file to update
    final_output: the output to store
  """
  json_string = json.dumps(final_output, indent=4)
  file.metadata = {
      'timeToDelete': (
          (
              datetime.datetime.now(datetime.timezone.utc)
              + datetime.timedelta(days=14)
          ).isoformat()
      )
  }
  file.upload_from_string(json_string, content_type=ContentType.JSON.value)


def wrapper(func: ActionFunction) -> Callable[..., NodeOutput]:
  """Wraps an action function for usage in the orchestration.

  Args:
      func: The action function to be wrapped.

  Returns:
      The wrapped function.
  """

  @functools.wraps(func)
  def wrapped_function(
      input_files: dict[str, Any],
      parameters: dict[str, Any],
      workflow_parameters: dict[str, Any],
      dimensions_consumed: list[str],
      dimensions_mapping: dict[str, str],
      force_execution: bool = False,
      forward_retryable_error: bool = False,
  ) -> NodeOutput:
    """Returns the result of function func.

    This is either done by loading the result of a previous execution or
    performing that and storing its result.

    Args:
        input_files: The GCS inputs for function func.
        parameters: The non-GCS inputs for function func.
        workflow_parameters: Workflow-level parameters.
        dimensions_consumed: The input "dimensions" for which different values
          still mean they get processed by the same invocation of func.
        dimensions_mapping: Mapping to rename outputs to fit the subsequent
          workflow.
        force_execution: Flag allowing the execution despite existence of cached
          output.
        forward_retryable_error: Flag deciding whether to forward errors that
          are in principle retryable. A reason not to may be that the maximal
          number of attempts has been reached.

    Returns:
        The output of the (potentially earlier) call to func.
    """
    action_name = func.__module__.split('.')[-1]
    # Check if function actually needs to be called:
    input_checksum = util_checksum.compute_object_checksum(
        (input_files, parameters)
    )
    gcs = gcs_wrapper.GCS(
        action_name,
        input_checksum,
        workflow_parameters[Key.GCS_BUCKET.value],
        14,
    )
    filepath = f'{action_name}/{input_checksum}.json'
    file = gcs.gcs_bucket.blob(filepath)
    if not force_execution and file.exists():
      print(f'Reading cache {filepath}')
      # In case of cache-loading errors, treat the cache as non-existent:
      try:
        return json.loads(file.download_as_string())
      except Exception as e:  # pylint: disable=broad-exception-caught
        logger.warning('Failed to read cache file %s: %s', filepath, e)
    # Function needs to be called, so see if it works:
    try:
      output = _generic_function_caller(
          gcs, input_files, parameters, workflow_parameters, func
      )
    except Exception as e:  # pylint: disable=broad-exception-caught
      if forward_retryable_error and util_errors.is_retryable(e):
        raise
      return _generate_error_output(
          action_name,
          util_errors.get_compact_callstack('execute'),
          input_files,
          dimensions_consumed,
          dimensions_mapping,
      )
    if not isinstance(output, dict):
      raise TypeError(
          f'Action "{action_name}" must return a dict, got'
          f' {type(output).__name__}'
      )
    # Function worked, so process dimensions and cache output:
    final_output = util_dimensions.merge_dimensions(
        output,
        util_dimensions.get_dimensions(input_files, dimensions_consumed),
    )
    final_output = util_dimensions.rename_dimensions(
        final_output, dimensions_mapping
    )
    _update(file, final_output)
    print(f'Wrote file {filepath}')
    return final_output

  return wrapped_function


def action_pass(
    _: Any, input_files: dict[str, Any], _1: Any, _2: Any  # pylint: disable=invalid-name
) -> dict[str, Any]:
  """Passes on inputs as outputs, unchanged.

  This serves as a dummy action for the root and sink nodes.

  Args:
      _: not used
      input_files: The input to be forwarded as output.
      _1: not used
      _2: not used

  Returns:
    The value of input_files.
  """
  return input_files
