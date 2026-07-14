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
  response = client.post('/api/supplyNode', json={'nodeId': 'root'})
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


def _install_action_cache(
    monkeypatch,
    orch,
    cache,
    *,
    exists_errors=None,
    download_errors=None,
    download_overwrite=None,
):
  """Installs an in-memory action cache for trigger-action tests."""
  cache_metadata = {}
  cache_generations = {}
  pending_exists_errors = list(exists_errors or [])
  pending_download_errors = list(download_errors or [])
  overwrite_pending = download_overwrite is not None

  class CacheBlob:

    def __init__(self, path):
      self.path = path
      self.metadata = None
      self.generation = None

    def exists(self):
      if pending_exists_errors:
        raise pending_exists_errors.pop(0)
      return self.path in cache

    def reload(self):
      self.metadata = cache_metadata.get(self.path)
      self.generation = cache_generations.get(self.path)

    def download_as_string(self, if_generation_match=None, **_kwargs):
      nonlocal overwrite_pending
      if pending_download_errors:
        raise pending_download_errors.pop(0)
      if overwrite_pending:
        cache[self.path] = json.dumps(download_overwrite)
        cache_metadata[self.path] = {}
        cache_generations[self.path] = cache_generations.get(self.path, 0) + 1
        overwrite_pending = False
      if (
          if_generation_match is not None
          and if_generation_match != cache_generations.get(self.path)
      ):
        raise google_exceptions.PreconditionFailed('generation changed')
      return cache[self.path]

    def upload_from_string(self, data, **_kwargs):
      cache[self.path] = data
      cache_metadata[self.path] = self.metadata
      cache_generations[self.path] = cache_generations.get(self.path, 0) + 1

  class CacheBucket:

    def blob(self, path):
      return CacheBlob(path)

  class CacheGcs:

    def __init__(self, *_args, **_kwargs):
      self.gcs_bucket = CacheBucket()

  monkeypatch.setattr(orch.orchestrator.actwrap.gcs_wrapper, 'GCS', CacheGcs)


def test_worker_url_overrides_host_for_trigger_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL=worker_url)

  captured = {}

  def fake_trigger_action(data, instance, may_retry, recover_forced_cache):
    captured['data'] = data
    captured['instance'] = instance
    captured['may_retry'] = may_retry
    captured['recover_forced_cache'] = recover_forced_cache

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', fake_trigger_action)
  # First valid delivery acquires the PR #113 Cloud Tasks lock and runs.
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *a, **k: True
  )
  client = orch.app.test_client()
  response = client.post('/triggerAction', json=_task_payload())
  assert response.status_code == 200
  assert captured['instance'] == worker_url
  assert captured['may_retry'] is True
  assert captured['recover_forced_cache'] is False


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
  # The lock is already held by another delivery.
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *a, **k: False
  )
  client = orch.app.test_client()
  response = client.post('/triggerAction', json=_task_payload())
  assert response.status_code == 200
  assert response.get_data(as_text=True) == 'Already Triggered'
  assert called['trigger'] is False


def test_trigger_action_retryable_error_releases_lock(
    monkeypatch, orchestrator_module
):
  """PR #113: a retryable failure releases the lock (so Cloud Tasks can retry)
  and returns 429."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  released = []
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *a, **k: True
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'release_task_lock',
      lambda *a, **k: released.append(a),
  )

  def boom(*_a, **_k):
    raise RuntimeError('quota exceeded')

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', boom)
  monkeypatch.setattr(orch.util_errors, 'is_retryable', lambda _e: True)
  client = orch.app.test_client()
  response = client.post('/triggerAction', json=_task_payload())
  assert response.status_code == 429
  assert len(released) == 1


def test_trigger_action_post_action_deadline_releases_lock(
    monkeypatch, orchestrator_module
):
  """A transient output-write failure is retried after the action completes."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  released = []
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *a, **k: True
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'release_task_lock',
      lambda *a, **k: released.append(a),
  )

  def unavailable(*_args, **_kwargs):
    raise google_exceptions.DeadlineExceeded('Firestore deadline exceeded')

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', unavailable)

  response = orch.app.test_client().post('/triggerAction', json=_task_payload())

  assert response.status_code == 503
  assert released == [('exec-worker', 'node-1', 'group-1')]


