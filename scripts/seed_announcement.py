#!/usr/bin/env python3
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""Validate and convert the create-only homepage announcement seed."""

import json
import os
import pathlib
import sys
from typing import Any
import urllib.error
import urllib.request


_REPO = pathlib.Path(__file__).resolve().parent.parent
_MAX_MARKDOWN_LENGTH = 255
_DEFAULT_EMOJI = '⚠️'
_SEED_HTTP_TIMEOUT_SECONDS = 30


def _typed(value: Any) -> dict[str, Any]:
  if isinstance(value, bool):
    return {'booleanValue': value}
  if isinstance(value, str):
    return {'stringValue': value}
  raise TypeError(f'unsupported seed value: {type(value).__name__}')


def _validate_path(raw_path: str) -> pathlib.Path:
  path = pathlib.Path(raw_path).expanduser().resolve()
  try:
    path.relative_to(_REPO)
  except ValueError as error:
    raise ValueError('announcement Markdown file must be inside the repository') from error
  return path


def build_document(path: str, enabled: str) -> dict[str, Any]:
  if enabled not in ('0', '1'):
    raise ValueError('announcement enabled flag must be 0 or 1')
  markdown_path = _validate_path(path)
  markdown = markdown_path.read_text(encoding='utf-8')
  if not 0 < len(markdown) <= _MAX_MARKDOWN_LENGTH:
    raise ValueError('announcement Markdown must be 1-255 characters')
  return {
      'fields': {
          'markdown': _typed(markdown),
          'enabled': _typed(enabled == '1'),
          'emoji': _typed(_DEFAULT_EMOJI),
      }
  }


def seed_document(
    url: str, path: str, enabled: str, token: str
) -> int:
  """POST a create-only document; 409 means an operator document exists."""
  if not token:
    raise ValueError('GOOGLE_OAUTH_ACCESS_TOKEN is required for seeding')
  body = json.dumps(build_document(path, enabled)).encode('utf-8')
  headers = {
      'Authorization': f'Bearer {token}',
      'Content-Type': 'application/json',
  }
  billing_project = os.environ.get('GOOGLE_CLOUD_PROJECT')
  if billing_project:
    headers['x-goog-user-project'] = billing_project
  request = urllib.request.Request(url, data=body, method='POST', headers=headers)
  try:
    with urllib.request.urlopen(  # nosec B310
        request, timeout=_SEED_HTTP_TIMEOUT_SECONDS
    ) as response:
      status = response.status
  except urllib.error.HTTPError as error:
    status = error.code
  except urllib.error.URLError as error:
    raise RuntimeError(f'announcement seed request failed: {error.reason}') from error
  if status not in (200, 409):
    raise RuntimeError(f'announcement seed request returned HTTP {status}')
  return status


def main(argv: list[str]) -> int:
  if len(argv) < 2 or argv[1] not in ('convert', 'seed'):
    print(
        'usage: seed_announcement.py convert MARKDOWN_FILE ENABLED\n'
        '       seed URL MARKDOWN_FILE ENABLED',
        file=sys.stderr,
    )
    return 2
  expected_args = 3 if argv[1] == 'convert' else 4
  if len(argv) != expected_args + 1:
    print(
        'usage: seed_announcement.py convert MARKDOWN_FILE ENABLED\n'
        '       seed URL MARKDOWN_FILE ENABLED',
        file=sys.stderr,
    )
    return 2
  try:
    if argv[1] == 'convert':
      document = build_document(argv[2], argv[3])
    else:
      status = seed_document(
          argv[2], argv[3], argv[4],
          os.environ.get('GOOGLE_OAUTH_ACCESS_TOKEN', ''),
      )
      print(status)
      return 0
  except (OSError, UnicodeError, ValueError) as error:
    print(f'ERROR: {error}', file=sys.stderr)
    return 1
  except RuntimeError as error:
    print(f'ERROR: {error}', file=sys.stderr)
    return 1
  json.dump(document, sys.stdout)
  return 0


if __name__ == '__main__':
  raise SystemExit(main(sys.argv))
