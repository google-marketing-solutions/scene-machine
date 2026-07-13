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

"""Tests for scripts/seed_config_models.py (the config/models deploy seed)."""

import json
import os

import pytest

from scripts import seed_config_models

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODELS_JSON = os.path.join(_REPO, 'ui', 'definitions', 'models.json')


def test_to_typed_scalars():
  assert seed_config_models.to_typed('x') == {'stringValue': 'x'}
  assert seed_config_models.to_typed(8) == {'integerValue': '8'}
  assert seed_config_models.to_typed(1.5) == {'doubleValue': 1.5}
  assert seed_config_models.to_typed(None) == {'nullValue': None}


def test_to_typed_bool_is_not_an_integer():
  assert seed_config_models.to_typed(True) == {'booleanValue': True}
  assert seed_config_models.to_typed(False) == {'booleanValue': False}


def test_to_typed_nested():
  assert seed_config_models.to_typed({'a': [1, 'b']}) == {
      'mapValue': {'fields': {'a': {'arrayValue': {'values': [
          {'integerValue': '1'}, {'stringValue': 'b'}]}}}}
  }


def test_to_typed_rejects_non_json():
  with pytest.raises(TypeError):
    seed_config_models.to_typed(object())


def test_from_typed_tolerates_empty_array_and_map():
  assert seed_config_models.from_typed({'arrayValue': {}}) == []
  assert seed_config_models.from_typed({'mapValue': {}}) == {}


def test_from_typed_renders_firestore_only_types_as_markers():
  # A console edit can hold types the repo file never can (timestamp, bytes).
  # They must not crash the preview; the diff reports them as overwritten.
  assert seed_config_models.from_typed(
      {'timestampValue': '2026-07-01T00:00:00Z'}
  ) == '<firestore timestampValue>'


def test_round_trip_preserves_the_real_catalog():
  with open(_MODELS_JSON, encoding='utf-8') as f:
    catalog = json.load(f)
  document = seed_config_models.plain_to_document(catalog)
  assert seed_config_models.document_to_plain(document) == catalog


def test_dotted_model_ids_stay_plain_map_keys():
  document = seed_config_models.plain_to_document(
      {'models': {'gemini-3.5-flash': {'family': 'gemini'}}})
  fields = document['fields']['models']['mapValue']['fields']
  assert 'gemini-3.5-flash' in fields


def test_diff_identical_is_empty():
  catalog = {'models': {'m': {'family': 'veo'}}, 'defaults': {'veo': 'm'}}
  assert seed_config_models.diff_lines(catalog, catalog) == []


def test_diff_names_added_removed_and_changed_models():
  repo = {'models': {'kept': {'family': 'veo', 'locations': ['global']},
                     'new': {'family': 'veo'}}}
  live = {'models': {'kept': {'family': 'veo', 'locations': ['us-central1']},
                     'hotfix': {'family': 'veo'}}}
  lines = seed_config_models.diff_lines(repo, live)
  assert any(line.startswith('+ will add models.new') for line in lines)
  assert any(line.startswith('- will remove models.hotfix') for line in lines)
  assert any('will change models.kept (locations)' in line for line in lines)


def test_diff_scalar_default_change_shows_both_values():
  lines = seed_config_models.diff_lines(
      {'defaults': {'veo': 'a'}}, {'defaults': {'veo': 'b'}})
  assert lines == ["~ will change defaults.veo: 'b' -> 'a'"]


def test_diff_reports_a_live_only_null_field():
  lines = seed_config_models.diff_lines(
      {'models': {}}, {'models': {}, 'note': None})
  assert lines == ["- will remove section 'note' (exists only live)"]


def test_diff_reports_a_boolean_vs_integer_type_change():
  # Python's == calls True == 1 equal; Firestore types are distinct and the
  # seed rewrites them, so the preview must not claim "changes nothing".
  lines = seed_config_models.diff_lines(
      {'models': {'m': {'supports_audio': True}}},
      {'models': {'m': {'supports_audio': 1}}})
  assert lines == ['~ will change models.m (supports_audio)']


