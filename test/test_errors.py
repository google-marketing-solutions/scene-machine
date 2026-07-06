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

"""Tests for util.errors.is_retryable.

Uses REAL exception instances (not monkeypatched predicates) so the classifier
is checked against the shapes the SDKs actually raise.
"""

import google.api_core.exceptions as google_exceptions
from google.genai import errors as genai_errors

from util.errors import is_retryable


def _genai_error(status_code):
  """A real google-genai APIError as the client raises it for an HTTP error.

  4xx -> ClientError; `.code` is the integer HTTP status (there is no
  `.status_code` attribute).
  """
  return genai_errors.ClientError(
      status_code,
      {
          'error': {
              'code': status_code,
              'status': 'RESOURCE_EXHAUSTED',
              'message': 'quota exceeded',
          }
      },
      None,
  )


def test_genai_429_is_retryable():
  # Regression: genai's APIError has an integer `.code` and no `.status_code`,
  # so before the fix a 429 was misclassified as non-retryable.
  e = _genai_error(429)
  assert getattr(e, 'code', None) == 429
  assert getattr(e, 'status_code', None) is None
  assert is_retryable(e) is True


def test_genai_400_is_not_retryable():
  assert is_retryable(_genai_error(400)) is False


def test_api_core_resource_exhausted_is_retryable():
  assert is_retryable(google_exceptions.ResourceExhausted('quota')) is True


def test_api_core_too_many_requests_is_retryable():
  # HTTP 429: not a ResourceExhausted, and `.code` is an HTTPStatus (not a plain
  # int), so this only passes via the integer-like `code` branch.
  e = google_exceptions.TooManyRequests('quota')
  assert getattr(e, 'status_code', None) is None
  assert is_retryable(e) is True


def test_plain_exception_is_not_retryable():
  assert is_retryable(ValueError('nope')) is False
