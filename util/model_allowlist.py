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

"""Loads the model allowlist.

One shared loader so every reader gets the catalog the same way. Two sources:

  - the checked-in `ui/definitions/models.json` (the shipped file), and
  - in the app service only (`ROLE=app`), the live `config/models` Firestore
    document, which every deploy seeds from the shipped file and operators may
    edit between deploys.

The live doc is fetched fresh per call (edits apply immediately; submissions
are human-paced, so the read volume matches /api/config's per-request reads)
and shape-checked before use. Any problem -- no Firestore access, unseeded
doc, malformed edit -- logs one error and falls back to the shipped file, so a
bad console edit can degrade freshness but never take validation down.

The worker deliberately stays on the shipped file: it has no access to the UI
database (deploy.sh sets no FIRESTORE_DB_UI on it), and execution behavior
stays deterministic per deploy. A live capability edit therefore changes what
the validator accepts immediately, but worker behavior only at the next
deploy. Local dev is the exception because everything there runs in one
ROLE=app process, including in-process actions.
"""

import copy
import functools
import json
import logging
import math
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
  # Never imported at runtime: the deploy-time check runs this module on
  # machines that only have the stdlib.
  from google.cloud import firestore

logger = logging.getLogger(__name__)

_ALLOWLIST_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'ui', 'definitions', 'models.json',
)
_LIVE_CATALOG_RPC_TIMEOUT_SECONDS = 2.0
_LIVE_CATALOG_RETRY_TIMEOUT_SECONDS = 3.0

_catalog_db = None


@functools.lru_cache(maxsize=1)
def _parse_allowlist(path: str) -> dict:
  with open(path, encoding='utf-8') as f:
    return json.load(f)


def load_shipped_allowlist(path: str = _ALLOWLIST_PATH) -> dict:
  """Loads the checked-in allowlist ({'actions': ..., 'models': ...}).

  Parsed once and cached, like actions.json. Callers get a deep copy so this
  security data can't be mutated process-wide by a stray writer. A
  missing/unparseable file raises here (startup failure), never per-request.
  """
  return copy.deepcopy(_parse_allowlist(path))


def _get_catalog_db() -> 'firestore.Client':
  global _catalog_db
  if _catalog_db is None:
    # Imported here, not at module top: the deploy-time check imports this
    # module on machines that only have the stdlib.
    from google.cloud import firestore
    _catalog_db = firestore.Client(database=os.environ['FIRESTORE_DB_UI'])
  return _catalog_db


def _fetch_live_catalog() -> dict:
  from google.api_core import retry as api_retry

  snapshot = _get_catalog_db().collection('config').document('models').get(
      retry=api_retry.Retry(
          initial=0.1,
          maximum=0.5,
          multiplier=2.0,
          timeout=_LIVE_CATALOG_RETRY_TIMEOUT_SECONDS,
      ),
      timeout=_LIVE_CATALOG_RPC_TIMEOUT_SECONDS,
  )
  if not snapshot.exists:
    raise LookupError('config/models is not seeded')
  return snapshot.to_dict()


def _first_non_json_value(value: object, path: str) -> str | None:
  """The path of a value that is not plain JSON, or None.

  A console edit can introduce Firestore-only types (timestamp, bytes,
  geopoint, reference) anywhere -- including spots the structural checks
  don't pin, like capability values or extra keys. Those survive to_dict()
  as SDK objects and would crash json serialization downstream, so the
  whole catalog must be JSON-typed.
  """
  if isinstance(value, float) and not math.isfinite(value):
    return f'{path} (non-finite float)'
  if value is None or isinstance(value, (bool, int, float, str)):
    return None
  if isinstance(value, list):
    for index, item in enumerate(value):
      found = _first_non_json_value(item, f'{path}[{index}]')
      if found:
        return found
    return None
  if isinstance(value, dict):
    for key, item in value.items():
      if not isinstance(key, str):
        return f'{path}.{key!r} (non-string key)'
      found = _first_non_json_value(item, f'{path}.{key}')
      if found:
        return found
    return None
  return f'{path} ({type(value).__name__})'


