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

"""Tests for scripts/validate_config_models.py (the deploy-time model check)."""

import os
import re

from scripts import validate_config_models
from util.model_allowlist import load_allowlist

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_MODELS = {
    'gemini-3.5-flash': {'family': 'gemini', 'locations': ['global']},
    'gemini-3-pro-image': {'family': 'image', 'locations': ['global']},
    'veo-3.1-generate-001': {'family': 'veo', 'locations': ['global', 'us-central1']},
}


def _parse_shell_env(path: str) -> dict[str, str]:
  """Reads `VAR=value` / `export VAR=value` assignments from a shell file,
  dropping inline `# comments` -- so the test uses the template's real values."""
  env = {}
  with open(path, encoding='utf-8') as f:
    for line in f:
      match = re.match(r'\s*(?:export\s+)?([A-Z_]+)=(.*)', line)
      if match:
        value = match.group(2).split(' #', 1)[0].strip().strip('"\'')
        env[match.group(1)] = value
  return env


def test_valid_config_passes():
  env = {
      'GEMINI_MODEL': 'gemini-3.5-flash', 'GEMINI_REGION': 'global',
      'IMAGE_MODEL': 'gemini-3-pro-image', 'IMAGE_MODEL_REGION': 'global',
      'VEO_MODEL': 'veo-3.1-generate-001', 'VEO_REGION': 'us-central1',
  }
  assert validate_config_models.collect_errors(env, _MODELS) == []


def test_unknown_model_flagged():
  errors = validate_config_models.collect_errors(
      {'VEO_MODEL': 'veo-does-not-exist', 'VEO_REGION': 'global'}, _MODELS)
  assert any('not in the allowlist' in e for e in errors)


def test_disallowed_region_flagged():
  errors = validate_config_models.collect_errors(
      {'GEMINI_MODEL': 'gemini-3.5-flash', 'GEMINI_REGION': 'europe-west4'},
      _MODELS)
  assert any('not allowed' in e for e in errors)


def test_wrong_family_flagged():
  # A gemini model configured as the Veo model.
  errors = validate_config_models.collect_errors(
      {'VEO_MODEL': 'gemini-3.5-flash', 'VEO_REGION': 'global'}, _MODELS)
  assert any('not' in e and "'veo'" in e for e in errors)


def test_unconfigured_var_is_skipped():
  assert validate_config_models.collect_errors({}, _MODELS) == []


def test_model_set_without_region_flagged():
  # A model configured with no region can't be reached; catch it at deploy time
  # rather than skipping the check.
  errors = validate_config_models.collect_errors(
      {'VEO_MODEL': 'veo-3.1-generate-001'}, _MODELS)
  assert any('region is required' in e for e in errors)


def test_config_template_defaults_pass_real_allowlist():
  # The actual config.template.txt defaults must validate against the shipped
  # allowlist -- parsed from the file, not hard-coded, so a drifted default
  # (e.g. a model bumped in the template but not the allowlist) fails here.
  env = _parse_shell_env(os.path.join(_REPO, 'config.template.txt'))
  assert validate_config_models.collect_errors(
      env, load_allowlist()['models']) == []
