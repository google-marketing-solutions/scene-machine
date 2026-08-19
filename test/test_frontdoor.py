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

"""Tests for the ROLE/AUTH_MODE/WORKER_URL front-door split in orch.py.

orch.py reads ROLE, AUTH_MODE, WORKER_URL and IAP_AUDIENCE from the
environment at import time, so every test (re)imports the module through
_load_orch with the desired environment set first.

orchestrator.py has import-time side effects (it reads
ui/definitions/config.json, constructs a Firestore client, and calls the
GCE metadata server without a timeout); the orchestrator_module fixture
neutralises all three BEFORE the first import, mirroring the 'orch'
fixture in test_engine_characterization.py — the only safe import path.
No test performs network I/O.
"""

import importlib
import datetime
import hashlib
import json
import pathlib
import sys

from google.api_core import exceptions as google_exceptions
import pytest

from test import firestore_fake

_REPO = pathlib.Path(__file__).resolve().parent.parent
_CONFIG_PATH = _REPO / 'ui' / 'definitions' / 'config.json'

_FRONTDOOR_ENV_VARS = (
    'ROLE',
    'AUTH_MODE',
    'WORKER_URL',
    'IAP_AUDIENCE',
)
_IAP_AUDIENCE = '/projects/123456/locations/us-central1/services/app'
_IAP_CERTS_URL = 'https://www.gstatic.com/iap/verify/public_key'


@pytest.fixture(scope='module')
def orchestrator_module():
  """Imports orchestrator with its import-time side effects neutralised."""
  created_config = False
  if not _CONFIG_PATH.exists():
    _CONFIG_PATH.write_text(
        json.dumps({
            'firestoreDatabase': 'frontdoor-test',
            'gcsBucket': 'frontdoor-test-bucket',
            'gcpProject': 'frontdoor-test-project',
            'gcpLocation': 'us-central1',
            'tasksQueuePrefix': 'frontdoor-test-',
        }),
        encoding='utf-8',
    )
    created_config = True

  firestore_module = importlib.import_module('google.cloud.firestore')
  real_client = firestore_module.Client
  real_transactional = firestore_module.transactional
  firestore_module.Client = firestore_fake.FakeFirestoreClient
  firestore_module.transactional = firestore_fake.fake_transactional

  requests_module = importlib.import_module('requests')
  real_get = requests_module.get

  def _no_metadata_server(*_args, **_kwargs):
    raise requests_module.exceptions.ConnectionError(
        'test environment: no metadata server'
    )

  requests_module.get = _no_metadata_server
  try:
    orchestrator = importlib.import_module('orchestrator')
  finally:
    requests_module.get = real_get

  yield orchestrator

  firestore_module.Client = real_client
  firestore_module.transactional = real_transactional
  if created_config:
    _CONFIG_PATH.unlink()


def _load_orch(monkeypatch, **env):
  """(Re)imports orch with exactly the given front-door env vars set."""
  monkeypatch.chdir(_REPO)  # orch.py opens config.json CWD-relative
  for var in _FRONTDOOR_ENV_VARS:
    monkeypatch.delenv(var, raising=False)
  for var, value in env.items():
    monkeypatch.setenv(var, value)
  if 'orch' in sys.modules:
    return importlib.reload(sys.modules['orch'])
  return importlib.import_module('orch')


def _rules(flask_app):
  return {rule.rule for rule in flask_app.url_map.iter_rules()}


def _capture_supply_node(monkeypatch, orch, execution_id='exec-test'):
  """Replaces orchestrator.supply_node with a capturing stub."""
  captured = {}

  def fake_supply_node(data, instance):
    captured['data'] = data
    captured['instance'] = instance
    return execution_id

  monkeypatch.setattr(orch.orchestrator, 'supply_node', fake_supply_node)
  return captured


# ---------------------------------------------------------------------------
# (a) ROLE unset (default 'all'): exactly today's three root routes, no
# auth, Host-derived callback — byte-identical legacy behavior.
# ---------------------------------------------------------------------------
def test_default_role_all_routes_and_no_auth(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch)

  # Exactly the legacy route set (plus Flask's built-in /static rule).
  assert _rules(orch.app) == {
      '/supplyNode',
      '/triggerAction',
      '/getStatus',
      '/static/<path:filename>',
  }

  client = orch.app.test_client()
  captured = _capture_supply_node(monkeypatch, orch, 'exec-all')

  # No auth gate: a bare request reaches the handler.
  response = client.post('/supplyNode', json={'nodeId': 'root'})
  assert response.status_code == 200
  assert response.get_json() == {'executionId': 'exec-all'}
  # WORKER_URL unset: the callback base derives from the Host header.
  assert captured['instance'] == 'https://localhost'

  # /getStatus reaches the handler unauthenticated (400 = its own
  # incomplete-parameters response, not a 401).
  assert client.get('/getStatus').status_code == 400


def test_supply_node_rejects_non_object_workflow_params(
    monkeypatch, orchestrator_module
):
  """A non-object workflowParams returns 400, not a 500 crash (regression)."""
  del orchestrator_module
  orch = _load_orch(monkeypatch)
  client = orch.app.test_client()
  # Must not even reach orchestrator.supply_node.
  _capture_supply_node(monkeypatch, orch, 'should-not-run')
  response = client.post(
      '/supplyNode', json={'nodeId': 'root', 'workflowParams': 'bad'}
  )
  assert response.status_code == 400


