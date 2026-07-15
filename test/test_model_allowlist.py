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

"""Static tests for the model allowlist (`ui/definitions/models.json`) and the
shared loader (`util/model_allowlist.py`).

Loads through the shared loader (not an independent parse) so the loader itself
is exercised and cannot drift from what the runtime uses. CI is the single
strictness point for the allowlist.
"""

import datetime
import glob
import json
import os
import re

from google.api_core.retry import Retry
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
import pytest

from util import model_allowlist
from util.model_allowlist import (
    is_pair_allowed,
    load_allowlist,
    load_allowlist_with_source,
    load_shipped_allowlist,
    models_for_action,
    validate_catalog_shape,
)

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ACTIONS_JSON = os.path.join(_REPO, 'ui', 'definitions', 'actions.json')
_CONFIG_TEMPLATE = os.path.join(_REPO, 'config.template.txt')

# Param names that mark a model-parameterized action in actions.json.
_MODEL_PARAM_NAMES = {'gemini_model', 'image_model', 'model'}

_MODELS = load_shipped_allowlist()  # the checked-in file; CI pins this one
with open(_ACTIONS_JSON, encoding='utf-8') as _f:
  _ACTIONS = json.load(_f)


def _action_param_names(action):
  d = _ACTIONS.get(action, {})
  if not isinstance(d, dict):
    return set()
  return set(d.get('parameters') or {}) | set(d.get('input') or {})


def _model_param_of(action):
  names = _action_param_names(action) & _MODEL_PARAM_NAMES
  return next(iter(names)) if names else None


def _model_parameterized_actions():
  return {name for name, d in _ACTIONS.items()
          if isinstance(d, dict) and _action_param_names(name) & _MODEL_PARAM_NAMES}


# --- allowlist structure -----------------------------------------------------

def test_shipped_catalog_passes_the_runtime_shape_check():
  # Sections, model-entry fields, and family-correct defaults -- via the same
  # function the app-role loader runs on live Firestore reads, so the shipped
  # file can never fail the runtime's own fallback rules.
  assert _MODELS.get('defaults'), 'no defaults declared'
  assert validate_catalog_shape(_MODELS, _MODELS['actions']) is None


def test_outpaint_models_cover_2k_and_4k():
  # The outpainter only ever requests 2K or 4K (outpainter.py _pick_image_size),
  # so any model serving outpaint_image must offer both.
  for mid, m in _MODELS['models'].items():
    if 'outpaint_image' in m['actions']:
      sizes = set(m.get('capabilities', {}).get('image_sizes', []))
      assert {'2K', '4K'} <= sizes, (
          f'{mid} serves outpaint_image but image_sizes {sizes} lacks 2K/4K')


def test_actions_section_matches_actions_json_bidirectional():
  # allowlist actions-section keys must EXACTLY equal the model-parameterized
  # actions in actions.json -- catches drift both ways.
  assert set(_MODELS['actions']) == _model_parameterized_actions()


def test_models_reference_real_actions():
  valid = set(_MODELS['actions'])
  for mid, m in _MODELS['models'].items():
    for action in m['actions']:
      assert action in valid, f'{mid} lists unknown action {action!r}'


def test_every_action_has_at_least_one_model():
  for action in _MODELS['actions']:
    assert any(action in m['actions'] for m in _MODELS['models'].values()), (
        f'no model serves action {action!r}')


def test_location_params_name_real_actions_json_params():
  for action, spec in _MODELS['actions'].items():
    lp = spec['location_param']
    if lp is None:
      continue
    assert lp in _action_param_names(action), (
        f'{action} location_param {lp!r} is not a real actions.json param')


# --- shared loader behaviour (previously untested) ---------------------------

def test_models_for_action():
  assert set(models_for_action('generate_video')) == {
      'veo-3.1-generate-001', 'veo-3.1-fast-generate-001',
      'veo-3.1-lite-generate-001'}
  assert 'gemini-3-pro-image' in models_for_action('generate_image')


def test_is_pair_allowed_location_gated():
  assert is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'us-central1')
  assert is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'global')
  assert not is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'europe-west4')
  assert not is_pair_allowed('generate_video', 'rogue-model', 'global')
  # model not serving this action:
  assert not is_pair_allowed('generate_video', 'gemini-3-pro-image', 'global')


# --- coverage: every literal (model, location) pair in workflow_examples ------

def _example_pairs():
  """Yields (file, action, model, location) for every literal model value
  submitted by a node in workflow_examples (lists expanded)."""
  for path in glob.glob(os.path.join(_REPO, 'workflow_examples', '*.json')):
    with open(path, encoding='utf-8') as f:
      doc = json.load(f)
    nodes = (doc.get('workflowDefinition') or {}) if isinstance(doc, dict) else {}
    for node in nodes.values():
      if not isinstance(node, dict):
        continue
      action = node.get('action')
      if action not in _MODELS['actions']:
        continue
      params = node.get('parameters') or {}
      mp = _model_param_of(action)
      lp = _MODELS['actions'][action]['location_param']
      model = params.get(mp)
      location = params.get(lp) if lp else None
      models = model if isinstance(model, list) else [model]
      for m in models:
        if isinstance(m, str):  # only literal model values are statically checkable
          yield (os.path.basename(path), action, m, location)


