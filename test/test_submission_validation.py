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

"""Unit tests for util.submission_validation.validate_submission.

Tests assert on the stable error CODE, never the message.
"""

import glob
import json
import os

from util.submission_validation import validate_submission

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _code(data):
  result = validate_submission(data)
  return result[1] if result is not None else None


def _sub(action='generate_video', params=None, **top):
  data = {'workflowDefinition': {'n': {'action': action, 'parameters': params or {}}}}
  data.update(top)
  return data


# --- the acceptance invariant: every shipped example must pass ---------------

def test_all_workflow_examples_pass():
  for path in glob.glob(os.path.join(_REPO, 'workflow_examples', '*.json')):
    with open(path, encoding='utf-8') as f:
      doc = json.load(f)
    assert validate_submission(doc) is None, f'{os.path.basename(path)} was rejected'


# --- each rejection code -----------------------------------------------------

def test_rogue_model():
  assert _code(_sub('generate_video',
                    {'model': 'rogue', 'gcp_location': 'global'})) == 'MODEL_NOT_ALLOWED'


def test_valid_model_disallowed_location():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_gemini_action_disallowed_location():
  # gemini-3.5-flash is allowed at global only; a Gemini-text action elsewhere
  # must reject. Guards the gemini_model_location gate (not just Veo's).
  assert _code(_sub('translate',
                    {'gemini_model': 'gemini-3.5-flash',
                     'gemini_model_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_image_action_disallowed_location():
  # Same for the image_model_location gate.
  assert _code(_sub('generate_image',
                    {'image_model': 'gemini-3-pro-image',
                     'image_model_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_execution_id_rejected():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': 'global'},
                    executionId='exec-123')) == 'EXECUTION_ID_NOT_ALLOWED'


def test_missing_model_param():
  assert _code(_sub('generate_video', {'gcp_location': 'global'})) == 'MISSING_MODEL_PARAM'


def test_missing_location_param():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001'})) == 'MISSING_MODEL_PARAM'


def test_empty_location_rejected():
  # Empty string would silently fall back to the infra region in the action.
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': ''})
              ) == 'MISSING_MODEL_PARAM'


def test_unknown_action_is_ignored():
  # This check only covers actions that take a model. An unknown action name is
  # the orchestrator's to reject.
  assert validate_submission(_sub('definitely_not_an_action', {})) is None


def test_list_model_with_one_bad_element():
  assert _code(_sub('generate_video',
                    {'model': ['veo-3.1-generate-001', 'rogue'], 'gcp_location': 'global'})
              ) == 'MODEL_NOT_ALLOWED'


def test_non_model_action_is_ignored():
  # A real but non-model-parameterized action (e.g. concat) is not validated.
  assert validate_submission(_sub('concat', {})) is None


def test_valid_generate_video_passes():
  assert validate_submission(
      _sub('generate_video',
           {'model': 'veo-3.1-fast-generate-001', 'gcp_location': 'us-central1'})) is None


# --- executionId: reject on presence, any value ------------------------------

def test_execution_id_falsy_still_rejected():
  # The orchestrator branches on the key being present, so a falsy value skips
  # the store step just like a real one. Every value must be rejected.
  valid = {'model': 'veo-3.1-generate-001', 'gcp_location': 'global'}
  for bad in ('', 0, False, None):
    data = _sub('generate_video', valid)
    data['executionId'] = bad
    assert _code(data) == 'EXECUTION_ID_NOT_ALLOWED', f'executionId={bad!r} slipped through'


# --- empty-list values must not fail open ------------------------------------

def test_empty_list_model_rejected():
  assert _code(_sub('generate_video',
                    {'model': [], 'gcp_location': 'global'})) == 'MISSING_MODEL_PARAM'


def test_empty_list_location_rejected():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': []})
              ) == 'MISSING_MODEL_PARAM'


def test_list_location_with_one_bad_element():
  # Exercises the location cross-product loop: a good + a disallowed location.
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001',
                     'gcp_location': ['global', 'europe-west4']})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_list_model_with_non_string_element():
  assert _code(_sub('generate_video',
                    {'model': ['veo-3.1-generate-001', 123], 'gcp_location': 'global'})
              ) == 'MODEL_NOT_ALLOWED'


# --- malformed shapes fail closed, not with a 500 ----------------------------

def test_non_dict_submission_rejected():
  assert validate_submission(['not', 'a', 'dict'])[1] == 'MALFORMED_SUBMISSION'


def test_non_dict_workflow_definition_rejected():
  assert validate_submission({'workflowDefinition': 'nope'})[1] == 'MALFORMED_SUBMISSION'


def test_non_dict_node_rejected():
  assert validate_submission(
      {'workflowDefinition': {'n': 'nope'}})[1] == 'MALFORMED_SUBMISSION'


def test_non_string_action_rejected():
  # An unhashable action (list/dict) used to crash the membership check.
  assert _code(_sub(['generate_video'], {})) == 'MALFORMED_SUBMISSION'


def test_non_dict_parameters_rejected():
  assert _code(_sub('generate_video', 'not-a-dict')) == 'MALFORMED_SUBMISSION'