# ---------------------------------------------------------------------------
# (b) ROLE=worker: /supplyNode + /triggerAction only; no /api/*, no
# /getStatus, no static serving.
# ---------------------------------------------------------------------------
def test_worker_exposes_only_task_routes(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')

  rules = _rules(orch.app)
  assert '/supplyNode' in rules
  assert '/triggerAction' in rules
  assert '/getStatus' not in rules
  assert not any(rule.startswith('/api/') for rule in rules)
  assert '/<path:path>' not in rules  # no SPA catch-all on the worker

  client = orch.app.test_client()
  assert client.post('/api/supplyNode', json={}).status_code == 404
  assert client.get('/api/getStatus').status_code == 404


# ---------------------------------------------------------------------------
# (c) ROLE=app: /api/supplyNode + /api/getStatus; the bare worker routes
# are not registered.
# ---------------------------------------------------------------------------
def test_app_exposes_api_routes_not_worker_routes(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL=worker_url)

  rules = _rules(orch.app)
  assert '/api/supplyNode' in rules
  assert '/api/getStatus' in rules
  assert '/triggerAction' not in rules
  assert '/supplyNode' not in rules
  assert '/getStatus' not in rules
  # The Firebase custom-token bridge has been removed; it is never registered.
  assert '/api/firebaseCustomToken' not in rules

  client = orch.app.test_client()
  # The SPA catch-all is GET-only, so the worker-only POST routes do not
  # resolve on the app service.
  assert client.post('/triggerAction', json={}).status_code == 405

  # AUTH_MODE='none': /api/* passes through without credentials.
  captured = _capture_supply_node(monkeypatch, orch, 'exec-app')
  response = client.post('/api/supplyNode', json=_valid_app_submission())
  assert response.status_code == 200
  assert response.get_json() == {'executionId': 'exec-app'}
  assert captured['instance'] == worker_url


# ---------------------------------------------------------------------------
# (d) WORKER_URL overrides the Host-derived Cloud Tasks callback base in
# both task-creating handlers.
# ---------------------------------------------------------------------------
def test_worker_url_overrides_host_for_supply_node(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL=worker_url)

  captured = _capture_supply_node(monkeypatch, orch, 'exec-worker')
  client = orch.app.test_client()
  response = client.post('/supplyNode', json={'nodeId': 'root'})
  assert response.status_code == 200
  assert captured['instance'] == worker_url


def test_incomplete_join_returns_execution_id(
    monkeypatch, orchestrator_module
):
  monkeypatch.setattr(
      orchestrator_module.db, 'verify_input', lambda *args, **kwargs: (False, {})
  )
  result = orchestrator_module.supply_node(
      {
          'executionId': 'exec-join',
          'nodeId': 'join',
          'workflowDefinition': {
              'join': {
                  'action': 'pass',
                  'input': {
                      'image': {'node': 'predecessor', 'output': 'image'},
                  },
              },
          },
          'workflowParams': {},
          'inputFiles': {},
      },
      instance='https://worker.example',
  )
  assert result == 'exec-join'


def test_worker_maps_undefined_action_error(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL='https://w.a.run.app')
  response = orch.app.test_client().post(
      '/supplyNode',
      json={
          'executionId': 'exec-undefined',
          'nodeId': 'root',
          'workflowDefinition': {
              'root': {'action': 'definitely_not_an_action'},
          },
          'workflowParams': {},
          'inputFiles': {},
      },
  )
  assert response.status_code == 404
  assert response.get_json() == {'error': 'Action undefined'}


def _task_payload(
    execution_id='exec-worker',
    node_id='node-1',
    group_id='group-1',
    action='pass',
    force_execution=False,
):
  """A valid Cloud Tasks /triggerAction payload, including the PR #113 lock
  fields (executionId / nodeId / groupId / workflowDefinition)."""
  return {
      'action': action,
      'inputFiles': {},
      'executionId': execution_id,
      'nodeId': node_id,
      'groupId': group_id,
      'workflowDefinition': {node_id: {'action': action}},
      'workflowParams': {'gcsBucket': 'test-bucket'},
      'forceExecution': force_execution,
  }


def _task_headers(
    queue_name='queue-test', task_name='task-test', retry_count=0
):
  return {
      'X-CloudTasks-QueueName': queue_name,
      'X-CloudTasks-TaskName': task_name,
      'X-CloudTasks-TaskRetryCount': str(retry_count),
  }


def _task_completion_path(execution_id, queue_name, task_name):
  task_token = hashlib.sha256(
      json.dumps(
          [
              'cloud-tasks',
              queue_name,
              task_name,
              execution_id,
              'node-1',
              'group-1',
          ],
          ensure_ascii=True,
          separators=(',', ':'),
      ).encode('utf-8')
  ).hexdigest()
  return f'_task-completions/{task_token}.json'


def _install_action_cache(
    monkeypatch,
    orch,
    cache,
    *,
    exists_errors=None,
    download_errors=None,
    action_upload_errors=None,
    completion_upload_errors=None,
):
  """Installs an in-memory action cache for trigger-action tests."""
  cache_metadata = {}
  completion_downloads = []
  pending_exists_errors = list(exists_errors or [])
  pending_download_errors = list(download_errors or [])
  pending_action_upload_errors = list(action_upload_errors or [])
  pending_completion_upload_errors = list(completion_upload_errors or [])

  class CacheBlob:

    def __init__(self, path):
      self.path = path
      self.metadata = None

    def exists(self):
      if pending_exists_errors:
        raise pending_exists_errors.pop(0)
      return self.path in cache

    def _download(self):
      if pending_download_errors:
        raise pending_download_errors.pop(0)
      if self.path not in cache:
        raise google_exceptions.NotFound('cache object not found')
      return cache[self.path]

    def download_as_string(self, **_kwargs):
      if self.path.startswith('_task-completions/'):
        raise AssertionError('completion manifests must use download_as_bytes')
      return self._download()

    def download_as_bytes(self, **_kwargs):
      completion_downloads.append(self.path)
      data = self._download()
      return data.encode('utf-8') if isinstance(data, str) else data

    def upload_from_string(self, data, if_generation_match=None, **_kwargs):
      if (
          not self.path.startswith('_task-completions/')
          and pending_action_upload_errors
      ):
        raise pending_action_upload_errors.pop(0)
      if (
          self.path.startswith('_task-completions/')
          and pending_completion_upload_errors
      ):
        raise pending_completion_upload_errors.pop(0)
      if if_generation_match == 0 and self.path in cache:
        raise google_exceptions.PreconditionFailed('object already exists')
      cache[self.path] = data
      cache_metadata[self.path] = self.metadata

  class CacheBucket:

    def blob(self, path):
      return CacheBlob(path)

  class CacheGcs:

    def __init__(self, *_args, **_kwargs):
      self.gcs_bucket = CacheBucket()

  monkeypatch.setattr(orch.orchestrator.actwrap.gcs_wrapper, 'GCS', CacheGcs)
  return {
      'completion_downloads': completion_downloads,
      'metadata': cache_metadata,
  }


def _install_task_state(monkeypatch, orch, *, outcome=None):
  """Installs successful task-state operations and returns transition calls."""
  if outcome is None:
    outcome = orch.util_database.TASK_LOCK_ACQUIRED
  transitions = []
  monkeypatch.setattr(
      orch.orchestrator.db,
      'acquire_task_lock',
      lambda *_args, **_kwargs: outcome,
  )

  def mark(state):
    def record(*args, **_kwargs):
      transitions.append((state, args))
      return True

    return record

  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_retryable', mark('retryable')
  )
  monkeypatch.setattr(orch.orchestrator.db, 'mark_task_failed', mark('failed'))
  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_succeeded', mark('succeeded')
  )
  return transitions