def test_diff_reports_an_integer_vs_double_type_change():
  lines = seed_config_models.diff_lines(
      {'models': {'m': {'duration': 4}}},
      {'models': {'m': {'duration': 4.0}}})
  assert lines == ['~ will change models.m (duration)']


def test_diff_names_a_null_only_subfield_change():
  lines = seed_config_models.diff_lines(
      {'models': {'m': {'family': 'veo'}}},
      {'models': {'m': {'family': 'veo', 'note': None}}})
  assert lines == ['~ will change models.m (note)']


def test_diff_labels_one_sided_sections_as_add_or_remove():
  assert seed_config_models.diff_lines({'defaults': {}}, {}) == [
      "+ will add section 'defaults'"]
  assert seed_config_models.diff_lines({}, {'ops_flags': ['x']}) == [
      "- will remove section 'ops_flags' (exists only live)"]


def test_cli_convert_round_trips_stdin(capsys, monkeypatch):
  monkeypatch.setattr('sys.stdin', __import__('io').StringIO('{"a": true}'))
  assert seed_config_models.main(['prog', 'convert']) == 0
  out = json.loads(capsys.readouterr().out)
  assert out == {'fields': {'a': {'booleanValue': True}}}


def test_cli_diff_unreadable_live_doc_degrades(tmp_path, capsys):
  repo = tmp_path / 'repo.json'
  repo.write_text('{"models": {}}')
  missing = tmp_path / 'nope.json'
  assert seed_config_models.main(['prog', 'diff', str(repo),
                                  str(missing)]) == 0
  assert 'seeds it from the repo' in capsys.readouterr().out


def test_cli_diff_malformed_live_doc_degrades(tmp_path, capsys):
  repo = tmp_path / 'repo.json'
  repo.write_text('{"models": {}}')
  for content in ('not json', '[1, 2]'):  # invalid JSON; JSON but not a doc
    garbage = tmp_path / 'live.json'
    garbage.write_text(content)
    assert seed_config_models.main(['prog', 'diff', str(repo),
                                    str(garbage)]) == 0
    assert 'seeds it from the repo' in capsys.readouterr().out


def test_cli_diff_live_doc_with_firestore_only_types_never_blocks(
    tmp_path, capsys):
  repo = tmp_path / 'repo.json'
  repo.write_text(json.dumps({'models': {}}))
  live = tmp_path / 'live.json'
  live.write_text(json.dumps({'fields': {
      'models': {'mapValue': {'fields': {}}},
      'lastEdited': {'timestampValue': '2026-07-01T00:00:00Z'},
  }}))
  assert seed_config_models.main(['prog', 'diff', str(repo), str(live)]) == 0
  out = capsys.readouterr().out
  assert "- will remove section 'lastEdited'" in out


def test_cli_diff_reports_live_only_edit(tmp_path, capsys):
  repo = tmp_path / 'repo.json'
  repo.write_text(json.dumps({'models': {}}))
  live = tmp_path / 'live.json'
  live.write_text(json.dumps(seed_config_models.plain_to_document(
      {'models': {'operator-added': {'family': 'veo'}}})))
  assert seed_config_models.main(['prog', 'diff', str(repo), str(live)]) == 0
  out = capsys.readouterr().out
  assert 'do not survive a deploy' in out
  assert '- will remove models.operator-added' in out


def test_cli_diff_no_changes_message(tmp_path, capsys):
  catalog = {'models': {'m': {'family': 'veo'}}}
  repo = tmp_path / 'repo.json'
  repo.write_text(json.dumps(catalog))
  live = tmp_path / 'live.json'
  live.write_text(json.dumps(seed_config_models.plain_to_document(catalog)))
  assert seed_config_models.main(['prog', 'diff', str(repo), str(live)]) == 0
  assert 'changes nothing' in capsys.readouterr().out


def test_cli_usage_error():
  assert seed_config_models.main(['prog']) == 2
