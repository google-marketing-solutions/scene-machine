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

"""Checks a workflow submission against the model allowlist.

Returns ``(message, code)`` for the first problem, or ``None`` if it passes.
Codes are stable so tests and the UI can branch on them without depending on the
wording.
"""

import functools
import json
import os
from typing import Any

from util.model_allowlist import is_pair_allowed, load_allowlist

_ACTIONS_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'ui', 'definitions', 'actions.json',
)

_MODEL_PARAM_NAMES = ('gemini_model', 'image_model', 'model')
_EXECUTION_ID = 'executionId'
_WORKFLOW_DEFINITION = 'workflowDefinition'


@functools.lru_cache(maxsize=1)
def _load_actions_json() -> dict:
  # Parsed once and cached, like the allowlist. A missing/unreadable file then
  # fails on the first load, not on every request at the trust boundary.
  with open(_ACTIONS_JSON, encoding='utf-8') as f:
    return json.load(f)


def _action_params(action: str, actions_json: dict) -> set[str]:
  action_def = actions_json.get(action, {})
  if not isinstance(action_def, dict):
    return set()
  return set(action_def.get('parameters') or {}) | set(action_def.get('input') or {})


def _model_param_name(action: str, actions_json: dict) -> str | None:
  for name in _MODEL_PARAM_NAMES:
    if name in _action_params(action, actions_json):
      return name
  return None


def validate_submission(
    data: Any,
    allowlist: dict | None = None,
    actions_json: dict | None = None,
) -> tuple[str, str] | None:
  """Returns ``(message, code)`` for the first problem, else ``None``. Stops at
  the first problem, in node order.

  This runs at the app's trust boundary, so it fails closed: any shape it can't
  make sense of is rejected as ``MALFORMED_SUBMISSION`` rather than passed on --
  a malformed node would otherwise crash the orchestrator with a 500."""
  allowlist = allowlist if allowlist is not None else load_allowlist()
  actions_json = actions_json if actions_json is not None else _load_actions_json()
  action_specs = allowlist['actions']
  models = allowlist['models']

  if not isinstance(data, dict):
    return ('submission is not an object', 'MALFORMED_SUBMISSION')

  # A resume payload carries an executionId and skips the store step. The
  # orchestrator branches on the key being present (any value, empty string
  # included), so match it: reject on presence, not truthiness.
  if _EXECUTION_ID in data:
    return ('executionId is not allowed on this route', 'EXECUTION_ID_NOT_ALLOWED')

  definition = data.get(_WORKFLOW_DEFINITION)
  if definition is None:
    definition = {}
  if not isinstance(definition, dict):
    return ('workflowDefinition is not an object', 'MALFORMED_SUBMISSION')

  for node_id, node in definition.items():
    if not isinstance(node, dict):
      return (f'Node {node_id!r} is not an object', 'MALFORMED_SUBMISSION')
    action = node.get('action')
    if not isinstance(action, str):
      return (f'Node {node_id!r} has a non-string action', 'MALFORMED_SUBMISSION')
    if action not in action_specs:
      continue  # only actions that take a model are checked here

    params = node.get('parameters')
    if params is None:
      params = {}
    if not isinstance(params, dict):
      return (f'Node {node_id!r} has non-object parameters', 'MALFORMED_SUBMISSION')

    model_param = _model_param_name(action, actions_json)
    model_value = params.get(model_param) if model_param else None
    model_list = model_value if isinstance(model_value, list) else [model_value]
    # Empty list, or any empty element, means no model was actually supplied.
    if not model_list or any(model is None or model == '' for model in model_list):
      return (f'Node {node_id!r}: {action} is missing its model ({model_param})',
              'MISSING_MODEL_PARAM')

    location_param = action_specs[action].get('location_param')
    locations = None
    if location_param is not None:
      location_value = params.get(location_param)
      locations = (location_value if isinstance(location_value, list)
                   else [location_value])
      # Empty list or empty element falls back to the infra region at run time,
      # so the checked pair would differ from what actually runs. Reject it.
      if not locations or any(
          location is None or location == '' for location in locations):
        return (f'Node {node_id!r}: {action} is missing its location '
                f'({location_param})', 'MISSING_MODEL_PARAM')

    for model in model_list:
      if (not isinstance(model, str) or model not in models
          or action not in models[model].get('actions', [])):
        return (f'Node {node_id!r}: {action} model {model!r} is not allowed',
                'MODEL_NOT_ALLOWED')
      if location_param is not None:
        for location in locations:
          if not is_pair_allowed(action, model, location, allowlist):
            return (f'Node {node_id!r}: {action} model {model!r} is not allowed '
                    f'in {location!r}', 'MODEL_LOCATION_PAIR_INVALID')
  return None