def test_task_state_claims_are_owner_checked(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  db = orch.orchestrator.db
  key = ('task-state-claims', 'node', 'group')

  assert db.acquire_task_lock(*key, 'task-a', 'owner-1', 1) == 'acquired'
  assert db.acquire_task_lock(*key, 'task-a', 'owner-2', 2) == 'busy'
  assert db.acquire_task_lock(*key, 'task-b', 'owner-2', 1) == 'duplicate'
  assert (
      db.mark_task_retryable(*key, 'task-a', 'wrong-owner', 1, 'error') is False
  )
  assert db.mark_task_retryable(*key, 'task-a', 'owner-1', 1, 'error') is True
  assert db.acquire_task_lock(*key, 'task-a', 'owner-2', 2) == 'acquired'
  assert db.mark_task_succeeded(*key, 'task-a', 'owner-1', 1) is False
  assert db.mark_task_succeeded(*key, 'task-a', 'owner-2', 2) is True
  assert db.acquire_task_lock(*key, 'task-a', 'owner-3', 3) == 'terminal'

  malformed_key = ('task-state-malformed', 'node', 'group')
  db._get_task_lock_ref(*malformed_key).set({
      'taskToken': 'task-a',
      'ownerToken': 'owner-1',
      'state': 'unexpected',
  })
  assert (
      db.acquire_task_lock(*malformed_key, 'task-a', 'owner-2', 2) == 'terminal'
  )


def test_task_state_expired_lease_can_be_reclaimed(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  db = orch.orchestrator.db
  key = ('task-state-expiry', 'node', 'group')
  assert db.acquire_task_lock(*key, 'task-a', 'owner-1', 1) == 'acquired'
  db._get_task_lock_ref(*key).set(
      {
          'leaseExpiresAt': (
              datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(seconds=1)
          )
      },
      merge=True,
  )

  assert (
      db.acquire_task_lock(*key, 'task-a', 'owner-2', 2) == 'acquired-recovery'
  )
  state = db._get_task_lock_ref(*key).get().to_dict()
  assert state['ownerToken'] == 'owner-2'
  assert state['attempt'] == 2
  assert state['recoveryOnly'] is True


@pytest.mark.parametrize('recovery_value', ('missing', None, 0, 'false'))
def test_task_state_ambiguous_retryable_state_is_recovery_only(
    monkeypatch, orchestrator_module, recovery_value
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  db = orch.orchestrator.db
  key = (f'task-state-ambiguous-{recovery_value}', 'node', 'group')
  state = {
      'taskToken': 'task-a',
      'ownerToken': 'owner-1',
      'state': 'retryable',
  }
  if recovery_value != 'missing':
    state['recoveryOnly'] = recovery_value
  db._get_task_lock_ref(*key).set(state)

  assert (
      db.acquire_task_lock(*key, 'task-a', 'owner-2', 2) == 'acquired-recovery'
  )


def test_task_completion_is_create_only_without_false_expiry_metadata(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  cache_state = _install_action_cache(monkeypatch, orch, cache)
  payload = _task_payload(execution_id='completion-create-only')
  output = {'video': [{'file': 'generated/video.mp4'}]}
  task_token = 'a' * 64

  assert (
      orch.orchestrator._store_task_completion(payload, task_token, output)
      == output
  )
  completion_path = f'_task-completions/{task_token}.json'
  assert (
      orch.orchestrator._store_task_completion(payload, task_token, output)
      == output
  )
  competing_output = {'video': [{'file': 'generated/other.mp4'}]}
  assert (
      orch.orchestrator._store_task_completion(
          payload, task_token, competing_output
      )
      == output
  )
  assert json.loads(cache[completion_path]) == output
  assert cache_state['completion_downloads'] == [
      completion_path,
      completion_path,
  ]
  assert cache_state['metadata'][completion_path] is None


def test_create_conflict_read_failure_requires_recovery_only_retry(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  task_token = 'b' * 64
  completion_path = f'_task-completions/{task_token}.json'
  _install_action_cache(
      monkeypatch,
      orch,
      {completion_path: json.dumps({'video': []})},
      download_errors=[google_exceptions.ServiceUnavailable('GCS unavailable')],
  )

  with pytest.raises(orch.util_errors.RetryableTaskRecoveryError) as error:
    orch.orchestrator._store_task_completion(
        _task_payload(execution_id='completion-create-conflict'),
        task_token,
        {'video': [{'file': 'generated/video.mp4'}]},
    )

  assert type(error.value) is orch.util_errors.RetryableTaskRecoveryError


@pytest.mark.parametrize(
    ('manifest', 'error_type'),
    (
        (b'{', 'JSONDecodeError'),
        (b'[]', 'TypeError'),
        (b'\xff', 'UnicodeDecodeError'),
        (b'[' * 10_000, 'RecursionError'),
    ),
    ids=(
        'malformed-json',
        'non-object-json',
        'invalid-utf8',
        'excessive-nesting',
    ),
)
def test_invalid_task_completion_is_terminal_without_running_action(
    monkeypatch, orchestrator_module, manifest, error_type
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  action_calls = []
  stored_outputs = []
  execution_id = f'invalid-completion-{error_type.lower()}'
  queue_name = f'queue-{error_type.lower()}'
  task_name = f'task-{error_type.lower()}'
  completion_path = _task_completion_path(execution_id, queue_name, task_name)
  cache_state = _install_action_cache(
      monkeypatch, orch, {completion_path: manifest}
  )

  def paid_action(*_args, **_kwargs):
    action_calls.append('called')
    return {'outpainted_image': [{'file': 'generated/image.png'}]}

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'store_output',
      lambda *args: stored_outputs.append(args[-1]),
  )
  payload = _task_payload(
      execution_id=execution_id,
      action='outpaint_image',
      force_execution=True,
  )

  response = orch.app.test_client().post(
      '/triggerAction',
      json=payload,
      headers=_task_headers(queue_name, task_name),
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(execution_id, 'node-1', 'group-1')
      .get()
      .to_dict()
  )

  assert response.status_code == 200
  assert state['state'] == 'failed'
  assert state['attempt'] == 1
  assert state['error'].startswith(f'{error_type}:')
  assert action_calls == []
  assert stored_outputs == []
  assert cache_state['completion_downloads'] == [completion_path]


def test_unexpected_completion_parse_failure_stays_recovery_only(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  action_calls = []
  execution_id = 'unexpected-completion-parse-failure'
  queue_name = 'queue-unexpected-parse'
  task_name = 'task-unexpected-parse'
  completion_path = _task_completion_path(execution_id, queue_name, task_name)

  class UnexpectedParseFailure(bytes):

    def decode(self, *_args, **_kwargs):
      raise MemoryError('transient parser failure')

  cache = {completion_path: UnexpectedParseFailure(b'{}')}
  cache_state = _install_action_cache(monkeypatch, orch, cache)

  def paid_action(*_args, **_kwargs):
    action_calls.append('called')
    return {'outpainted_image': [{'file': 'generated/image.png'}]}

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  payload = _task_payload(
      execution_id=execution_id,
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers(queue_name, task_name)
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      execution_id, 'node-1', 'group-1'
  )
  first_state = lock_ref.get().to_dict()
  cache.pop(completion_path)
  redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  redelivery_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert redelivery.status_code == 503
  assert first_state['state'] == 'retryable'
  assert first_state['recoveryOnly'] is True
  assert redelivery_state['state'] == 'retryable'
  assert redelivery_state['recoveryOnly'] is True
  assert action_calls == []
  assert cache_state['completion_downloads'] == [
      completion_path,
      completion_path,
  ]


def test_task_completion_upload_error_refuses_automatic_action_retry(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  _install_action_cache(
      monkeypatch,
      orch,
      {},
      completion_upload_errors=[
          google_exceptions.RetryError(
              'upload retry deadline exhausted',
              cause=ConnectionError('connection reset'),
          )
      ],
  )

  with pytest.raises(orch.util_errors.TaskCompletionWriteError):
    orch.orchestrator._store_task_completion(
        _task_payload(execution_id='completion-upload'),
        'b' * 64,
        {'video': [{'file': 'generated/video.mp4'}]},
    )


def test_manifest_upload_failure_records_terminal_without_rerunning_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  action_calls = []
  cache = {}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return {'outpainted_image': [{'file': 'generated/image.png'}]}

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(
      monkeypatch,
      orch,
      cache,
      completion_upload_errors=[
          google_exceptions.RetryError(
              'upload retry deadline exhausted',
              cause=ConnectionError('connection reset'),
          )
      ],
  )
  payload = _task_payload(
      execution_id='completion-upload-terminal',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-upload', 'task-upload')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(
          'completion-upload-terminal', 'node-1', 'group-1'
      )
      .get()
      .to_dict()
  )

  assert first.status_code == 200
  assert redelivery.status_code == 200
  assert action_calls == ['called']
  checksum = orch.orchestrator.actwrap.util_checksum.compute_object_checksum(
      (payload['inputFiles'], payload.get('parameters', {}))
  )
  assert f'outpaint_image/{checksum}.json' in cache
  assert not any(path.startswith('_task-completions/') for path in cache)
  assert state['state'] == 'failed'
  assert state['attempt'] == 1
  assert state['error'].startswith(
      'RetryError: upload retry deadline exhausted'
  )


def test_action_cache_upload_failure_records_terminal_without_rerunning_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  action_calls = []
  cache = {}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return {'outpainted_image': [{'file': 'generated/image.png'}]}

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(
      monkeypatch,
      orch,
      cache,
      action_upload_errors=[
          google_exceptions.ResourceExhausted('GCS write quota exhausted')
      ],
  )
  payload = _task_payload(
      execution_id='action-cache-upload-terminal',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-action-cache', 'task-action-cache')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(
          'action-cache-upload-terminal', 'node-1', 'group-1'
      )
      .get()
      .to_dict()
  )

  assert first.status_code == 200
  assert redelivery.status_code == 200
  assert action_calls == ['called']
  assert cache == {}
  assert state['state'] == 'failed'
  assert state['attempt'] == 1
  assert state['error'].startswith('ResourceExhausted: ')
  assert 'GCS write quota exhausted' in state['error']


def test_worker_url_overrides_host_for_trigger_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL=worker_url)

  captured = {}

  def fake_trigger_action(data, instance, may_retry, task_token, recovery_only):
    captured['data'] = data
    captured['instance'] = instance
    captured['may_retry'] = may_retry
    captured['task_token'] = task_token
    captured['recovery_only'] = recovery_only

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fake_trigger_action)
  transitions = _install_task_state(monkeypatch, orch)
  client = orch.app.test_client()
  response = client.post(
      '/triggerAction',
      json=_task_payload(),
      headers=_task_headers('queue-worker-url', 'task-worker-url'),
  )
  assert response.status_code == 200
  assert captured['instance'] == worker_url
  assert captured['recovery_only'] is False
  assert captured['may_retry'] is True
  assert len(captured['task_token']) == 64
  assert [state for state, _args in transitions] == ['succeeded']


def test_trigger_action_duplicate_delivery_is_skipped(
    monkeypatch, orchestrator_module
):
  """PR #113: a duplicate Cloud Tasks delivery of the same (exec, node, group)
  fails to acquire the lock, returns 'Already Triggered', and does NOT re-run
  the action."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  called = {'trigger': False}
  monkeypatch.setattr(
      orch.orchestrator,
      'trigger_action',
      lambda *a, **k: called.__setitem__('trigger', True),
  )
  _install_task_state(
      monkeypatch, orch, outcome=orch.util_database.TASK_LOCK_TERMINAL
  )
  client = orch.app.test_client()
  response = client.post(
      '/triggerAction',
      json=_task_payload(),
      headers=_task_headers('queue-duplicate', 'task-duplicate'),
  )
  assert response.status_code == 200
  assert response.get_data(as_text=True) == 'Already Triggered'
  assert called['trigger'] is False


def test_trigger_action_retryable_error_records_retryable_state(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  transitions = _install_task_state(monkeypatch, orch)

  def boom(*_a, **_k):
    raise RuntimeError('quota exceeded')

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', boom)
  monkeypatch.setattr(orch.util_errors, 'is_retryable', lambda _e: True)
  client = orch.app.test_client()
  response = client.post(
      '/triggerAction',
      json=_task_payload(),
      headers=_task_headers('queue-retryable', 'task-retryable'),
  )
  assert response.status_code == 429
  assert [state for state, _args in transitions] == ['retryable']
  assert transitions[0][1][-1] is False


def test_trigger_action_post_action_deadline_records_retryable_state(
    monkeypatch, orchestrator_module
):
  """A transient output-write failure is retried after the action completes."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  transitions = _install_task_state(monkeypatch, orch)
  _install_action_cache(monkeypatch, orch, {})

  def unavailable(*_args, **_kwargs):
    raise google_exceptions.DeadlineExceeded('Firestore deadline exceeded')

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', unavailable)

  response = orch.app.test_client().post(
      '/triggerAction',
      json=_task_payload(),
      headers=_task_headers('queue-post-action', 'task-post-action'),
  )

  assert response.status_code == 503
  assert [state for state, _args in transitions] == ['retryable']
  assert transitions[0][1][-1] is True


@pytest.mark.parametrize(
    ('manifest_on_retry', 'expected_action_calls'),
    ((False, ['called']), (True, [])),
    ids=('manifest-missing-executes-once', 'manifest-present-skips-action'),
)
def test_fresh_manifest_probe_retry_rechecks_before_action(
    monkeypatch,
    orchestrator_module,
    manifest_on_retry,
    expected_action_calls,
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  output = {'outpainted_image': [{'file': 'generated/image.png'}]}
  action_calls = []
  stored_outputs = []

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(
      monkeypatch,
      orch,
      cache,
      download_errors=[google_exceptions.ServiceUnavailable('GCS unavailable')],
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'store_output',
      lambda *args: stored_outputs.append(args[-1]),
  )
  payload = _task_payload(
      execution_id=f'fresh-probe-{manifest_on_retry}',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-fresh-probe', f'task-{manifest_on_retry}')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      payload['executionId'], 'node-1', 'group-1'
  )
  retryable_state = lock_ref.get().to_dict()
  completion_path = f'_task-completions/{retryable_state["taskToken"]}.json'
  if manifest_on_retry:
    cache[completion_path] = json.dumps(output)
  retry = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  final_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert retry.status_code == 200
  assert action_calls == expected_action_calls
  assert stored_outputs == [output]
  assert retryable_state['state'] == 'retryable'
  assert retryable_state['recoveryOnly'] is False
  assert final_state['state'] == 'succeeded'


@pytest.mark.parametrize('transition_failure', ('exception', 'lost-owner'))
def test_fatal_action_is_acknowledged_without_retrying_paid_work(
    monkeypatch, orchestrator_module, transition_failure
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  action_calls = []

  def fail_action(*_args, **_kwargs):
    action_calls.append('called')
    raise ValueError('fatal model failure')

  def fail_terminal_transition(*_args, **_kwargs):
    if transition_failure == 'exception':
      raise google_exceptions.DeadlineExceeded('Firestore unavailable')
    return False

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fail_action)
  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_failed', fail_terminal_transition
  )
  payload = _task_payload(execution_id=f'fatal-{transition_failure}')
  headers = _task_headers('queue-fatal', f'task-fatal-{transition_failure}')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  active_redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )

  assert first.status_code == 200
  assert active_redelivery.status_code == 503
  assert action_calls == ['called']


def test_failed_retryable_transition_never_drops_or_releases_new_owner(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  action_calls = []
  output = {'outpainted_image': [{'file': 'generated/one.png'}]}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  store_attempts = 0

  def store_once(*_args):
    nonlocal store_attempts
    store_attempts += 1
    if store_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore unavailable')

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', store_once)
  real_mark_retryable = orch.orchestrator.db.mark_task_retryable
  transition_attempts = 0

  def fail_first_transition(*args, **kwargs):
    nonlocal transition_attempts
    transition_attempts += 1
    if transition_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore unavailable')
    return real_mark_retryable(*args, **kwargs)

  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_retryable', fail_first_transition
  )

  class Owner:

    def __init__(self, value):
      self.hex = value

  owners = iter((Owner('owner-1'), Owner('owner-2'), Owner('owner-3')))
  monkeypatch.setattr(orch.uuid, 'uuid4', lambda: next(owners))
  payload = _task_payload(
      execution_id='state-transition-failure',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-state', 'task-state')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  held = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      'state-transition-failure', 'node-1', 'group-1'
  )
  first_owner_state = lock_ref.get().to_dict()
  lock_ref.set(
      {
          'leaseExpiresAt': (
              datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(seconds=1)
          )
      },
      merge=True,
  )
  recovered = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '2'},
  )
  recovered_state = lock_ref.get().to_dict()
  late_transition = real_mark_retryable(
      'state-transition-failure',
      'node-1',
      'group-1',
      recovered_state['taskToken'],
      first_owner_state['ownerToken'],
      1,
      'late transition',
  )

  assert first.status_code == 503
  assert held.status_code == 503
  assert recovered.status_code == 200
  assert action_calls == ['called']
  assert first_owner_state['state'] == 'running'
  assert first_owner_state['ownerToken'] == 'owner-1'
  assert recovered_state['state'] == 'succeeded'
  assert recovered_state['ownerToken'] == 'owner-3'
  assert late_transition is False