def test_workflow_example_pairs_are_allowed():
  # Per-node (model, location) pair check -- strictly stronger than a union:
  # forces us-central1 into the Veo entries, and catches a wrong per-model pair.
  bad = [(f, a, m, loc) for (f, a, m, loc) in _example_pairs()
         if not is_pair_allowed(a, m, loc)]
  assert not bad, f'workflow_examples submit disallowed (action, model, location): {bad}'


# --- drift guard: every model the product ships must be allowlisted ----------

_MODEL_ID_RE = re.compile(r'^[a-z][a-z0-9.]*-[a-z0-9.\-]+$')


def _shipped_models():
  """Model IDs the product actually offers: config.template.txt 'Recommended
  models' lines. (The UI dropdown reads the catalog from /api/config, so it
  can no longer drift.) If one of these is not allowlisted, it is rejected
  for every user the moment enforcement is on."""
  ids = set()
  with open(_CONFIG_TEMPLATE, encoding='utf-8') as f:
    for line in f:
      _, sep, rest = line.partition('Recommended models:')
      if not sep:
        continue
      for token in rest.split(','):
        token = re.sub(r'\(.*?\)', '', token).strip()  # drop "(Nano Banana Pro)"
        if _MODEL_ID_RE.match(token):
          ids.add(token)
  return ids


def test_every_shipped_model_is_allowlisted():
  shipped = _shipped_models()
  assert shipped, 'parsed no shipped models -- config format changed'
  missing = shipped - set(_MODELS['models'])
  assert not missing, f'shipped but not allowlisted (outage on enforcement): {missing}'


def test_load_shipped_allowlist_returns_defensive_copy():
  a = load_shipped_allowlist()
  a['models'].clear()
  a['actions'].clear()
  b = load_shipped_allowlist()
  assert b['models'] and b['actions'], 'mutation leaked into the cached allowlist'


def test_validator_and_test_share_model_param_names():
  # The validator resolves the model param by name; this test decides which
  # actions are model-parameterized by the same names. Pin them together so the
  # two can't silently diverge and hide an action from both.
  from util.submission_validation import _MODEL_PARAM_NAMES as validator_names
  assert set(validator_names) == _MODEL_PARAM_NAMES


# --- runtime source: the live config/models doc (ROLE=app only) ---------------

def _live_catalog_with_hotfix():
  catalog = load_shipped_allowlist()
  catalog['models']['veo-live-hotfix'] = {
      'family': 'veo', 'actions': ['generate_video'],
      'locations': ['global'], 'capabilities': {}}
  return catalog


def test_app_role_serves_the_live_catalog(monkeypatch):
  monkeypatch.setenv('ROLE', 'app')
  monkeypatch.setattr(
      model_allowlist, '_fetch_live_catalog', _live_catalog_with_hotfix)
  catalog, source = load_allowlist_with_source()
  assert source == 'firestore'
  assert 'veo-live-hotfix' in catalog['models']


def test_app_role_falls_back_on_a_fetch_error(monkeypatch, caplog):
  monkeypatch.setenv('ROLE', 'app')
  def unreachable():
    raise RuntimeError('firestore down')
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', unreachable)
  catalog, source = load_allowlist_with_source()
  assert source == 'shipped'
  assert catalog == load_shipped_allowlist()
  assert 'config/models unusable' in caplog.text
  record = next(
      record for record in caplog.records
      if 'config/models unusable' in record.getMessage())
  assert record.exc_info is not None


def test_app_role_falls_back_on_a_malformed_doc(monkeypatch, caplog):
  monkeypatch.setenv('ROLE', 'app')
  monkeypatch.setattr(
      model_allowlist, '_fetch_live_catalog', lambda: {'models': 'oops'})
  _, source = load_allowlist_with_source()
  assert source == 'shipped'
  assert 'not an object' in caplog.text
  record = next(
      record for record in caplog.records
      if 'config/models unusable' in record.getMessage())
  assert record.exc_info is None


def test_live_catalog_read_has_short_sdk_retry_and_rpc_timeouts(monkeypatch):
  client = firestore.Client(
      project='test-project',
      credentials=AnonymousCredentials(),
      database='test-database',
  )
  captured = {}

  def empty_batch_get(*, request, metadata, retry, timeout):
    captured.update(
        request=request, metadata=metadata, retry=retry, timeout=timeout)
    return iter(())

  monkeypatch.setattr(
      client._firestore_api, 'batch_get_documents', empty_batch_get)
  monkeypatch.setattr(model_allowlist, '_get_catalog_db', lambda: client)

  with pytest.raises(LookupError, match='not seeded'):
    model_allowlist._fetch_live_catalog()

  assert captured['timeout'] == 2.0
  assert isinstance(captured['retry'], Retry)
  assert captured['retry'].timeout == 3.0


