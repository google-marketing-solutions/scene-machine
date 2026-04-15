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

"""Offers error-related functions."""

import os
import sys
import traceback

from google.api_core import exceptions as google_exceptions


TOO_MANY_REQUESTS = 429


def get_compact_callstack(start_function_name: str) -> str:
  """Returns a compact version of the current call stack.

  Args:
    start_function_name: name of the function from which to start output

  Returns:
    the compact callstack
  """
  exc_type, exc_value, exc_trace = sys.exc_info()
  trace = traceback.extract_tb(exc_trace)
  exc_name = exc_type.__name__ if exc_type else type(exc_value)
  errorstring = f'{exc_name}: {exc_value}:'  # pyright: ignore [reportOptionalMemberAccess] pylint: disable = line-too-long
  found = None
  for filepath, lineno, funcname, _ in trace:
    filename = os.path.basename(filepath)
    if funcname == start_function_name or (found is not None and found < 3):
      found = found + 1 if found is not None else 1
      errorstring += f' {filename}:{funcname}:{lineno}'
  return errorstring


def is_retryable(e: Exception) -> bool:
  """Checks if the given exception is retryable.

  Args:
    e: Exception to check

  Returns:
    True if the exception is retryable, False otherwise
  """
  code_attr = getattr(e, 'code', None)
  return any([
      isinstance(e, google_exceptions.ResourceExhausted),
      getattr(e, 'status_code', None) == TOO_MANY_REQUESTS,
      callable(code_attr)
      and getattr(code_attr(), 'value', None) == TOO_MANY_REQUESTS,
      # Removed because this would need to be retried much later:
      # isinstance(e, RuntimeError) and 'try again later' in repr(e).lower(),
  ])