def test_success_transition_error_marks_task_recovery_only(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  action_calls = []
  output = {'outpainted_image': [{'file': 'generated/one.png'}]}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  monkeypatch.setattr(orch.orchestrator.db, 'store_output', lambda *_args: None)
  real_mark_succeeded = orch.orchestrator.db.mark_task_succeeded
  transition_attempts = 0

  def fail_first_transition(*args, **kwargs):
    nonlocal transition_attempts
    transition_attempts += 1
    if transition_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore unavailable')
    return real_mark_succeeded(*args, **kwargs)

  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_succeeded', fail_first_transition
  )
  payload = _task_payload(
      execution_id='success-transition-error',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-success-state', 'task-success-error')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      payload['executionId'], 'node-1', 'group-1'
  )
  retryable_state = lock_ref.get().to_dict()
  recovered = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  final_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert recovered.status_code == 200
  assert action_calls == ['called']
  assert transition_attempts == 2
  assert retryable_state['state'] == 'retryable'
  assert retryable_state['recoveryOnly'] is True
  assert final_state['state'] == 'succeeded'


def test_ambiguous_success_commit_cannot_reopen_succeeded_task(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  action_calls = []
  output = {'outpainted_image': [{'file': 'generated/one.png'}]}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  monkeypatch.setattr(orch.orchestrator.db, 'store_output', lambda *_args: None)
  real_mark_succeeded = orch.orchestrator.db.mark_task_succeeded
  transition_attempts = 0

  def commit_then_raise(*args, **kwargs):
    nonlocal transition_attempts
    transition_attempts += 1
    result = real_mark_succeeded(*args, **kwargs)
    if transition_attempts == 1:
      raise google_exceptions.DeadlineExceeded('response lost after commit')
    return result

  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_succeeded', commit_then_raise
  )
  payload = _task_payload(
      execution_id='success-transition-ambiguous',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-success-state', 'task-success-ambiguous')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      payload['executionId'], 'node-1', 'group-1'
  )
  final_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert redelivery.status_code == 200
  assert redelivery.get_data(as_text=True) == 'Already Triggered'
  assert action_calls == ['called']
  assert transition_attempts == 1
  assert final_state['state'] == 'succeeded'