def test_app_role_rejects_a_tampered_actions_section(monkeypatch, caplog):
  monkeypatch.setenv('ROLE', 'app')
  def tampered():
    catalog = load_shipped_allowlist()
    catalog['actions'] = {}
    return catalog
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', tampered)
  _, source = load_allowlist_with_source()
  assert source == 'shipped'
  assert "'actions' differs" in caplog.text


def test_other_roles_never_touch_firestore(monkeypatch):
  # Counted, not raised: an exception sentinel would be swallowed by the
  # loader's catch-everything fallback and the test would pass vacuously.
  calls = []
  def counting():
    calls.append(1)
    return _live_catalog_with_hotfix()
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', counting)
  for role in ('worker', 'all'):
    monkeypatch.setenv('ROLE', role)
    assert load_allowlist_with_source()[1] == 'shipped'
  monkeypatch.delenv('ROLE')
  assert load_allowlist_with_source()[1] == 'shipped'
  assert not calls, 'only ROLE=app may read Firestore'


def test_app_role_fetches_fresh_per_call(monkeypatch):
  # Live edits apply on the next submission; there is no cache to invalidate.
  calls = []
  def counting():
    calls.append(1)
    return _live_catalog_with_hotfix()
  monkeypatch.setenv('ROLE', 'app')
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', counting)
  load_allowlist()
  load_allowlist()
  assert len(calls) == 2


# --- validate_catalog_shape: what a console edit must satisfy -----------------

def test_shape_rejects_a_non_object():
  assert validate_catalog_shape('nope', _MODELS['actions'])


def test_shape_rejects_missing_sections():
  for section in ('defaults', 'actions', 'models'):
    catalog = load_shipped_allowlist()
    del catalog[section]
    problem = validate_catalog_shape(catalog, _MODELS['actions'])
    assert problem and section in problem


def test_shape_rejects_malformed_model_entries():
  mutations = (
      lambda m: 'not-an-object',
      lambda m: {**m, 'family': None},
      lambda m: {**m, 'actions': 'generate_video'},
      lambda m: {**m, 'locations': [1]},
      lambda m: {**m, 'capabilities': 'fast'},
  )
  for mutate in mutations:
    catalog = load_shipped_allowlist()
    catalog['models']['veo-3.1-generate-001'] = mutate(
        catalog['models']['veo-3.1-generate-001'])
    assert validate_catalog_shape(catalog, _MODELS['actions'])


def test_shape_requires_capabilities():
  catalog = load_shipped_allowlist()
  del catalog['models']['veo-3.1-generate-001']['capabilities']

  problem = validate_catalog_shape(catalog, _MODELS['actions'])

  assert problem and 'capabilities' in problem


def test_shape_rejects_broken_defaults():
  catalog = load_shipped_allowlist()
  catalog['defaults']['veo'] = 'not-a-model'
  assert 'not in models' in validate_catalog_shape(catalog, _MODELS['actions'])
  catalog = load_shipped_allowlist()
  catalog['defaults']['veo'] = 'gemini-3.5-flash'  # real model, wrong family
  assert 'family' in validate_catalog_shape(catalog, _MODELS['actions'])


def test_shape_rejects_firestore_only_values_anywhere():
  # A console edit can add a timestamp/bytes field in spots the structural
  # checks don't pin. Such a doc must be rejected wholesale: it would crash
  # json serialization wherever the catalog is served.
  timestamp = datetime.datetime(2026, 7, 1)
  for plant in (
      lambda c: c.__setitem__('updated_at', timestamp),  # extra top-level key
      lambda c: c['models']['veo-3.1-generate-001']['capabilities']
      .__setitem__('added_at', timestamp),               # capability value
      lambda c: c['models']['veo-3.1-generate-001']
      .__setitem__('note', [b'bytes']),                  # extra model field
  ):
    catalog = load_shipped_allowlist()
    plant(catalog)
    problem = validate_catalog_shape(catalog, _MODELS['actions'])
    assert problem and 'non-JSON' in problem


def test_shape_rejects_non_finite_floats():
  for value in (float('nan'), float('inf'), float('-inf')):
    catalog = load_shipped_allowlist()
    catalog['models']['veo-3.1-generate-001']['capabilities']['limit'] = value

    problem = validate_catalog_shape(catalog, _MODELS['actions'])

    assert problem and 'non-finite float' in problem


def test_shape_rejects_non_boolean_capability_flags():
  # veo.generate applies these with `is True`; a console-edited string
  # "false" must reject the doc, not silently disable the behavior.
  for flag in ('supports_audio', 'enhance_prompt_locked'):
    catalog = load_shipped_allowlist()
    catalog['models']['veo-3.1-generate-001']['capabilities'][flag] = 'false'
    problem = validate_catalog_shape(catalog, _MODELS['actions'])
    assert problem and 'boolean' in problem


def test_shape_allows_json_typed_extra_fields():
  # Extra keys that are plain JSON are harmless (e.g. _notes strings) and
  # must not reject the doc.
  catalog = load_shipped_allowlist()
  catalog['_notes'] = 'operator scratch note'
  assert validate_catalog_shape(catalog, _MODELS['actions']) is None
