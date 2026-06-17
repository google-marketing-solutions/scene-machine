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
# (f) ROLE unset (default 'all'): exactly today's three root routes, no
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
# (a) ROLE=worker: /supplyNode + /triggerAction only; no /api/*, no
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
# (b) ROLE=app: /api/supplyNode + /api/getStatus; the bare worker routes
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
# (c) WORKER_URL overrides the Host-derived Cloud Tasks callback base in
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
    execution_id='exec-worker', node_id='node-1', group_id='group-1'
):
  """A valid Cloud Tasks /triggerAction payload, including the PR #113 lock
  fields (executionId / nodeId / groupId / workflowDefinition)."""
  return {
      'action': 'pass',
      'inputFiles': {},
      'executionId': execution_id,
      'nodeId': node_id,
      'groupId': group_id,
      'workflowDefinition': {node_id: {'action': 'pass'}},
  }


def test_worker_url_overrides_host_for_trigger_action(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  worker_url = 'https://worker-abc123-uc.a.run.app'
  orch = _load_orch(monkeypatch, ROLE='worker', WORKER_URL=worker_url)

  captured = {}

  def fake_trigger_action(data, instance, may_retry):
    captured['data'] = data
    captured['instance'] = instance
    captured['may_retry'] = may_retry

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
# (d) AUTH_MODE=iap on ROLE=app: /api/* requires a valid IAP JWT assertion;
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
# (e) AUTH_MODE=iap on ROLE=app: the IAP JWT assertion is verified against the
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
