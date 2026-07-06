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

"""Loads the checked-in model allowlist (`ui/definitions/models.json`).

One shared loader so every reader parses the file the same way. It stays lenient
-- it drops underscore-prefixed documentation keys and does not check shape --
because the static test in CI is where shape is enforced.
"""

import copy
import functools
import json
import os

_ALLOWLIST_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'ui', 'definitions', 'models.json',
)


def _strip_underscore(obj):
  """Recursively drops keys beginning with '_' (documentation-only)."""
  if isinstance(obj, dict):
    return {k: _strip_underscore(v) for k, v in obj.items()
            if not (isinstance(k, str) and k.startswith('_'))}
  if isinstance(obj, list):
    return [_strip_underscore(v) for v in obj]
  return obj


@functools.lru_cache(maxsize=1)
def _parse_allowlist(path: str) -> dict:
  with open(path, encoding='utf-8') as f:
    return _strip_underscore(json.load(f))


def load_allowlist(path: str = _ALLOWLIST_PATH) -> dict:
  """Loads and returns the allowlist ({'actions': {...}, 'models': {...}}).

  Parsed once and cached, like actions.json. Callers get a deep copy so this
  security data can't be mutated process-wide by a stray writer. A
  missing/unparseable file raises here (startup failure), never per-request.
  """
  return copy.deepcopy(_parse_allowlist(path))


def models_for_action(action: str, allowlist: dict | None = None) -> list[str]:
  """Returns the model IDs allowed for `action`."""
  allowlist = allowlist or load_allowlist()
  return [mid for mid, m in allowlist['models'].items()
          if action in m.get('actions', [])]


def is_pair_allowed(action: str, model: str, location: str | None,
                    allowlist: dict | None = None) -> bool:
  """True iff `model` is allowed for `action` and (when the action has a
  location param) `location` is in the model's allowed locations."""
  allowlist = allowlist or load_allowlist()
  m = allowlist['models'].get(model)
  if m is None or action not in m.get('actions', []):
    return False
  action_spec = allowlist['actions'].get(action, {})
  if action_spec.get('location_param') is None:
    return True  # no location param on this action -> location not validated
  return location in m.get('locations', [])