def test_lost_success_transition_recovers_manifest_after_lease(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  cache = {}
  action_calls = []
  output = {'outpainted_image': [{'file': 'generated/one.png'}]}

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  monkeypatch.setattr(orch.orchestrator.db, 'store_output', lambda *_args: None)
  real_mark_succeeded = orch.orchestrator.db.mark_task_succeeded
  transition_attempts = 0

  def lose_first_transition(*args, **kwargs):
    nonlocal transition_attempts
    transition_attempts += 1
    if transition_attempts == 1:
      return False
    return real_mark_succeeded(*args, **kwargs)

  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_succeeded', lose_first_transition
  )
  payload = _task_payload(
      execution_id='success-transition-lost-owner',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-success-state', 'task-success-lost-owner')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  active_redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      payload['executionId'], 'node-1', 'group-1'
  )
  lock_ref.set(
      {
          'leaseExpiresAt': (
              datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(seconds=1)
          )
      },
      merge=True,
  )
  recovered = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '2'},
  )
  final_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert active_redelivery.status_code == 503
  assert recovered.status_code == 200
  assert action_calls == ['called']
  assert transition_attempts == 2
  assert final_state['state'] == 'succeeded'
  assert final_state['recoveryOnly'] is True


def test_last_queue_attempt_persists_terminal_failure(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')

  def fail_recovery(*_args, **_kwargs):
    try:
      raise ValueError('completion cache unavailable')
    except ValueError as cause:
      raise orch.util_errors.RetryableTaskRecoveryError(
          'recovery failed'
      ) from cause

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fail_recovery)
  payload = _task_payload(execution_id='terminal-task')
  headers = {
      'X-CloudTasks-QueueName': 'queue-terminal',
      'X-CloudTasks-TaskName': 'task-terminal',
      'X-CloudTasks-TaskRetryCount': '29',
  }

  response = orch.app.test_client().post(
      '/triggerAction', json=payload, headers=headers
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(
          'terminal-task', 'node-1', 'group-1'
      )
      .get()
      .to_dict()
  )
  expected_token = hashlib.sha256(
      json.dumps(
          [
              'cloud-tasks',
              'queue-terminal',
              'task-terminal',
              'terminal-task',
              'node-1',
              'group-1',
          ],
          ensure_ascii=True,
          separators=(',', ':'),
      ).encode('utf-8')
  ).hexdigest()

  assert response.status_code == 200
  assert state['state'] == 'failed'
  assert state['attempt'] == 30
  assert state['taskToken'] == expected_token
  assert state['error'] == 'ValueError: completion cache unavailable'


@pytest.mark.parametrize('transition_failure', ('exception', 'lost-owner'))
def test_last_queue_attempt_is_not_acknowledged_without_terminal_state(
    monkeypatch, orchestrator_module, transition_failure
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')

  def fail_recovery(*_args, **_kwargs):
    raise orch.util_errors.RetryableTaskRecoveryError('recovery failed')

  def fail_terminal_transition(*_args, **_kwargs):
    if transition_failure == 'exception':
      raise google_exceptions.DeadlineExceeded('Firestore unavailable')
    return False

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fail_recovery)
  monkeypatch.setattr(
      orch.orchestrator.db, 'mark_task_failed', fail_terminal_transition
  )
  payload = _task_payload(execution_id=f'terminal-state-{transition_failure}')
  response = orch.app.test_client().post(
      '/triggerAction',
      json=payload,
      headers={
          'X-CloudTasks-QueueName': 'queue-terminal-state',
          'X-CloudTasks-TaskName': f'task-terminal-{transition_failure}',
          'X-CloudTasks-TaskRetryCount': '29',
      },
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(
          payload['executionId'], 'node-1', 'group-1'
      )
      .get()
      .to_dict()
  )

  assert response.status_code == 503
  assert state['state'] == 'running'
  assert state['attempt'] == 30


def test_penultimate_queue_attempt_remains_retryable(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')

  def fail_recovery(*_args, **_kwargs):
    raise orch.util_errors.RetryableTaskRecoveryError('recovery failed')

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fail_recovery)
  payload = _task_payload(execution_id='penultimate-task')
  response = orch.app.test_client().post(
      '/triggerAction',
      json=payload,
      headers={
          'X-CloudTasks-QueueName': 'queue-terminal',
          'X-CloudTasks-TaskName': 'task-penultimate',
          'X-CloudTasks-TaskRetryCount': '28',
      },
  )
  state = (
      orch.orchestrator.db._get_task_lock_ref(
          'penultimate-task', 'node-1', 'group-1'
      )
      .get()
      .to_dict()
  )

  assert response.status_code == 503
  assert state['state'] == 'retryable'
  assert state['attempt'] == 29