def validate_catalog_shape(catalog: object, shipped_actions: dict) -> str | None:
  """Returns why `catalog` is unusable, or None if it is well-formed.

  Console edits get no CI, so the runtime applies the structural rules the
  validator and its consumers depend on (a subset of the CI tests, which call
  this function too so the two cannot drift). The `actions` section must
  equal the shipped one exactly: it is wiring to actions.json param names,
  not operator data.
  """
  if not isinstance(catalog, dict):
    return 'catalog is not an object'
  non_json = _first_non_json_value(catalog, 'catalog')
  if non_json:
    return f'contains a non-JSON value at {non_json}'
  for section in ('defaults', 'actions', 'models'):
    if not isinstance(catalog.get(section), dict):
      return f'{section!r} is missing or not an object'
  for mid, model in catalog['models'].items():
    if not isinstance(model, dict):
      return f'model {mid!r} is not an object'
    if not isinstance(model.get('family'), str):
      return f'model {mid!r} has no family string'
    for field in ('actions', 'locations'):
      values = model.get(field)
      if (not isinstance(values, list)
          or not all(isinstance(v, str) for v in values)):
        return f'model {mid!r}: {field!r} is not a list of strings'
    capabilities = model.get('capabilities')
    if not isinstance(capabilities, dict):
      return f'model {mid!r}: capabilities is missing or not an object'
    # veo.generate applies these with `is True`; a string "false" is a
    # console-edit mistake, not a policy. Required-and-boolean is the
    # snapshot PR's job; present-implies-boolean holds the line here.
    for flag in ('supports_audio', 'enhance_prompt_locked', 'audio_always_on'):
      flag_value = capabilities.get(flag)
      if flag_value is not None and not isinstance(flag_value, bool):
        return f'model {mid!r}: {flag} must be a boolean'
    for field in ('allowed_aspect_ratios', 'allowed_resolutions'):
      values = capabilities.get(field)
      if values is not None and (
          not isinstance(values, list)
          or not all(isinstance(v, str) for v in values)
      ):
        return f'model {mid!r}: {field!r} is not a list of strings'
    # Non-string keys never reach here: _first_non_json_value above already
    # rejects them (a live edit's map keys are always strings).
    duration_by_resolution = capabilities.get('duration_by_resolution')
    if duration_by_resolution is not None and (
        not isinstance(duration_by_resolution, dict)
        or not all(
            isinstance(durations, list)
            and all(
                isinstance(d, int) and not isinstance(d, bool)
                for d in durations
            )
            for durations in duration_by_resolution.values()
        )
    ):
      return (
          f'model {mid!r}: duration_by_resolution is not a dict of string to'
          ' list of ints'
      )
  for family, mid in catalog['defaults'].items():
    model = catalog['models'].get(mid)
    if model is None:
      return f'default {mid!r} ({family!r}) is not in models'
    if model.get('family') != family:
      return f'default {mid!r} is family {model.get("family")!r}, not {family!r}'
  if catalog['actions'] != shipped_actions:
    return ("'actions' differs from the shipped file; it is wiring to the "
            'code, not operator data -- change it in the repo')
  return None


def load_allowlist_with_source() -> tuple[dict, str]:
  """The allowlist plus where it came from: 'firestore' or 'shipped'."""
  if os.environ.get('ROLE', 'all') == 'app':
    try:
      catalog = _fetch_live_catalog()
    except Exception as error:  # any read failure -> last-known-good file
      logger.exception(
          'config/models unusable (%s); serving the shipped allowlist', error)
      return load_shipped_allowlist(), 'shipped'
    try:
      problem = validate_catalog_shape(
          catalog, _parse_allowlist(_ALLOWLIST_PATH)['actions'])
    except Exception as error:  # unexpected validation failure -> safe fallback
      logger.exception(
          'config/models unusable (%s); serving the shipped allowlist', error)
      return load_shipped_allowlist(), 'shipped'
    if problem:
      logger.error(
          'config/models unusable (%s); serving the shipped allowlist', problem)
      return load_shipped_allowlist(), 'shipped'
    return catalog, 'firestore'
  return load_shipped_allowlist(), 'shipped'


def load_allowlist() -> dict:
  """The allowlist every runtime reader should use (source per module doc)."""
  return load_allowlist_with_source()[0]


def models_for_action(action: str, allowlist: dict | None = None) -> list[str]:
  """Returns the model IDs allowed for `action`."""
  allowlist = allowlist or load_allowlist()
  return [model_id for model_id, entry in allowlist['models'].items()
          if action in entry.get('actions', [])]


def is_pair_allowed(action: str, model: str, location: str | None,
                    allowlist: dict | None = None) -> bool:
  """True if `model` is allowed for `action` and (when the action has a
  location param) `location` is in the model's allowed locations."""
  allowlist = allowlist or load_allowlist()
  entry = allowlist['models'].get(model)
  if entry is None or action not in entry.get('actions', []):
    return False
  action_spec = allowlist['actions'].get(action, {})
  if action_spec.get('location_param') is None:
    return True  # no location param on this action -> location not validated
  return location in entry.get('locations', [])
