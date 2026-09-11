"""Tests the create-only homepage announcement seed payload helper."""

import json
import importlib.util
import os
import pathlib
import subprocess
import sys
import urllib.error
import uuid

import pytest


_REPO = pathlib.Path(__file__).resolve().parent.parent
_SCRIPT = _REPO / 'scripts' / 'seed_announcement.py'


def _load_seed_module():
  spec = importlib.util.spec_from_file_location('seed_announcement', _SCRIPT)
  assert spec and spec.loader
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def _run(*args, env=None):
  merged_env = os.environ.copy()
  if env:
    merged_env.update(env)
  return subprocess.run(
      [sys.executable, str(_SCRIPT), *args],
      cwd=_REPO,
      text=True,
      capture_output=True,
      check=False,
      env=merged_env,
  )


def test_convert_reads_markdown_and_emits_typed_create_document():
  message = _REPO / '.test-announcement.md'
  message.write_text('Welcome **here**! $HOME "quoted"\n', encoding='utf-8')
  try:
    result = _run('convert', str(message), '1')
  finally:
    message.unlink()

  assert result.returncode == 0, result.stderr
  assert json.loads(result.stdout) == {
      'fields': {
          'markdown': {'stringValue': 'Welcome **here**! $HOME "quoted"\n'},
          'enabled': {'booleanValue': True},
          'emoji': {'stringValue': '⚠️'},
      }
  }


@pytest.mark.parametrize(
    'enabled, content',
    [
        ('2', 'ok'),
        ('1', ''),
        ('1', 'x' * 256),
    ],
)
def test_convert_rejects_invalid_seed_values(tmp_path, enabled, content):
  del tmp_path
  message = _REPO / f'.test-announcement-{uuid.uuid4().hex}.md'
  message.write_text(content, encoding='utf-8')
  try:
    result = _run('convert', str(message), enabled)
  finally:
    message.unlink()
  assert result.returncode != 0
  assert result.stdout == ''


def test_convert_rejects_markdown_path_outside_repo(tmp_path):
  message = tmp_path / 'announcement.md'
  message.write_text('ok', encoding='utf-8')
  result = _run('convert', str(message), '1')
  assert result.returncode != 0
  assert 'inside the repository' in result.stderr


@pytest.mark.parametrize('content, succeeds', [('😀' * 255, True), ('😀' * 256, False)])
def test_convert_enforces_255_unicode_code_points(content, succeeds):
  message = _REPO / f'.test-announcement-{uuid.uuid4().hex}.md'
  message.write_text(content, encoding='utf-8')
  try:
    result = _run('convert', str(message), '1')
  finally:
    message.unlink()
  assert (result.returncode == 0) is succeeds


def test_cli_enforces_subcommand_arity():
  missing_seed = _run('seed', 'https://firestore.test/seed', 'config/announcement.md')
  extra_convert = _run(
      'convert', 'config/announcement.md', '1', 'extra'
  )
  assert missing_seed.returncode == 2
  assert 'usage:' in missing_seed.stderr
  assert extra_convert.returncode == 2
  assert 'usage:' in extra_convert.stderr


@pytest.mark.parametrize(
    'status, succeeds', [
        (200, True), (201, True), (409, True), (401, False), (403, False), (500, False)
    ]
)
def test_seed_posts_safe_payload_and_only_accepts_create_or_conflict(
    monkeypatch, status, succeeds
):
  received = {}
  module = _load_seed_module()

  class Response:
    def __init__(self):
      self.status = status

    def __enter__(self):
      return self

    def __exit__(self, *_args):
      return False

  def fake_urlopen(request, **kwargs):
    received['method'] = request.method
    received['path'] = request.full_url
    received['auth'] = request.headers['Authorization']
    received['body'] = json.loads(request.data)
    received['timeout'] = kwargs['timeout']
    if status in (200, 201):
      return Response()
    raise urllib.error.HTTPError(request.full_url, status, 'fake', {}, None)

  monkeypatch.setattr(module.urllib.request, 'urlopen', fake_urlopen)
  message = _REPO / f'.test-announcement-{uuid.uuid4().hex}.md'
  message.write_text('Quote " and dollar $HOME\n', encoding='utf-8')
  try:
    try:
      result = module.seed_document(
          'https://firestore.test/v1/projects/p/databases/db/documents/config?documentId=announcement',
          str(message),
          '1',
          'test-token',
      )
    except RuntimeError:
      result = None
  finally:
    message.unlink()

  assert (result in (200, 201, 409)) is succeeds
  assert received == {
      'method': 'POST',
      'path': 'https://firestore.test/v1/projects/p/databases/db/documents/config?documentId=announcement',
      'auth': 'Bearer test-token',
      'body': {
          'fields': {
              'markdown': {'stringValue': 'Quote " and dollar $HOME\n'},
              'enabled': {'booleanValue': True},
              'emoji': {'stringValue': '⚠️'},
          }
      },
      'timeout': module._SEED_HTTP_TIMEOUT_SECONDS,
  }


def test_seed_transport_failure_is_not_reported_as_success(monkeypatch):
  module = _load_seed_module()
  monkeypatch.setattr(
      module.urllib.request,
      'urlopen',
      lambda _request, **_kwargs: (_ for _ in ()).throw(
          urllib.error.URLError('connection refused')
      ),
  )
  message = _REPO / f'.test-announcement-{uuid.uuid4().hex}.md'
  message.write_text('ok', encoding='utf-8')
  try:
    with pytest.raises(RuntimeError, match='request failed'):
      module.seed_document('https://firestore.test/seed', str(message), '1', 'token')
  finally:
    message.unlink()