@pytest.mark.parametrize(
    'scenario',
    ('normal', 'lookup_error', 'download_error', 'generation_race'),
)
def test_trigger_action_redelivery_recovers_forced_action_cache(
    monkeypatch, orchestrator_module, scenario
):
  """Forced recovery is task-scoped, race-safe, and retryable."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  first_output = {'outpainted_image': [{'file': 'generated/first.png'}]}
  rerun_output = {'outpainted_image': [{'file': 'generated/rerun.png'}]}
  concurrent_output = {'outpainted_image': [{'file': 'other/task.png'}]}
  cache = {}
  action_calls = []
  released = []
  stored_outputs = []
  store_attempts = 0

  def paid_action(_gcs, _workflow_params):
    action_calls.append('called')
    return first_output if len(action_calls) == 1 else rerun_output

  paid_action.__module__ = 'actions.outpaint_image'
  monkeypatch.setattr(
      orch.orchestrator.actwrap, 'get_action_by_name', lambda _name: paid_action
  )
  _install_action_cache(
      monkeypatch,
      orch,
      cache,
      exists_errors=(
          [
              google_exceptions.RetryError(
                  'GCS retry deadline exhausted',
                  google_exceptions.TooManyRequests('GCS quota exhausted'),
              )
          ]
          if scenario == 'lookup_error'
          else None
      ),
      download_errors=(
          [
              google_exceptions.RetryError(
                  'GCS retry deadline exhausted',
                  ConnectionError('GCS connection reset'),
              )
          ]
          if scenario == 'download_error'
          else None
      ),
      download_overwrite=(
          concurrent_output if scenario == 'generation_race' else None
      ),
  )
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *_a, **_k: True
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'release_task_lock',
      lambda *args, **_kwargs: released.append(args),
  )

  def store_once(*args):
    nonlocal store_attempts
    store_attempts += 1
    if store_attempts == 1:
      raise google_exceptions.DeadlineExceeded('Firestore deadline exceeded')
    stored_outputs.append(args[-1])

  monkeypatch.setattr(orch.orchestrator.db, 'store_output', store_once)
  payload = _task_payload(action='outpaint_image', force_execution=True)
  checksum = orch.orchestrator.actwrap.util_checksum.compute_object_checksum(
      (payload['inputFiles'], payload.get('parameters', {}))
  )
  cache_path = f'outpaint_image/{checksum}.json'
  client = orch.app.test_client()

  recovery_error = scenario in ('lookup_error', 'download_error')
  delivery_count = 3 if recovery_error else 2
  responses = []
  for retry_count in range(delivery_count):
    headers = (
        {'X-CloudTasks-TaskRetryCount': str(retry_count)}
        if retry_count
        else None
    )
    responses.append(
        client.post('/triggerAction', json=payload, headers=headers)
    )

  expected_statuses = [503, 503, 200] if recovery_error else [503, 200]
  expected_output = (
      rerun_output if scenario == 'generation_race' else first_output
  )
  expected_action_calls = 2 if scenario == 'generation_race' else 1

  assert [response.status_code for response in responses] == expected_statuses
  assert released == [('exec-worker', 'node-1', 'group-1')] * (
      len(expected_statuses) - 1
  )
  assert action_calls == ['called'] * expected_action_calls
  assert store_attempts == 2
  assert stored_outputs == [expected_output]
  assert json.loads(cache[cache_path]) == expected_output


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
  released = []
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
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *_a, **_k: True
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'release_task_lock',
      lambda *args, **_kwargs: released.append(args),
  )
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

  first = client.post('/triggerAction', json=payload)
  retry = client.post(
      '/triggerAction',
      json=payload,
      headers={'X-CloudTasks-TaskRetryCount': '1'},
  )

  assert first.status_code == 429
  assert retry.status_code == 200
  assert released == [('exec-worker', 'node-1', 'group-1')]
  assert action_calls == ['called', 'called']
  assert stored_outputs == [fresh_output]
  assert json.loads(cache[cache_path]) == fresh_output


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
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *_a, **_k: True
  )
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

  response = orch.app.test_client().post('/triggerAction', json=payload)

  assert response.status_code == 200
  assert action_calls == []
  assert stored_outputs == [legacy_output]


def test_trigger_action_enqueue_retry_completes_successor_once(
    monkeypatch, orchestrator_module
):
  """An ambiguous successor enqueue is contained by the existing join seal."""
  del orchestrator_module
  orch = _load_orch(monkeypatch)
  successor_deliveries = []
  action_deliveries = []
  locks = set()

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

  def acquire_lock(execution_id, node_id, group_id):
    key = (execution_id, node_id, str(group_id))
    if key in locks:
      return False
    locks.add(key)
    return True

  def release_lock(execution_id, node_id, group_id):
    locks.discard((execution_id, node_id, str(group_id)))

  monkeypatch.setattr(
      orch.orchestrator.tasks_v2, 'CloudTasksClient', FakeTasksClient
  )
  monkeypatch.setattr(
      orch.orchestrator, 'service_account_email', 'worker@example.com'
  )
  monkeypatch.setattr(orch.orchestrator.db, 'acquire_task_lock', acquire_lock)
  monkeypatch.setattr(orch.orchestrator.db, 'release_task_lock', release_lock)

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

  first = client.post('/triggerAction', json=payload)
  retry = client.post(
      '/triggerAction',
      json=payload,
      headers={'X-CloudTasks-TaskRetryCount': '1'},
  )
  for successor_payload in successor_deliveries:
    assert client.post('/supplyNode', json=successor_payload).status_code == 200
  assert len(action_deliveries) == 1
  assert client.post('/triggerAction', json=action_deliveries[0]).status_code == 200
  status = client.get('/getStatus?executionId=enqueue-retry').get_json()

  assert first.status_code == 503
  assert retry.status_code == 200
  assert len(successor_deliveries) == 2
  assert list(status['sink']['output']) == ['0']


def test_trigger_action_non_retryable_error_keeps_lock(
    monkeypatch, orchestrator_module
):
  """PR #113: a non-retryable failure does NOT release the lock (no retry) and
  returns the existing non-retry response."""
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  released = []
  monkeypatch.setattr(
      orch.orchestrator.db, 'acquire_task_lock', lambda *a, **k: True
  )
  monkeypatch.setattr(
      orch.orchestrator.db,
      'release_task_lock',
      lambda *a, **k: released.append(a),
  )

  def boom(*_a, **_k):
    raise RuntimeError('fatal')

  monkeypatch.setattr(orch.orchestrator, 'trigger_action', boom)
  monkeypatch.setattr(orch.util_errors, 'is_retryable', lambda _e: False)
  client = orch.app.test_client()
  response = client.post('/triggerAction', json=_task_payload())
  assert response.status_code == 200
  assert response.get_data(as_text=True) == 'Internal Error'
  assert released == []


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
  response = client.post('/triggerAction', json={'action': 'pass'})
  assert response.status_code == 400
  assert called['trigger'] is False


def test_app_worker_url_feeds_api_supply_node(monkeypatch, orchestrator_module):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL=worker_url)

  captured = _capture_supply_node(monkeypatch, orch, 'exec-api')
  client = orch.app.test_client()
  response = client.post('/api/supplyNode', json={'nodeId': 'root'})
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
      json={'nodeId': 'root'},
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
      json={'nodeId': 'root'},
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
      'nodeId': 'n',
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


# ---------------------------------------------------------------------------
# (g) ROLE=app validates the submission against the model allowlist before
# anything is stored or a task runs. The worker route is exempt by role.
# ---------------------------------------------------------------------------
def test_app_rejects_rogue_model(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, captured = _app_submit(
      monkeypatch, orch, _video_node('rogue', 'global'))
  assert response.status_code == 400
  assert response.get_json()['code'] == 'MODEL_NOT_ALLOWED'
  assert captured == {}  # nothing stored, no task scheduled


def test_app_rejects_disallowed_location(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://w.a.run.app')
  response, captured = _app_submit(
      monkeypatch, orch, _video_node('veo-3.1-generate-001', 'europe-west4'))
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
      monkeypatch, orch, _video_node('veo-3.1-generate-001', 'global'))
  assert response.status_code == 200
  assert 'data' in captured  # the node reached orchestrator.supply_node


def test_worker_route_does_not_validate(monkeypatch, orchestrator_module):
  # Leak detector: a rogue model on the worker route is NOT rejected --
  # validation runs only on the app role.
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL='https://w.a.run.app')
  captured = _capture_supply_node(monkeypatch, orch)
  response = orch.app.test_client().post(
      '/supplyNode', json=_video_node('rogue', 'global'))
  assert response.status_code == 200
  assert 'data' in captured


def test_role_all_with_iap_is_refused(monkeypatch, orchestrator_module):
  # A public (IAP) service must run ROLE=app so submissions are validated;
  # ROLE=all skips validation and is dev-only. The misconfiguration must fail
  # fast at import rather than silently serving an unvalidated route.
  del orchestrator_module
  with pytest.raises(RuntimeError, match='ROLE=all'):
    _load_orch(monkeypatch, ROLE='all', AUTH_MODE='iap')
