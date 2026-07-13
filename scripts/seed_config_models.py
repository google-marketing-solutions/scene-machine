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

"""Converts the repo model catalog for the Firestore REST API and previews
what seeding will change.

deploy.sh overwrites the `config/models` document from
`ui/definitions/models.json` on every deploy (the repo is the source of
truth), so a live console edit does not survive a deploy. This script does the
two parts bash can't:

  convert           read plain JSON on stdin, write a Firestore REST document
                    ({"fields": ...} typed-value JSON) on stdout for
                    `curl -d @-`.
  diff REPO LIVE    print what overwriting LIVE (a document fetched from the
                    REST API, typed-value JSON) with REPO (plain JSON) will
                    change. Informational only -- always exits 0; the deploy's
                    confirmation prompt is the gate.

Stdlib-only, like validate_config_models.py: the deploy machine has python3
but no pip environment.
"""

import json
import sys
from typing import Any


def to_typed(value: Any) -> dict[str, Any]:
  """Returns the Firestore REST 'Value' for a plain JSON value."""
  # bool first: bool is an int subclass, and True encoded as an integerValue
  # would silently change the field's type in Firestore.
  if isinstance(value, bool):
    return {'booleanValue': value}
  if value is None:
    return {'nullValue': None}
  if isinstance(value, int):
    return {'integerValue': str(value)}  # the REST API encodes int64 as string
  if isinstance(value, float):
    return {'doubleValue': value}
  if isinstance(value, str):
    return {'stringValue': value}
  if isinstance(value, list):
    return {'arrayValue': {'values': [to_typed(v) for v in value]}}
  if isinstance(value, dict):
    return {'mapValue': {'fields': {k: to_typed(v) for k, v in value.items()}}}
  raise TypeError(f'unsupported JSON type: {type(value).__name__}')


def from_typed(value: dict[str, Any]) -> Any:
  """Inverse of to_typed, for documents fetched from the REST API."""
  if 'booleanValue' in value:
    return value['booleanValue']
  if 'nullValue' in value:
    return None
  if 'integerValue' in value:
    return int(value['integerValue'])
  if 'doubleValue' in value:
    return value['doubleValue']
  if 'stringValue' in value:
    return value['stringValue']
  if 'arrayValue' in value:
    # An empty array serializes as {'arrayValue': {}} -- no 'values' key.
    return [from_typed(v) for v in value['arrayValue'].get('values', [])]
  if 'mapValue' in value:
    return {k: from_typed(v)
            for k, v in value['mapValue'].get('fields', {}).items()}
  # Console edits can hold Firestore-only types (timestamp, bytes, geopoint,
  # reference). The repo file can never contain them, so for diffing they
  # render as a marker the diff will report as replaced/removed -- the seed
  # overwrites them -- rather than crashing the preview.
  return '<firestore ' + '/'.join(sorted(value)) + '>'


def plain_to_document(data: dict[str, Any]) -> dict[str, Any]:
  """REST document body for a plain dict."""
  return {'fields': {k: to_typed(v) for k, v in data.items()}}


def document_to_plain(doc: dict[str, Any]) -> dict[str, Any]:
  """Plain dict from a REST document ({'name': ..., 'fields': {...}})."""
  return {k: from_typed(v) for k, v in doc.get('fields', {}).items()}


def diff_lines(repo: dict[str, Any], live: dict[str, Any]) -> list[str]:
  """What overwriting `live` with `repo` changes, one line per difference.

  One level of detail for dict sections (per model / per default), a single
  line for anything else. Empty list = the seed changes nothing.
  """
  lines = []
  # Membership is checked before values so an explicit null is still reported
  # (dict.get would make a live-only null field look identical to absence).
  for section in sorted(set(repo) | set(live)):
    if section not in live:
      lines.append(f'+ will add section {section!r}')
      continue
    if section not in repo:
      lines.append(f'- will remove section {section!r} (exists only live)')
      continue
    repo_value, live_value = repo[section], live[section]
    if repo_value == live_value:
      continue
    if not (isinstance(repo_value, dict) and isinstance(live_value, dict)):
      lines.append(f'~ will replace {section!r}')
      continue
    for key in sorted(set(repo_value) | set(live_value)):
      if key not in live_value:
        lines.append(f'+ will add {section}.{key}')
        continue
      if key not in repo_value:
        lines.append(f'- will remove {section}.{key} (exists only live)')
        continue
      entry_repo, entry_live = repo_value[key], live_value[key]
      if entry_repo == entry_live:
        continue
      if isinstance(entry_repo, dict) and isinstance(entry_live, dict):
        changed = sorted(
            field for field in set(entry_repo) | set(entry_live)
            if (field in entry_repo) != (field in entry_live)
            or entry_repo.get(field) != entry_live.get(field))
        lines.append(f'~ will change {section}.{key} ({", ".join(changed)})')
      else:
        lines.append(f'~ will change {section}.{key}: '
                     f'{entry_live!r} -> {entry_repo!r}')
  return lines


def main(argv: list[str]) -> int:
  if len(argv) == 2 and argv[1] == 'convert':
    json.dump(plain_to_document(json.load(sys.stdin)), sys.stdout)
    return 0
  if len(argv) == 4 and argv[1] == 'diff':
    try:
      with open(argv[2], encoding='utf-8') as f:
        repo = json.load(f)
      with open(argv[3], encoding='utf-8') as f:
        live = document_to_plain(json.load(f))
      lines = diff_lines(repo, live)
    except Exception:  # the preview informs; it must never block a deploy
      print('    could not compute the config/models diff; this deploy '
            'seeds it from the repo.')
      return 0
    if not lines:
      print('    live config/models matches the repo catalog; the seed '
            'changes nothing.')
      return 0
    print('    the seed will overwrite these live differences (console edits '
          'do not survive a deploy):')
    for line in lines:
      print(f'      {line}')
    return 0
  print(__doc__, file=sys.stderr)
  return 2


if __name__ == '__main__':
  sys.exit(main(sys.argv))