def test_trigger_action_completed_manifest_read_failure_never_regenerates(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  first_output = {'outpainted_image': [{'file': 'generated/first.png'}]}
  cache = {}
  action_calls = []
  stored_outputs = []
  store_attempts = 0

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return first_output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(
      monkeypatch,
      orch,
      cache,
      download_errors=[
          google_exceptions.RetryError(
              'GCS retry deadline exhausted',
              ConnectionError('GCS connection reset'),
          )
      ],
  )
  transitions = _install_task_state(monkeypatch, orch)

  def store_once(*args):
    nonlocal store_attempts
    store_attempts += 1
    if store_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore deadline exceeded')
    stored_outputs.append(args[-1])

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', store_once)
  payload = _task_payload(action='outpaint_image', force_execution=True)
  client = orch.app.test_client()
  headers = _task_headers('queue-a', 'task-a')
  responses = [client.post('/triggerAction', json=payload, headers=headers)]
  for retry_count in (1, 2):
    responses.append(
        client.post(
            '/triggerAction',
            json=payload,
            headers={
                **headers,
                'X-CloudTasks-TaskRetryCount': str(retry_count),
            },
        )
    )

  assert [response.status_code for response in responses] == [503, 503, 200]
  assert action_calls == ['called']
  assert store_attempts == 2
  assert stored_outputs == [first_output]
  assert [state for state, _args in transitions] == [
      'retryable',
      'retryable',
      'succeeded',
  ]
  completion_paths = [
      path for path in cache if path.startswith('_task-completions/')
  ]
  assert len(completion_paths) == 1
  assert json.loads(cache[completion_paths[0]]) == first_output


def test_recovery_only_state_never_regenerates_a_missing_manifest(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  output = {'outpainted_image': [{'file': 'generated/first.png'}]}
  cache = {}
  action_calls = []
  store_attempts = 0

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)

  def fail_first_store(*_args):
    nonlocal store_attempts
    store_attempts += 1
    if store_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore deadline exceeded')

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', fail_first_store)
  payload = _task_payload(
      execution_id='missing-recovery-manifest',
      action='outpaint_image',
      force_execution=True,
  )
  headers = _task_headers('queue-recovery-only', 'task-recovery-only')
  client = orch.app.test_client()

  first = client.post('/triggerAction', json=payload, headers=headers)
  lock_ref = orch.orchestrator.db._get_task_lock_ref(
      'missing-recovery-manifest', 'node-1', 'group-1'
  )
  first_state = lock_ref.get().to_dict()
  completion_path = next(
      path for path in cache if path.startswith('_task-completions/')
  )
  cache.pop(completion_path)
  redelivery = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  recovered_state = lock_ref.get().to_dict()

  assert first.status_code == 503
  assert redelivery.status_code == 503
  assert action_calls == ['called']
  assert store_attempts == 1
  assert first_state['state'] == 'retryable'
  assert first_state['recoveryOnly'] is True
  assert recovered_state['state'] == 'retryable'
  assert recovered_state['recoveryOnly'] is True


def test_trigger_action_redelivery_reruns_failed_forced_action(
    monkeypatch, orchestrator_module
):
  """A forced attempt that fails mid-action cannot expose stale cache."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  stale_output = {'outpainted_image': [{'file': 'stale/image.png'}]}
  fresh_output = {'outpainted_image': [{'file': 'generated/image.png'}]}
  cache = {}
  action_calls = []
  stored_outputs = []

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    if len(action_calls) == 1:
      raise google_exceptions.ResourceExhausted('temporary quota exhaustion')
    return fresh_output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  transitions = _install_task_state(monkeypatch, orch)
  monkeypatch.setattr(
      orch.orchestrator.db,
      'store_output',
      lambda *args: stored_outputs.append(args[-1]),
  )

  payload = _task_payload(action='outpaint_image', force_execution=True)
  checksum = orch.orchestrator.actwrap.util_checksum.compute_object_checksum(
      (payload['inputFiles'], payload.get('parameters', {}))
  )
  cache_path = f'outpaint_image/{checksum}.json'
  cache[cache_path] = json.dumps(stale_output)
  client = orch.app.test_client()
  task_headers = _task_headers('queue-rerun', 'task-rerun')

  first = client.post('/triggerAction', json=payload, headers=task_headers)
  retry = client.post(
      '/triggerAction',
      json=payload,
      headers={**task_headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )

  assert first.status_code == 429
  assert retry.status_code == 200
  assert [state for state, _args in transitions] == [
      'retryable',
      'succeeded',
  ]
  assert transitions[0][1][-1] is False
  assert action_calls == ['called', 'called']
  assert stored_outputs == [fresh_output]
  assert json.loads(cache[cache_path]) == fresh_output


def test_retry_header_without_completion_does_not_bypass_forced_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  stale_output = {'outpainted_image': [{'file': 'stale/image.png'}]}
  fresh_output = {'outpainted_image': [{'file': 'fresh/image.png'}]}
  cache = {}
  action_calls = []

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return fresh_output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  transitions = _install_task_state(monkeypatch, orch)
  monkeypatch.setattr(orch.orchestrator.db, 'store_output', lambda *_args: None)
  payload = _task_payload(action='outpaint_image', force_execution=True)
  checksum = orch.orchestrator.actwrap.util_checksum.compute_object_checksum(
      (payload['inputFiles'], payload.get('parameters', {}))
  )
  cache_path = f'outpaint_image/{checksum}.json'
  cache[cache_path] = json.dumps(stale_output)

  response = orch.app.test_client().post(
      '/triggerAction',
      json=payload,
      headers={
          'X-CloudTasks-QueueName': 'queue-header',
          'X-CloudTasks-TaskName': 'task-header',
          'X-CloudTasks-TaskRetryCount': '7',
      },
  )

  assert response.status_code == 200
  assert action_calls == ['called']
  assert json.loads(cache[cache_path]) == fresh_output
  assert transitions[0][0] == 'succeeded'
  assert transitions[0][1][-1] == 8


def test_trigger_action_non_forced_reuses_legacy_cache(
    monkeypatch, orchestrator_module
):
  """Cache entries written before task tokens remain reusable."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  legacy_output = {'outpainted_image': [{'file': 'legacy/image.png'}]}
  cache = {}
  action_calls = []
  stored_outputs = []

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return {'outpainted_image': [{'file': 'unexpected/image.png'}]}

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(monkeypatch, orch, cache)
  transitions = _install_task_state(monkeypatch, orch)
  monkeypatch.setattr(
      orch.orchestrator.db,
      'store_output',
      lambda *args: stored_outputs.append(args[-1]),
  )

  payload = _task_payload(action='outpaint_image')
  checksum = orch.orchestrator.actwrap.util_checksum.compute_object_checksum(
      (payload['inputFiles'], payload.get('parameters', {}))
  )
  cache[f'outpaint_image/{checksum}.json'] = json.dumps(legacy_output)

  response = orch.app.test_client().post(
      '/triggerAction',
      json=payload,
      headers=_task_headers('queue-legacy-cache', 'task-legacy-cache'),
  )

  assert response.status_code == 200
  assert action_calls == []
  assert stored_outputs == [legacy_output]
  assert [state for state, _args in transitions] == ['succeeded']


def test_trigger_action_enqueue_retry_completes_successor_once(
    monkeypatch, orchestrator_module
):
  """An ambiguous successor enqueue is contained by the existing join seal."""
  del orchestrator_module
  orch = _load_orch(monkeypatch)
  successor_deliveries = []
  action_deliveries = []
  _install_action_cache(monkeypatch, orch, {})

  class FakeTasksClient:

    def queue_path(self, *_args):
      return 'projects/test/locations/test/queues/test'

    def create_task(self, *, parent, task):
      del parent
      payload = json.loads(bytes(task.http_request.body))
      if task.http_request.url.endswith('/supplyNode'):
        successor_deliveries.append(payload)
        if len(successor_deliveries) == 1:
          raise google_exceptions.ServiceUnavailable(
              'task accepted before response failed'
          )
      else:
        action_deliveries.append(payload)

  monkeypatch.setattr(
      orch.orchestrator.tasks_v2, 'CloudTasksClient', FakeTasksClient
  )
  monkeypatch.setattr(
      orch.orchestrator, 'service_account_email', 'worker@example.com'
  )

  payload = _task_payload(execution_id='enqueue-retry', node_id='source')
  payload.update({
      'inputFiles': {'image': [{'file': 'uploads/source.png'}]},
      'siblingActions': 1,
      'workflowDefinition': {
          'source': {'action': 'pass', 'input': {'image': None}},
          'sink': {
              'action': 'pass',
              'input': {
                  'image': {'node': 'source', 'output': 'image'},
              },
          },
      },
      'workflowParams': {
          'gcpProject': 'test-project',
          'gcpLocation': 'us-central1',
          'gcsBucket': 'test-bucket',
          'tasksQueuePrefix': 'test-',
      },
  })
  client = orch.app.test_client()
  headers = _task_headers('queue-enqueue-retry', 'task-enqueue-retry')

  first = client.post('/triggerAction', json=payload, headers=headers)
  retry = client.post(
      '/triggerAction',
      json=payload,
      headers={**headers, 'X-CloudTasks-TaskRetryCount': '1'},
  )
  for successor_payload in successor_deliveries:
    assert client.post('/supplyNode', json=successor_payload).status_code == 200
  assert len(action_deliveries) == 1
  assert (
      client.post('/triggerAction', json=action_deliveries[0]).status_code
      == 200
  )
  status = client.get('/getStatus?executionId=enqueue-retry').get_json()

  assert first.status_code == 503
  assert retry.status_code == 200
  assert len(successor_deliveries) == 2
  assert list(status['sink']['output']) == ['0']


def test_trigger_action_non_retryable_error_records_failed_state(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  transitions = _install_task_state(monkeypatch, orch)

  def boom(*_a, **_k):
    raise RuntimeError('fatal')

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', boom)
  monkeypatch.setattr(orch.util_errors, 'is_retryable', lambda _e: False)
  client = orch.app.test_client()
  response = client.post(
      '/triggerAction',
      json=_task_payload(),
      headers=_task_headers('queue-fatal-state', 'task-fatal-state'),
  )
  assert response.status_code == 200
  assert response.get_data(as_text=True) == 'Internal Error'
  assert [state for state, _args in transitions] == ['failed']


def test_trigger_action_rejects_malformed_payload(
    monkeypatch, orchestrator_module
):
  """A task payload missing the required fields is a clean 400, not a 500, and
  the action never runs."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  called = {'trigger': False}
  monkeypatch.setattr(
      orch.orchestrator,
      'trigger_action',
      lambda *a, **k: called.__setitem__('trigger', True),
  )
  client = orch.app.test_client()
  response = client.post(
      '/triggerAction',
      json={'action': 'pass'},
      headers=_task_headers('queue-malformed', 'task-malformed'),
  )
  assert response.status_code == 400
  assert called['trigger'] is False


@pytest.mark.parametrize(
    'headers',
    (
        {},
        {'X-CloudTasks-QueueName': 'queue-only'},
        {'X-CloudTasks-TaskName': 'task-only'},
        {
            'X-CloudTasks-QueueName': 'queue-without-retry',
            'X-CloudTasks-TaskName': 'task-without-retry',
        },
        {'X-CloudTasks-TaskRetryCount': '0'},
        _task_headers(queue_name=''),
        _task_headers(task_name=''),
        _task_headers(retry_count=''),
        _task_headers(retry_count='not-an-integer'),
        _task_headers(retry_count=-1),
    ),
)
def test_trigger_action_rejects_incomplete_task_headers(
    monkeypatch, orchestrator_module, headers
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  called = []
  lock_calls = []
  monkeypatch.setattr(
      orch.orchestrator.db,
      'acquire_task_lock',
      lambda *_args, **_kwargs: lock_calls.append(True),
  )
  monkeypatch.setattr(
      orch.orchestrator,
      'trigger_action',
      lambda *_args, **_kwargs: called.append(True),
  )

  response = orch.app.test_client().post(
      '/triggerAction', json=_task_payload(), headers=headers
  )

  assert response.status_code == 400
  assert lock_calls == []
  assert called == []


def test_role_all_allows_headerless_local_trigger_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='all')
  action_calls = []
  monkeypatch.setattr(
      orch.orchestrator,
      'trigger_action',
      lambda *_args, **_kwargs: action_calls.append(True),
  )
  transitions = _install_task_state(monkeypatch, orch)

  response = orch.app.test_client().post('/triggerAction', json=_task_payload())

  assert response.status_code == 200
  assert action_calls == [True]
  assert [state for state, _args in transitions] == ['succeeded']


def test_trigger_action_attempt_limit_matches_deploy_queue(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  deploy_script = (_REPO / 'deploy.sh').read_text(encoding='utf-8')

  assert orch._MAX_TASK_ATTEMPTS == 30
  assert '--max-attempts=30' in deploy_script


def test_task_lease_outlives_production_request_deadline(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  deploy_script = (_REPO / 'deploy.sh').read_text(encoding='utf-8')

  assert (
      orch.util_database.TASK_LEASE_SECONDS
      > orch.orchestrator._TASK_DISPATCH_DEADLINE_SECONDS
  )
  assert orch.util_database.TASK_LEASE_SECONDS > 1830
  assert '--timeout=1800' in deploy_script
  assert 'GUNICORN_TIMEOUT=1830' in deploy_script


def test_app_worker_url_feeds_api_supply_node(monkeypatch, orchestrator_module):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL=worker_url)

  captured = _capture_supply_node(monkeypatch, orch, 'exec-api')
  client = orch.app.test_client()
  response = client.post('/api/supplyNode', json=_valid_app_submission())
  assert response.status_code == 200
  assert captured['instance'] == worker_url


def _accept_iap(monkeypatch, orch, email='user@example.com'):
  """Stubs IAP verify_token to admit any assertion as the given email."""
  monkeypatch.setattr(
      orch.google_id_token,
      'verify_token',
      lambda *_a, **_k: {'email': email},
  )


# ---------------------------------------------------------------------------
# (e) AUTH_MODE=iap on ROLE=app: /api/* requires a valid IAP JWT assertion;
# static paths stay open.
# ---------------------------------------------------------------------------
def test_iap_auth_gates_api_routes(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch,
      ROLE='app',
      AUTH_MODE='iap',
      IAP_AUDIENCE=_IAP_AUDIENCE,
      WORKER_URL='https://worker-test.a.run.app',
  )
  client = orch.app.test_client()
  captured = _capture_supply_node(monkeypatch, orch, 'exec-iap')

  # Missing IAP assertion header: 401, handler never reached.
  response = client.post('/api/supplyNode', json={'nodeId': 'root'})
  assert response.status_code == 401
  assert 'error' in response.get_json()
  assert 'data' not in captured

  # Invalid assertion: 401.
  def reject(*_args, **_kwargs):
    raise ValueError('bad assertion')

  monkeypatch.setattr(orch.google_id_token, 'verify_token', reject)
  response = client.post(
      '/api/supplyNode',
      json={'nodeId': 'root'},
      headers={'X-Goog-IAP-JWT-Assertion': 'bogus'},
  )
  assert response.status_code == 401
  assert 'data' not in captured

  # Valid (stubbed) assertion: /api/supplyNode reaches the handler.
  _accept_iap(monkeypatch, orch)
  response = client.post(
      '/api/supplyNode',
      json=_valid_app_submission(),
      headers={'X-Goog-IAP-JWT-Assertion': 'iap-jwt'},
  )
  assert response.status_code == 200
  assert response.get_json() == {'executionId': 'exec-iap'}
  assert 'data' in captured

  # /api/getStatus is gated by the same middleware: 401 without the assertion,
  # and reaches its own handler (400 incomplete-parameters) with it.
  assert client.get('/api/getStatus').status_code == 401
  assert (
      client.get(
          '/api/getStatus',
          headers={'X-Goog-IAP-JWT-Assertion': 'iap-jwt'},
      ).status_code
      == 400
  )

  # /api/projects is gated too: 401 without the assertion. (FIRESTORE_DB_UI is
  # unset here, so a valid assertion reaches the handler and fails soft at 500
  # rather than passing the gate at 401.)
  assert client.get('/api/projects').status_code == 401
  assert (
      client.get(
          '/api/projects',
          headers={'X-Goog-IAP-JWT-Assertion': 'iap-jwt'},
      ).status_code
      == 500
  )

  # Static paths are NOT gated (served from real repo files).
  assert client.get('/definitions/actions.json').status_code == 200
  assert client.get('/status').status_code == 200


# ---------------------------------------------------------------------------
# (f) AUTH_MODE=iap on ROLE=app: the IAP JWT assertion is verified against the
# configured audience and certs URL; the Firebase custom-token bridge no longer
# exists (the client signs in via IAP directly, not Firebase Auth).
# ---------------------------------------------------------------------------
def test_iap_verifies_assertion_and_no_firebase_bridge(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch,
      ROLE='app',
      AUTH_MODE='iap',
      IAP_AUDIENCE=_IAP_AUDIENCE,
      WORKER_URL='https://worker-test.a.run.app',
  )
  client = orch.app.test_client()

  # The custom-token bridge is gone in every mode, including iap.
  assert '/api/firebaseCustomToken' not in _rules(orch.app)

  # The IAP assertion is verified with the configured audience and certs URL.
  captured = {}

  def accept(assertion, request, audience=None, certs_url=None):
    del request
    captured['assertion'] = assertion
    captured['audience'] = audience
    captured['certs_url'] = certs_url
    return {'email': 'christopher@example.com'}

  monkeypatch.setattr(orch.google_id_token, 'verify_token', accept)
  _capture_supply_node(monkeypatch, orch, 'exec-iap')
  response = client.post(
      '/api/supplyNode',
      json=_valid_app_submission(),
      headers={'X-Goog-IAP-JWT-Assertion': 'iap-jwt-assertion'},
  )
  assert response.status_code == 200
  assert captured['assertion'] == 'iap-jwt-assertion'
  assert captured['audience'] == _IAP_AUDIENCE
  assert captured['certs_url'] == _IAP_CERTS_URL


def test_iap_requires_audience(monkeypatch, orchestrator_module):
  del orchestrator_module
  with pytest.raises(RuntimeError, match='IAP_AUDIENCE'):
    _load_orch(monkeypatch, ROLE='app', AUTH_MODE='iap')
  # Leave a coherent module behind for subsequent tests.
  _load_orch(monkeypatch)


def test_firebase_custom_token_route_removed(monkeypatch, orchestrator_module):
  del orchestrator_module
  # The custom-token bridge has been removed; the default ('none') app posture
  # does not register it (and neither does iap; see the iap test above).
  orch = _load_orch(
      monkeypatch, ROLE='app', WORKER_URL='https://worker-test.a.run.app'
  )
  assert '/api/firebaseCustomToken' not in _rules(orch.app)


# ---------------------------------------------------------------------------
# Static serving on ROLE=app: SPA with index.html fallback, registered
# after (= losing to) /api/* and /definitions/*.
# ---------------------------------------------------------------------------
def test_app_serves_spa_with_index_fallback(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch, ROLE='app', WORKER_URL='https://worker-test.a.run.app'
  )

  spa_dir = tmp_path / 'browser'
  (spa_dir / 'assets').mkdir(parents=True)
  (spa_dir / 'index.html').write_text('<html>spa-index</html>')
  (spa_dir / 'main.js').write_text('console.log("main");')
  (spa_dir / 'assets' / 'logo.svg').write_text('<svg/>')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)

  client = orch.app.test_client()
  # Existing files are served as-is.
  assert client.get('/main.js').data == b'console.log("main");'
  assert client.get('/assets/logo.svg').data == b'<svg/>'
  # Root and unknown (Angular router) paths fall back to index.html.
  assert client.get('/').data == b'<html>spa-index</html>'
  assert client.get('/some/deep/route').data == b'<html>spa-index</html>'
  # Unknown /api/ paths are NOT swallowed by the SPA fallback.
  assert client.get('/api/doesNotExist').status_code == 404


def test_app_serves_definitions_and_status_viewer(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch, ROLE='app', WORKER_URL='https://worker-test.a.run.app'
  )
  client = orch.app.test_client()

  # Real repo files: ui/definitions/ and ui/remix-engine-status-viewer/.
  assert client.get('/definitions/actions.json').status_code == 200
  response = client.get('/status')
  assert response.status_code == 200
  assert b'<' in response.data  # serves status.html for the bare /status
  assert client.get('/status/re.css').status_code == 200


# Helpers for the ROLE=app submission-validation tests below.
def _video_node(model, location):
  return {
      'workflowId': 'workflow-video-test',
      'nodeId': 'n',
      'inputFiles': {},
      'workflowDefinition': {
          'n': {
              'action': 'generate_video',
              'parameters': {'model': model, 'gcp_location': location},
          }
      },
  }


def _app_submit(monkeypatch, orch, body):
  captured = _capture_supply_node(monkeypatch, orch)
  response = orch.app.test_client().post('/api/supplyNode', json=body)
  return response, captured


def _app_submit_without_side_effects(monkeypatch, orch, body):
  stored = []
  tasks = []
  monkeypatch.setattr(
      orch.orchestrator.db,
      'store_workflow',
      lambda *args, **kwargs: stored.append((args, kwargs)),
  )

  class UnexpectedTasksClient:

    def __init__(self, *args, **kwargs):
      tasks.append((args, kwargs))

  monkeypatch.setattr(
      orch.orchestrator.tasks_v2, 'CloudTasksClient', UnexpectedTasksClient
  )
  response = orch.app.test_client().post('/api/supplyNode', json=body)
  return response, stored, tasks


def _valid_app_submission():
  return {
      'workflowId': 'workflow-test',
      'nodeId': 'root',
      'workflowDefinition': {'root': {'action': 'pass'}},
      'inputFiles': {},
  }


# ---------------------------------------------------------------------------
# (g) ROLE=app validates the submission against the model allowlist before
# anything is stored or a task runs. The worker route is exempt by role.
# ---------------------------------------------------------------------------
def test_app_rejects_empty_submission_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, {}
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


@pytest.mark.parametrize('node', [
    {'action': 'weird', 'input': {}},
    {'action': 'weird'},  # no node input: the action shape still matters
])
def test_app_rejects_malformed_action_definition_before_side_effects(
    monkeypatch, orchestrator_module, node
):
  """A malformed actions.json entry must not crash the server (regression)."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  monkeypatch.setattr(
      orch.submission_validation,
      '_load_actions_json',
      lambda: {'weird': 'not-a-dict'},
  )
  body = {
      'workflowId': 'workflow-test',
      'nodeId': 'root',
      'workflowDefinition': {'root': node},
      'inputFiles': {},
  }
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MALFORMED_SUBMISSION'
  assert stored == []
  assert tasks == []


@pytest.mark.parametrize(
    'field', ('input', 'parameters', 'dimensionsMapping', 'dimensionsConsumed')
)
def test_app_rejects_explicit_null_node_field_before_side_effects(
    monkeypatch, orchestrator_module, field
):
  """An explicit null reached the engine and 500'd AFTER storing (regression)."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  node = {'action': 'pass'}
  node[field] = None
  body = {
      'workflowId': 'workflow-test',
      'nodeId': 'root',
      'workflowDefinition': {'root': node},
      'inputFiles': {},
  }
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MALFORMED_SUBMISSION'
  assert stored == []
  assert tasks == []


@pytest.mark.parametrize(
    'missing_field',
    ('workflowId', 'nodeId', 'workflowDefinition', 'inputFiles'),
)
def test_app_rejects_missing_required_field_before_side_effects(
    monkeypatch, orchestrator_module, missing_field
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  del body[missing_field]
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


@pytest.mark.parametrize(
    'mutate',
    (
        lambda body: body.update(workflowId='workflow/child'),
        lambda body: body.update(
            nodeId='root/child',
            workflowDefinition={'root/child': {'action': 'pass'}},
        ),
        lambda body: body['workflowDefinition'].update(
            {'later/node': {'action': 'pass'}},
        ),
        lambda body: body.update(
            workflowDefinition={
                'root': {'action': 'pass', 'input': {'image/main': None}},
            },
            inputFiles={'image/main': []},
        ),
        lambda body: body.update(groupId='group/child'),
    ),
)
def test_app_rejects_firestore_hostile_paths_before_side_effects(
    monkeypatch, orchestrator_module, mutate
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  mutate(body)
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_unknown_action_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition']['root']['action'] = 'definitely_not_an_action'
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'ACTION_UNDEFINED'
  assert stored == []
  assert tasks == []


def test_app_rejects_empty_input_edge_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition']['root']['input'] = {'image': {}}
  body['inputFiles'] = {'image': [{'file': 'gs://bucket/image.png'}]}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_missing_selected_input_group_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition']['root']['input'] = {'image': None}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_downstream_null_source_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition'] = {
      'root': {'action': 'pass', 'input': {'image': None}},
      'next': {'action': 'pass', 'input': {'image': None}},
  }
  body['inputFiles'] = {'image': [{'file': 'gs://bucket/image.png'}]}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_unknown_predecessor_output_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition'] = {
      'root': {'action': 'pass', 'input': {'image': None}},
      'next': {
          'action': 'outpaint_image',
          'input': {
              'image': {'node': 'root', 'output': 'does_not_exist'},
          },
          'parameters': {
              'image_model': 'gemini-3-pro-image',
              'image_model_location': 'global',
          },
      },
  }
  body['inputFiles'] = {'image': [{'file': 'gs://bucket/image.png'}]}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_non_string_predecessor_action_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['nodeId'] = 'a_root'
  body['workflowDefinition'] = {
      'a_root': {'action': 'pass', 'input': {'image': None}},
      'b_next': {
          'action': 'outpaint_image',
          'input': {
              'image': {'node': 'z_bad', 'output': 'image'},
          },
          'parameters': {
              'image_model': 'gemini-3-pro-image',
              'image_model_location': 'global',
          },
      },
      'z_bad': {'action': ['generate_image']},
  }
  body['inputFiles'] = {'image': [{'file': 'gs://bucket/image.png'}]}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MALFORMED_SUBMISSION'
  assert stored == []
  assert tasks == []


def test_app_rejects_undeclared_consumer_input_before_side_effects(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _valid_app_submission()
  body['workflowDefinition'] = {
      'root': {'action': 'pass', 'input': {'image': None}},
      'next': {
          'action': 'outpaint_image',
          'input': {
              'prompt': {'node': 'root', 'output': 'image'},
          },
          'parameters': {
              'image_model': 'gemini-3-pro-image',
              'image_model_location': 'global',
          },
      },
  }
  body['inputFiles'] = {'image': [{'file': 'gs://bucket/image.png'}]}
  response, stored, tasks = _app_submit_without_side_effects(
      monkeypatch, orch, body
  )
  assert response.status_code == 400
  assert stored == []
  assert tasks == []


def test_app_rejects_rogue_model(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, captured = _app_submit(
      monkeypatch, orch, _video_node('rogue', 'global')
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MODEL_NOT_ALLOWED'
  assert captured == {}  # nothing stored, no task scheduled


def test_app_rejects_disallowed_location(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, captured = _app_submit(
      monkeypatch, orch, _video_node('veo-3.1-generate-001', 'europe-west4')
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MODEL_LOCATION_PAIR_INVALID'
  assert captured == {}


def test_app_rejects_client_execution_id(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  body = _video_node('veo-3.1-generate-001', 'global')
  body['executionId'] = 'exec-injected'
  response, captured = _app_submit(monkeypatch, orch, body)
  assert response.status_code == 400
  assert response.get_json()['code'] == 'EXECUTION_ID_NOT_ALLOWED'
  assert captured == {}


def test_app_accepts_valid_submission(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, captured = _app_submit(
      monkeypatch, orch, _video_node('veo-3.1-generate-001', 'global')
  )
  assert response.status_code == 200
  assert 'data' in captured  # the node reached orchestrator.supply_node


def test_worker_route_does_not_validate(monkeypatch, orchestrator_module):
  # Leak detector: a rogue model on the worker route is NOT rejected --
  # validation runs only on the app role.
  del orchestrator_module
  orch = _load_orch(
      monkeypatch, ROLE='worker', WORKER_URL='https://w.a.run.app'
  )
  captured = _capture_supply_node(monkeypatch, orch)
  response = orch.app.test_client().post(
      '/supplyNode', json=_video_node('rogue', 'global')
  )
  assert response.status_code == 200
  assert 'data' in captured


def test_role_all_with_iap_is_refused(monkeypatch, orchestrator_module):
  # A public (IAP) service must run ROLE=app so submissions are validated;
  # ROLE=all skips validation and is dev-only. The misconfiguration must fail
  # fast at import rather than silently serving an unvalidated route.
  del orchestrator_module
  with pytest.raises(RuntimeError, match='ROLE=all'):
    _load_orch(monkeypatch, ROLE='all', AUTH_MODE='iap')
