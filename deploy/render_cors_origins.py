#!/usr/bin/env python3
"""Render validated Cloud Run service URLs as a JSON-array fragment.

The deploy passes this helper the JSON projection of the service annotation
``run.googleapis.com/urls``. The output is inserted into the checked-in GCS
CORS template; an absent or malformed annotation fails the deploy rather than
inventing a hostname or widening the bucket to ``*``.
"""

from __future__ import annotations

import json
import sys
from urllib.parse import urlsplit


_ANNOTATION = 'run.googleapis.com/urls'


def _decode_urls(value: object) -> list[str]:
  if not isinstance(value, str):
    raise ValueError('Cloud Run URL annotation is not a JSON string')
  try:
    value = json.loads(value)
  except json.JSONDecodeError as exc:
    raise ValueError('Cloud Run URL annotation is not JSON') from exc
  if not isinstance(value, list) or not value:
    raise ValueError('Cloud Run URL annotation is not a non-empty list')

  origins = []
  for raw in value:
    if (
        not isinstance(raw, str)
        or raw != raw.strip()
        or any(char.isspace() for char in raw)
    ):
      raise ValueError('Cloud Run URL annotation contains an invalid origin')
    origin = raw.rstrip('/')
    try:
      parsed = urlsplit(origin)
      port = parsed.port
    except ValueError as exc:
      raise ValueError('Cloud Run URL annotation contains an invalid origin') from exc
    if (
        parsed.scheme != 'https'
        or not parsed.hostname
        or (port is None and ':' in parsed.netloc.rsplit(']', 1)[-1])
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ('', '/')
        or parsed.query
        or parsed.fragment
        or '*' in origin
    ):
      raise ValueError('Cloud Run URL annotation contains an invalid origin')
    if origin not in origins:
      origins.append(origin)
  if not origins:
    raise ValueError('Cloud Run URL annotation has no usable origins')
  return origins


def main() -> int:
  try:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
      raise ValueError('Cloud Run service metadata is not an object')
    metadata = payload.get('metadata')
    annotations = metadata.get('annotations') if isinstance(metadata, dict) else None
    if not isinstance(annotations, dict) or _ANNOTATION not in annotations:
      raise ValueError('Cloud Run URL annotation is missing')
    origins = _decode_urls(annotations[_ANNOTATION])
  except (json.JSONDecodeError, ValueError) as exc:
    print(f'ERROR: {exc}', file=sys.stderr)
    return 1
  print(',\n'.join(json.dumps(origin) for origin in origins))
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
