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

from util.model_allowlist import (
    is_pair_allowed,
    load_allowlist,
    models_for_action,
)

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ACTIONS_JSON = os.path.join(_REPO, 'ui', 'definitions', 'actions.json')
_CONFIG_TEMPLATE = os.path.join(_REPO, 'config.template.txt')
_CONFIG_TS = os.path.join(
    _REPO, 'ui', 'src', 'app', 'services', 'config', 'config.ts')

# Param names that mark a model-parameterized action in actions.json.
_MODEL_PARAM_NAMES = {'gemini_model', 'image_model', 'model'}

_MODELS = load_allowlist()  # through the shared loader (exercises it)
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

def test_parses_and_has_sections():
  assert 'actions' in _MODELS and 'models' in _MODELS


def test_defaults_reference_real_models_of_their_family():
  defaults = _MODELS.get('defaults', {})
  assert defaults, 'no defaults declared'
  for family, model_id in defaults.items():
    model = _MODELS['models'].get(model_id)
    assert model is not None, f'default {model_id!r} is not a real model'
    assert model['family'] == family, (
        f'default {model_id!r} is family {model["family"]!r}, not {family!r}')


def test_model_dates_valid_and_ordered():
  # release_date / retirement_date are ISO YYYY-MM-DD or null, and retirement
  # (the earliest-possible date) is after release when both are set.
  for mid, m in _MODELS['models'].items():
    dates = {}
    for field in ('release_date', 'retirement_date'):
      val = m.get(field)
      if val is None:
        continue
      dates[field] = datetime.date.fromisoformat(val)  # raises if malformed
    if 'release_date' in dates and 'retirement_date' in dates:
      assert dates['retirement_date'] > dates['release_date'], (
          f'{mid}: retirement_date must be after release_date')


def test_every_model_has_both_date_keys():
  # Present (possibly null) so a new model can't silently omit lifecycle data.
  for mid, m in _MODELS['models'].items():
    assert 'release_date' in m, f'{mid} missing release_date'
    assert 'retirement_date' in m, f'{mid} missing retirement_date'


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
      'veo-3.1-generate-001', 'veo-3.1-fast-generate-001'}
  assert 'gemini-3-pro-image' in models_for_action('generate_image')


def test_is_pair_allowed_location_gated():
  assert is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'us-central1')
  assert is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'global')
  assert not is_pair_allowed('generate_video', 'veo-3.1-generate-001', 'europe-west4')
  assert not is_pair_allowed('generate_video', 'rogue-model', 'global')
  # model not serving this action:
  assert not is_pair_allowed('generate_video', 'gemini-3-pro-image', 'global')


def test_is_pair_allowed_null_location_is_vacuous():
  # describe_image has no location param -> location is not validated.
  assert is_pair_allowed('describe_image', 'gemini-3.5-flash', 'any-region')
  assert is_pair_allowed('describe_image', 'gemini-3.5-flash', None)
  # but the model must still serve the action:
  assert not is_pair_allowed('describe_image', 'veo-3.1-generate-001', None)


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
  models' lines and the config.ts video-model dropdown. If one of these is not
  allowlisted, it is rejected for every user the moment enforcement is on."""
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
  with open(_CONFIG_TS, encoding='utf-8') as f:
    block = re.search(r'VIDEO_GENERATION_MODELS\s*=\s*\[(.*?)]', f.read(), re.DOTALL)
  assert block, 'VIDEO_GENERATION_MODELS array not found in config.ts (renamed?)'
  ids.update(re.findall(r"'([^']+)'", block.group(1)))
  return ids


def test_every_shipped_model_is_allowlisted():
  shipped = _shipped_models()
  assert shipped, 'parsed no shipped models -- config format changed'
  missing = shipped - set(_MODELS['models'])
  assert not missing, f'shipped but not allowlisted (outage on enforcement): {missing}'


def test_load_allowlist_returns_defensive_copy():
  a = load_allowlist()
  a['models'].clear()
  a['actions'].clear()
  b = load_allowlist()
  assert b['models'] and b['actions'], 'mutation leaked into the cached allowlist'


def test_validator_and_test_share_model_param_names():
  # The validator resolves the model param by name; this test decides which
  # actions are model-parameterized by the same names. Pin them together so the
  # two can't silently diverge and hide an action from both.
  from util.submission_validation import _MODEL_PARAM_NAMES as validator_names
  assert set(validator_names) == _MODEL_PARAM_NAMES
