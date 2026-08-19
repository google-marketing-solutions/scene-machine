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

"""Tests for the mediated data-plane endpoints in orch.py.

Follows the fixture pattern of test/test_frontdoor.py: env vars are set
via monkeypatch BEFORE (re)importing orch, and orchestrator's import-time
side effects are neutralised by the shared orchestrator_module fixture.
The GCS and UI-Firestore
clients are replaced with in-memory fakes by presetting orch's lazy
module-level singletons, and the cached signing-credentials factory is
stubbed so no test performs network I/O.
"""

import copy
import datetime
import importlib
import pathlib
import sys
import threading
import uuid

from google.api_core import exceptions as google_exceptions

# Reused module-scoped fixture; pytest picks it up from this namespace.
from test.test_frontdoor import orchestrator_module  # noqa: F401  pylint: disable=unused-import
from util import model_allowlist

_REPO = pathlib.Path(__file__).resolve().parent.parent
_BUCKET = 'frontdoor-data-test-bucket'

_ENV_VARS = (
    'ROLE',
    'AUTH_MODE',
    'WORKER_URL',
    'IAP_AUDIENCE',
    'FIRESTORE_DB_UI',
)

_IAP_AUDIENCE = '/projects/123456/locations/us-central1/services/app'

_DATA_ROUTES = (
    '/api/uploadUrl',
    '/api/signUrl',
    '/api/config',
    '/api/projects',
    '/api/projects/<project_id>',
    '/api/templates',
    '/api/templates/<template_id>',
)


# ---------------------------------------------------------------------------
# In-memory fakes
# ---------------------------------------------------------------------------
class FakeBlob:
  """GCS blob fake: membership-checked exists() and templated URLs."""

  def __init__(self, objects, bucket_name, name):
    self._objects = objects
    self.bucket_name = bucket_name
    self.name = name

  def exists(self, *args, **kwargs):
    del args, kwargs
    return (self.bucket_name, self.name) in self._objects

  def generate_signed_url(
      self,
      version=None,
      expiration=None,
      method='GET',
      credentials=None,
      content_type=None,
      **kwargs,
  ):
    del version, expiration, credentials, kwargs
    suffix = f'&ct={content_type}' if content_type else ''
    return (
        f'https://signed.example/{self.bucket_name}/{self.name}'
        f'?method={method}{suffix}'
    )


class FakeBucket:

  def __init__(self, objects, name):
    self._objects = objects
    self.name = name

  def blob(self, name):
    return FakeBlob(self._objects, self.name, name)


class FakeStorageClient:
  """Drop-in for the storage.Client singleton over a set of object keys."""

  def __init__(self):
    self.objects = set()  # {(bucket_name, object_path)}

  def bucket(self, name):
    return FakeBucket(self.objects, name)


class FakeSnapshot:

  def __init__(self, doc_id, data):
    self.id = doc_id
    self._data = copy.deepcopy(data) if data is not None else None

  @property
  def exists(self):
    return self._data is not None

  def to_dict(self):
    return copy.deepcopy(self._data)


class FakeDocumentRef:

  def __init__(self, collection, doc_id):
    self._collection = collection
    self.id = doc_id

  def get(self):
    return FakeSnapshot(self.id, self._collection.docs.get(self.id))

  def set(self, data):
    self._collection.docs[self.id] = copy.deepcopy(data)

  def update(self, data):
    self._collection.docs[self.id].update(copy.deepcopy(data))

  def delete(self):
    self._collection.docs.pop(self.id, None)

  def collection(self, name):
    # Document refs are ephemeral, so subcollection state is held on the
    # parent collection keyed by (doc_id, name), matching Firestore's
    # path-addressed model.
    return self._collection.subcollection(self.id, name)


class FakeQuery:
  """Read-side surface used by orch: where(filter=)/order_by/stream."""

  def __init__(self, collection, filters=(), order_field=None):
    self._collection = collection
    self._filters = tuple(filters)
    self._order_field = order_field

  def where(self, filter=None):  # pylint: disable=redefined-builtin
    return FakeQuery(
        self._collection, self._filters + (filter,), self._order_field
    )

  def order_by(self, field):
    return FakeQuery(self._collection, self._filters, field)

  def stream(self):
    items = list(self._collection.docs.items())
    for field_filter in self._filters:
      assert field_filter.op_string == '=='
      items = [
          (doc_id, data)
          for doc_id, data in items
          if data.get(field_filter.field_path) == field_filter.value
      ]
    if self._order_field:
      items.sort(key=lambda item: item[1].get(self._order_field))
    else:
      items.sort(key=lambda item: item[0])
    return [FakeSnapshot(doc_id, data) for doc_id, data in items]


class FakeCollection(FakeQuery):

  def __init__(self):
    super().__init__(self)
    self.docs = {}
    self._subcollections = {}  # (doc_id, name) -> FakeCollection

  def document(self, doc_id):
    return FakeDocumentRef(self, doc_id)

  def add(self, data):
    doc_id = uuid.uuid4().hex
    self.docs[doc_id] = copy.deepcopy(data)
    return None, FakeDocumentRef(self, doc_id)

  def subcollection(self, doc_id, name):
    return self._subcollections.setdefault((doc_id, name), FakeCollection())


class FakeBatch:
  """Buffers create/set/delete writes and commits them atomically."""

  def __init__(self, db):
    self._db = db
    self._ops = []

  def set(self, ref, data):
    self._ops.append(('set', ref, data))

  def create(self, ref, data):
    self._ops.append(('create', ref, data))

  def delete(self, ref):
    self._ops.append(('delete', ref, None))

  def commit(self):
    if self._db.commit_barrier is not None:
      self._db.commit_barrier.wait(timeout=5)
    with self._db.lock:
      for op, ref, _ in self._ops:
        if op == 'create' and ref.id in ref._collection.docs:
          raise google_exceptions.AlreadyExists('document already exists')
      for op, ref, data in self._ops:
        if op in ('create', 'set'):
          ref.set(data)
        else:
          ref.delete()
      self._ops.clear()


class FakeUiDb:
  """Drop-in for the UI-database firestore.Client singleton."""

  def __init__(self):
    self._collections = {}
    self.lock = threading.Lock()
    self.commit_barrier = None

  def collection(self, name):
    return self._collections.setdefault(name, FakeCollection())

  def batch(self):
    return FakeBatch(self)


# ---------------------------------------------------------------------------
# Loaders / helpers
# ---------------------------------------------------------------------------
def _load_orch(monkeypatch, **env):
  """(Re)imports orch with exactly the given front-door env vars set."""
  monkeypatch.chdir(_REPO)
  for var in _ENV_VARS:
    monkeypatch.delenv(var, raising=False)
  for var, value in env.items():
    monkeypatch.setenv(var, value)
  if 'orch' in sys.modules:
    return importlib.reload(sys.modules['orch'])
  return importlib.import_module('orch')


def _load_app(monkeypatch, **env):
  """Loads ROLE=app orch with fake GCS/Firestore singletons injected."""
  env.setdefault('ROLE', 'app')
  env.setdefault('FIRESTORE_DB_UI', 'frontdoor-ui-test')
  # ROLE=app requires a WORKER_URL (or LOCAL_WORKER); orch.py refuses to import
  # an app that would loop Cloud Tasks callbacks into its own SPA.
  env.setdefault('WORKER_URL', 'https://worker-test.a.run.app')
  orch = _load_orch(monkeypatch, **env)
  fake_db = FakeUiDb()
  fake_storage = FakeStorageClient()
  monkeypatch.setattr(orch, '_ui_db', fake_db)
  monkeypatch.setattr(orch, '_storage_client', fake_storage)
  monkeypatch.setattr(orch, '_get_signing_credentials', lambda: None)
  monkeypatch.setitem(orch.config, 'gcsBucket', _BUCKET)
  return orch, fake_db, fake_storage


def _stub_identity(monkeypatch, orch, assertions):
  """Maps IAP assertion strings to verified claims for AUTH_MODE=iap tests."""
  monkeypatch.setattr(
      orch.google_id_token,
      'verify_token',
      lambda assertion, *_a, **_k: assertions[assertion],
  )


def _iap(assertion):
  return {'X-Goog-IAP-JWT-Assertion': assertion}


# ---------------------------------------------------------------------------
# /api/uploadUrl
# ---------------------------------------------------------------------------
def test_upload_url_validates_prefix_and_filename(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  # Prefix whitelist: anything but the two exact prefixes is rejected.
  for bad_prefix in ('evil', '../', '/remix-input', 'remix-input/', '', None):
    response = client.post(
        '/api/uploadUrl',
        json={
            'path': bad_prefix,
            'fileName': 'a-abc.png',
            'contentType': 'image/png',
        },
    )
    assert response.status_code == 400, bad_prefix
    assert 'error' in response.get_json()

  # fileName must not contain '/' or '..' (nor be empty).
  for bad_name in ('../a.png', 'a/../b.png', '/abs.png', 'sub/dir.png', ''):
    response = client.post(
        '/api/uploadUrl',
        json={
            'path': 'remix-input',
            'fileName': bad_name,
            'contentType': 'image/png',
        },
    )
    assert response.status_code == 400, bad_name

  # contentType is required (the signed PUT is bound to it).
  response = client.post(
      '/api/uploadUrl', json={'path': 'thumbnail', 'fileName': 'a-abc.jpeg'}
  )
  assert response.status_code == 400

  # Non-JSON body: clean 400, not a 500.
  response = client.post(
      '/api/uploadUrl', data='not json', content_type='text/plain'
  )
  assert response.status_code == 400

  # Happy path: hashed client name, server-config bucket, PUT bound to
  # the content type. A client-supplied bucket is ignored.
  response = client.post(
      '/api/uploadUrl',
      json={
          'path': 'remix-input',
          'fileName': 'photo-abc123.png',
          'contentType': 'image/png',
          'bucket': 'attacker-bucket',
      },
  )
  assert response.status_code == 200
  body = response.get_json()
  assert body['exists'] is False
  assert body['path'] == 'remix-input/photo-abc123.png'
  assert _BUCKET in body['url'] and 'attacker-bucket' not in body['url']
  assert 'method=GET' in body['url']
  assert 'method=PUT' in body['uploadUrl']
  assert 'ct=image/png' in body['uploadUrl']
  # ARCH2: the GET URL's expiry is returned so the client caches against the
  # server's actual TTL instead of a hard-coded constant.
  assert 'expiresAt' in body and body['expiresAt']


def test_upload_url_rejects_disallowed_content_types(
    monkeypatch, orchestrator_module
):
  """P2#2: the signed PUT binds the content type, so the server allow-lists it.

  Media (image/audio/video), the plain-text workflow payloads, and the
  application/octet-stream fallback the browser uses for typeless Files are
  accepted; anything else (pdf, html, executables, zip, json) is rejected with a
  400 before any URL is signed, so a caller cannot mint a capability to store
  arbitrary, mislabelled content in the bucket.
  """
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  for bad_type in (
      'application/pdf',
      'text/html',
      'application/x-msdownload',
      'application/zip',
      'application/json',
  ):
    response = client.post(
        '/api/uploadUrl',
        json={
            'path': 'remix-input',
            'fileName': 'x-abc.bin',
            'contentType': bad_type,
        },
    )
    assert response.status_code == 400, bad_type
    assert 'error' in response.get_json(), bad_type

  # Every content type the client legitimately uploads must still be accepted.
  for i, good_type in enumerate((
      'image/png',
      'image/jpeg',
      'audio/mpeg',
      'video/mp4',
      'text/plain',
      'application/octet-stream',
  )):
    response = client.post(
        '/api/uploadUrl',
        json={
            'path': 'remix-input',
            'fileName': f'asset-{i}.bin',
            'contentType': good_type,
        },
    )
    assert response.status_code == 200, good_type


def test_upload_url_rejects_oversized_and_invalid_size(
    monkeypatch, orchestrator_module
):
  """P2: when the client declares sizeBytes, the server rejects an oversized or
  invalid declaration before signing, per the upload prefix's limit (the bytes
  go browser->GCS directly, so Flask's request limit does not protect them)."""
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  # Oversized for remix-input (1 GiB cap).
  response = client.post(
      '/api/uploadUrl',
      json={
          'path': 'remix-input',
          'fileName': 'big-abc.bin',
          'contentType': 'video/mp4',
          'sizeBytes': 2 * 1024 * 1024 * 1024,
      },
  )
  assert response.status_code == 400
  assert 'error' in response.get_json()

  # thumbnail has a tighter cap (50 MiB).
  response = client.post(
      '/api/uploadUrl',
      json={
          'path': 'thumbnail',
          'fileName': 't-abc.png',
          'contentType': 'image/png',
          'sizeBytes': 100 * 1024 * 1024,
      },
  )
  assert response.status_code == 400

  # A negative size is rejected as invalid.
  response = client.post(
      '/api/uploadUrl',
      json={
          'path': 'remix-input',
          'fileName': 'neg-abc.png',
          'contentType': 'image/png',
          'sizeBytes': -1,
      },
  )
  assert response.status_code == 400

  # A within-limit declared size is accepted and still signs.
  response = client.post(
      '/api/uploadUrl',
      json={
          'path': 'remix-input',
          'fileName': 'ok-abc.png',
          'contentType': 'image/png',
          'sizeBytes': 5 * 1024 * 1024,
      },
  )
  assert response.status_code == 200


def test_upload_url_existing_object_skips_upload(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, _, fake_storage = _load_app(monkeypatch)
  fake_storage.objects.add((_BUCKET, 'remix-input/photo-abc123.png'))

  response = orch.app.test_client().post(
      '/api/uploadUrl',
      json={
          'path': 'remix-input',
          'fileName': 'photo-abc123.png',
          'contentType': 'image/png',
      },
  )
  assert response.status_code == 200
  body = response.get_json()
  assert body['exists'] is True
  assert body['uploadUrl'] is None  # dedupe: the client skips the PUT
  assert 'method=GET' in body['url']


# ---------------------------------------------------------------------------
# /api/signUrl
# ---------------------------------------------------------------------------
def test_sign_url_batches_paths_and_validates(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  response = client.get(
      '/api/signUrl?path=remix-input/a-abc.png&path=video-gen/out.mp4'
      '&gcsBucket=attacker-bucket'
  )
  assert response.status_code == 200
  body = response.get_json()
  assert set(body['urls']) == {'remix-input/a-abc.png', 'video-gen/out.mp4'}
  for url in body['urls'].values():
    assert _BUCKET in url and 'attacker-bucket' not in url
    assert 'method=GET' in url
  expires_at = datetime.datetime.fromisoformat(body['expiresAt'])
  remaining = expires_at - datetime.datetime.now(datetime.timezone.utc)
  assert (
      datetime.timedelta(hours=23) < remaining <= datetime.timedelta(hours=24)
  )

  for bad_path in ('../etc/passwd', '/abs.png', 'gs://bucket/x', 'a/../b'):
    response = client.get('/api/signUrl', query_string={'path': bad_path})
    assert response.status_code == 400, bad_path
    assert 'error' in response.get_json()

  assert client.get('/api/signUrl').status_code == 400


def test_sign_url_ttl_param_clamped(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  response = client.get('/api/signUrl?path=remix-input/a-abc.png&ttl=10')
  assert response.status_code == 200
  body = response.get_json()
  expires_at = datetime.datetime.fromisoformat(body['expiresAt'])
  remaining = expires_at - datetime.datetime.now(datetime.timezone.utc)
  assert remaining <= datetime.timedelta(seconds=10)

  for bad_ttl in ('0', '86401', '-5', 'abc', '1.5'):
    response = client.get(
        '/api/signUrl', query_string={'path': 'remix-input/a.png', 'ttl': bad_ttl}
    )
    assert response.status_code == 400, bad_ttl


def test_sign_url_caps_and_deduplicates_paths(monkeypatch, orchestrator_module):
  """One request must not exhaust the shared project's signBlob quota: the batch
  size is capped, and repeated paths are signed once (one signBlob RPC per
  distinct path) instead of once per repeated query parameter."""
  del orchestrator_module
  orch, _, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  # Count actual signing calls (one signBlob RPC each) by wrapping the signer.
  signed = []
  real_signed_url = orch._signed_url

  def counting_signed_url(blob, method, expiration, content_type=None):
    signed.append(blob.name)
    return real_signed_url(blob, method, expiration, content_type=content_type)

  monkeypatch.setattr(orch, '_signed_url', counting_signed_url)

  # Duplicate paths are signed once, not once per repeated param.
  response = client.get(
      '/api/signUrl?path=remix-input/a-abc.png'
      '&path=remix-input/a-abc.png&path=remix-input/a-abc.png'
  )
  assert response.status_code == 200
  assert set(response.get_json()['urls']) == {'remix-input/a-abc.png'}
  assert signed == ['remix-input/a-abc.png']

  # A normal batch under the cap returns a signed URL per distinct path.
  signed.clear()
  response = client.get(
      '/api/signUrl?path=remix-input/a-abc.png&path=video-gen/out.mp4'
  )
  assert response.status_code == 200
  assert set(response.get_json()['urls']) == {
      'remix-input/a-abc.png',
      'video-gen/out.mp4',
  }
  assert sorted(signed) == ['remix-input/a-abc.png', 'video-gen/out.mp4']

  # The cap measures DISTINCT paths (real RPC cost), not raw params: the max
  # number of distinct paths, each sent twice (raw count is double the cap), is
  # still accepted and each distinct path is signed exactly once.
  signed.clear()
  at_cap = '&'.join(
      f'path=remix-input/q{i}-abc.png&path=remix-input/q{i}-abc.png'
      for i in range(orch._MAX_SIGN_URL_PATHS)
  )
  response = client.get(f'/api/signUrl?{at_cap}')
  assert response.status_code == 200
  assert len(response.get_json()['urls']) == orch._MAX_SIGN_URL_PATHS
  assert len(signed) == orch._MAX_SIGN_URL_PATHS

  # More than the cap of DISTINCT paths is rejected, and nothing is signed.
  signed.clear()
  over_cap = '&'.join(
      f'path=remix-input/p{i}-abc.png'
      for i in range(orch._MAX_SIGN_URL_PATHS + 1)
  )
  response = client.get(f'/api/signUrl?{over_cap}')
  assert response.status_code == 400
  assert signed == []


# ---------------------------------------------------------------------------
# /api/projects
# ---------------------------------------------------------------------------
def test_projects_crud_round_trip_with_created_by_stamping(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(
      monkeypatch, AUTH_MODE='iap', IAP_AUDIENCE=_IAP_AUDIENCE
  )
  # createdBy is stamped from the verified IAP email (orch._request_email reads
  # iap_claims['email']); each assertion string maps to one verified identity.
  _stub_identity(
      monkeypatch,
      orch,
      {'t-u1': {'email': 'u1@x'}, 't-u2': {'email': 'u2@x'}},
  )
  client = orch.app.test_client()

  # The existing IAP middleware covers the new endpoints.
  assert client.get('/api/projects').status_code == 401

  project_id = str(uuid.uuid4())
  project = {
      'id': project_id,
      'name': 'Test Project',
      'createdBy': 'spoof@evil',  # must be overridden by the server
      'lastEdited': '2026-06-12T10:00:00.000Z',
      'renderRuns': [{
          'createdAt': '2026-06-11T09:30:00.000Z',
          'outputVideo': {'path': 'video-gen/out.mp4', 'url': 'stale'},
      }],
      'storyboard': [],
  }
  response = client.post('/api/projects', json=project, headers=_iap('t-u1'))
  assert response.status_code == 200
  assert response.get_json() == {'id': project_id}

  # Stored doc: createdBy stamped from the verified IAP email, ISO strings
  # converted to datetime (Firestore Timestamp parity with legacy documents).
  stored = fake_db.collection('projects').docs[project_id]
  assert stored['createdBy'] == 'u1@x'
  assert isinstance(stored['lastEdited'], datetime.datetime)
  assert isinstance(stored['renderRuns'][0]['createdAt'], datetime.datetime)

  # GET single: dates serialized back to ISO strings.
  response = client.get(f'/api/projects/{project_id}', headers=_iap('t-u1'))
  assert response.status_code == 200
  body = response.get_json()
  assert body['createdBy'] == 'u1@x'
  assert body['lastEdited'] == '2026-06-12T10:00:00+00:00'
  assert body['renderRuns'][0]['createdAt'] == '2026-06-11T09:30:00+00:00'

  # Unfiltered list is shared across users (product behavior).
  response = client.get('/api/projects', headers=_iap('t-u2'))
  assert [p['id'] for p in response.get_json()['projects']] == [project_id]

  # createdBy=me filters on the verified identity, not a client value.
  response = client.get('/api/projects?createdBy=me', headers=_iap('t-u1'))
  assert [p['id'] for p in response.get_json()['projects']] == [project_id]
  response = client.get('/api/projects?createdBy=me', headers=_iap('t-u2'))
  assert response.get_json()['projects'] == []
  response = client.get('/api/projects?createdBy=u1@x', headers=_iap('t-u2'))
  assert response.status_code == 400  # only 'me' is supported

  # PATCH: full-doc autosave port; createdBy in the payload is stripped
  # and the stored owner preserved; lastEdited refreshed server-side.
  patched = dict(body)
  patched['name'] = 'Renamed'
  patched['createdBy'] = 'spoof@evil'
  response = client.patch(
      f'/api/projects/{project_id}', json=patched, headers=_iap('t-u1')
  )
  assert response.status_code == 200
  stored = fake_db.collection('projects').docs[project_id]
  assert stored['name'] == 'Renamed'
  assert stored['createdBy'] == 'u1@x'
  assert isinstance(stored['lastEdited'], datetime.datetime)
  assert stored['lastEdited'] > datetime.datetime(
      2026, 6, 12, 10, 0, tzinfo=datetime.timezone.utc
  )

  # DELETE: idempotent in the shared model.
  assert (
      client.delete(
          f'/api/projects/{project_id}', headers=_iap('t-u2')
      ).status_code
      == 200
  )
  assert (
      client.get(
          f'/api/projects/{project_id}', headers=_iap('t-u1')
      ).status_code
      == 404
  )
  assert (
      client.delete(
          f'/api/projects/{project_id}', headers=_iap('t-u1')
      ).status_code
      == 200
  )
  # PATCH of a missing project is a 404, not an upsert.
  assert (
      client.patch(
          f'/api/projects/{project_id}', json=patched, headers=_iap('t-u1')
      ).status_code
      == 404
  )


def test_post_project_is_create_only_and_keeps_the_owner(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(
      monkeypatch, AUTH_MODE='iap', IAP_AUDIENCE=_IAP_AUDIENCE
  )
  _stub_identity(
      monkeypatch,
      orch,
      {'t-u1': {'email': 'u1@x'}, 't-u2': {'email': 'u2@x'}},
  )
  client = orch.app.test_client()

  project_id = str(uuid.uuid4())
  project = {'id': project_id, 'name': 'Original', 'storyboard': []}
  # First POST creates the project, owned by u1.
  assert (
      client.post(
          '/api/projects', json=project, headers=_iap('t-u1')
      ).status_code
      == 200
  )
  assert fake_db.collection('projects').docs[project_id]['createdBy'] == 'u1@x'

  # A second POST of the SAME id (by a different user) is a 409 conflict: POST
  # is create-only, so it must not overwrite the project nor re-stamp the owner.
  # Updates go through PATCH (which preserves createdBy).
  response = client.post(
      '/api/projects',
      json={'id': project_id, 'name': 'Hijacked', 'storyboard': []},
      headers=_iap('t-u2'),
  )
  assert response.status_code == 409
  stored = fake_db.collection('projects').docs[project_id]
  assert stored['name'] == 'Original'
  assert stored['createdBy'] == 'u1@x'


def test_projects_auth_none_posture(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)  # AUTH_MODE defaults to none
  client = orch.app.test_client()

  # POST succeeds without credentials; createdBy is stamped to None.
  response = client.post(
      '/api/projects', json={'id': 'p1', 'name': 'n', 'createdBy': 'spoof'}
  )
  assert response.status_code == 200
  assert fake_db.collection('projects').docs['p1']['createdBy'] is None

  assert client.get('/api/projects').status_code == 200
  assert client.get('/api/projects/p1').status_code == 200
  # createdBy=me needs an identity, which AUTH_MODE=none never has.
  response = client.get('/api/projects?createdBy=me')
  assert response.status_code == 400
  assert 'error' in response.get_json()

  # Shared-write default: PATCH/DELETE pass with no identity.
  assert (
      client.patch(
          '/api/projects/p1', json={'id': 'p1', 'name': 'n2'}
      ).status_code
      == 200
  )
  assert client.delete('/api/projects/p1').status_code == 200


def _scenes_docs(fake_db, project_id):
  """The persisted projects/<id>/scenes subcollection doc dict."""
  return (
      fake_db.collection('projects').document(project_id).collection('scenes').docs
  )


def test_concurrent_project_posts_are_atomically_create_only(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(
      monkeypatch, AUTH_MODE='iap', IAP_AUDIENCE=_IAP_AUDIENCE
  )
  _stub_identity(
      monkeypatch,
      orch,
      {'t-u1': {'email': 'u1@x'}, 't-u2': {'email': 'u2@x'}},
  )
  fake_db.commit_barrier = threading.Barrier(2)
  project_id = str(uuid.uuid4())
  submissions = {
      'first': {
          'assertion': 't-u1',
          'owner': 'u1@x',
          'payload': {
              'id': project_id,
              'name': 'First',
              'storyboard': [
                  {'description': 'first-0'},
                  {'description': 'first-1'},
              ],
          },
      },
      'second': {
          'assertion': 't-u2',
          'owner': 'u2@x',
          'payload': {
              'id': project_id,
              'name': 'Second',
              'storyboard': [{'description': 'second-0'}],
          },
      },
  }
  statuses = {}

  def post_project(label):
    submission = submissions[label]
    with orch.app.test_client() as client:
      response = client.post(
          '/api/projects',
          json=submission['payload'],
          headers=_iap(submission['assertion']),
      )
    statuses[label] = response.status_code

  threads = [
      threading.Thread(target=post_project, args=(label,))
      for label in submissions
  ]
  for thread in threads:
    thread.start()
  for thread in threads:
    thread.join(timeout=10)
  assert not any(thread.is_alive() for thread in threads)

  assert sorted(statuses.values()) == [200, 409]
  winner = next(label for label, status in statuses.items() if status == 200)
  expected = submissions[winner]
  stored = fake_db.collection('projects').docs[project_id]
  assert stored['name'] == expected['payload']['name']
  assert stored['createdBy'] == expected['owner']
  stored_scenes = [
      scene for _, scene in sorted(_scenes_docs(fake_db, project_id).items())
  ]
  assert stored_scenes == expected['payload']['storyboard']


def test_post_project_accepts_449_scenes_in_one_atomic_batch(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  batch_sizes = []
  original_commit = FakeBatch.commit

  def counting_commit(self):
    batch_sizes.append(len(self._ops))
    original_commit(self)

  monkeypatch.setattr(FakeBatch, 'commit', counting_commit)

  scenes = [{'description': f'scene-{i}'} for i in range(449)]
  response = client.post(
      '/api/projects',
      json={'id': 'max-batch', 'name': 'n', 'storyboard': scenes},
  )
  assert response.status_code == 200
  assert fake_db.collection('projects').docs['max-batch']['storyboard'] == []
  assert len(_scenes_docs(fake_db, 'max-batch')) == 449
  # Root + 449 scenes = 450 operations, this repository's batching threshold,
  # committed in exactly one atomic batch.
  assert batch_sizes == [450]


def test_post_project_rejects_450_scenes_before_any_write(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  def fail_batch():
    raise AssertionError('no batch should be created for a rejected POST')

  monkeypatch.setattr(fake_db, 'batch', fail_batch)

  scenes = [{'description': f'scene-{i}'} for i in range(450)]
  response = client.post(
      '/api/projects',
      json={'id': 'too-big', 'name': 'n', 'storyboard': scenes},
  )
  assert response.status_code == 400
  body = response.get_json()
  assert 'error' in body
  assert '449' in body['error']
  assert 'too-big' not in fake_db.collection('projects').docs
  assert _scenes_docs(fake_db, 'too-big') == {}


def test_post_project_does_not_scan_existing_scenes_on_create(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()
  del fake_db

  def fail_stream(self):
    raise AssertionError(
        'creating a new project must not scan for stale scenes; there is'
        ' nothing to prune yet'
    )

  monkeypatch.setattr(FakeQuery, 'stream', fail_stream)

  response = client.post(
      '/api/projects',
      json={
          'id': 'fresh',
          'name': 'n',
          'storyboard': [{'description': 'only-scene'}],
      },
  )
  assert response.status_code == 200


def test_project_storyboard_split_into_scenes_subcollection(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)  # AUTH_MODE defaults to none
  client = orch.app.test_client()

  scenes = [{'description': f'scene-{i}'} for i in range(3)]
  assert (
      client.post(
          '/api/projects', json={'id': 'big', 'name': 'n', 'storyboard': scenes}
      ).status_code
      == 200
  )

  # The root document no longer carries the scenes inline; they live one per
  # document in the scenes subcollection. This is what keeps the root doc
  # under Firestore's 1 MiB ceiling.
  assert fake_db.collection('projects').docs['big']['storyboard'] == []
  assert len(_scenes_docs(fake_db, 'big')) == 3

  # GET transparently reassembles the storyboard, in scene order.
  body = client.get('/api/projects/big').get_json()
  assert [s['description'] for s in body['storyboard']] == [
      'scene-0',
      'scene-1',
      'scene-2',
  ]

  # The list endpoint returns only the FIRST scene per project (homepage cards
  # read storyboard[0] for a thumbnail), so it does not reassemble the whole
  # storyboard like the detail endpoint above. This keeps listing N projects
  # from reading every scene of every project.
  listed = client.get('/api/projects').get_json()['projects']
  assert [s['description'] for s in listed[0]['storyboard']] == ['scene-0']


def test_project_patch_prunes_removed_scenes(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  client.post(
      '/api/projects',
      json={
          'id': 'shrink',
          'name': 'n',
          'storyboard': [{'d': '0'}, {'d': '1'}, {'d': '2'}],
      },
  )
  assert len(_scenes_docs(fake_db, 'shrink')) == 3

  # An autosave with fewer scenes must drop the orphaned scene documents so
  # they do not reappear on the next read.
  assert (
      client.patch(
          '/api/projects/shrink',
          json={'id': 'shrink', 'name': 'n', 'storyboard': [{'d': '0'}]},
      ).status_code
      == 200
  )
  assert len(_scenes_docs(fake_db, 'shrink')) == 1
  body = client.get('/api/projects/shrink').get_json()
  assert [s['d'] for s in body['storyboard']] == ['0']


def test_project_delete_clears_scenes_subcollection(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()

  client.post(
      '/api/projects',
      json={'id': 'del', 'name': 'n', 'storyboard': [{'d': '0'}, {'d': '1'}]},
  )
  assert len(_scenes_docs(fake_db, 'del')) == 2

  assert client.delete('/api/projects/del').status_code == 200
  assert client.get('/api/projects/del').status_code == 404
  # No orphaned scene documents are left behind.
  assert len(_scenes_docs(fake_db, 'del')) == 0


# ---------------------------------------------------------------------------
# /api/templates
# ---------------------------------------------------------------------------
def test_templates_crud_and_read_only_guard(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  client = orch.app.test_client()
  docs = fake_db.collection('creativeTemplates').docs
  # Seeded template, as written by deploy.sh.
  docs['seeded'] = {
      'name': 'Seeded',
      'prompt': 'p',
      'readOnly': True,
      'createdAt': 1000,
  }

  # POST: auto-id add(); readOnly forced to False even if spoofed.
  response = client.post(
      '/api/templates',
      json={'name': 'Mine', 'prompt': 'q', 'readOnly': True, 'createdAt': 2000},
  )
  assert response.status_code == 200
  template_id = response.get_json()['id']
  assert docs[template_id]['readOnly'] is False

  # GET: ordered by createdAt ascending, ids injected.
  response = client.get('/api/templates')
  assert response.status_code == 200
  templates = response.get_json()['templates']
  assert [t['id'] for t in templates] == ['seeded', template_id]
  assert templates[0]['readOnly'] is True

  # PATCH: updates, stripping readOnly from the payload.
  response = client.patch(
      f'/api/templates/{template_id}',
      json={'name': 'Renamed', 'readOnly': True},
  )
  assert response.status_code == 200
  assert docs[template_id]['name'] == 'Renamed'
  assert docs[template_id]['readOnly'] is False

  # O4: a PATCH whose only field is readOnly strips to an empty payload. The
  # server must reject it (400), not return 200 without writing — a silent
  # no-op save would tell the client the edit saved when nothing changed.
  before = dict(docs[template_id])
  response = client.patch(
      f'/api/templates/{template_id}', json={'readOnly': False}
  )
  assert response.status_code == 400
  assert docs[template_id] == before  # nothing written

  # Read-only guard on both PATCH and DELETE.
  response = client.patch('/api/templates/seeded', json={'name': 'h4x'})
  assert response.status_code == 403
  assert 'error' in response.get_json()
  assert client.delete('/api/templates/seeded').status_code == 403
  assert docs['seeded']['name'] == 'Seeded'

  # PATCH of a missing template is a 404.
  assert (
      client.patch('/api/templates/missing', json={'name': 'x'}).status_code
      == 404
  )

  # DELETE of a writable template succeeds.
  assert client.delete(f'/api/templates/{template_id}').status_code == 200
  assert template_id not in docs


# ---------------------------------------------------------------------------
# /api/config
# ---------------------------------------------------------------------------
def test_config_returns_seeded_doc_plus_model_catalog(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  # The catalog loader has its own Firestore client (it is shared with the
  # validator, not the handler's _ui_db); give it a live doc without network.
  live_catalog = model_allowlist.load_shipped_allowlist()
  live_catalog['models']['veo-live-hotfix'] = {
      'family': 'veo', 'actions': ['generate_video'],
      'locations': ['global'], 'capabilities': {}}
  monkeypatch.setattr(
      model_allowlist, '_fetch_live_catalog', lambda: live_catalog)
  client = orch.app.test_client()

  response = client.get('/api/config')
  assert response.status_code == 404
  assert 'error' in response.get_json()

  seeded = {
      'gcpProject': 'spike-project',
      'gcpLocation': 'us-central1',
      'gcsBucket': _BUCKET,
      'veoModel': 'veo-3.0',
  }
  fake_db.collection('config').docs['global'] = seeded
  response = client.get('/api/config')
  assert response.status_code == 200
  payload = response.get_json()
  assert payload['modelCatalogSource'] == 'firestore'
  assert 'veo-live-hotfix' in payload['modelCatalog']['models']
  for key, value in seeded.items():
    assert payload[key] == value  # the global doc itself stays verbatim


def test_config_serves_shipped_catalog_when_the_live_doc_is_unusable(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  def unreachable():
    raise RuntimeError('firestore down')
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', unreachable)
  fake_db.collection('config').docs['global'] = {'gcpProject': 'p'}
  client = orch.app.test_client()

  payload = client.get('/api/config').get_json()
  assert payload['modelCatalogSource'] == 'shipped'
  assert payload['modelCatalog'] == model_allowlist.load_shipped_allowlist()


def test_config_survives_a_console_edit_with_a_firestore_typed_value(
    monkeypatch, orchestrator_module
):
  # A timestamp planted anywhere in the live doc must degrade to the shipped
  # catalog -- never a serialization 500 for every /api/config caller.
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  live = model_allowlist.load_shipped_allowlist()
  live['updated_at'] = datetime.datetime(2026, 7, 1)
  monkeypatch.setattr(model_allowlist, '_fetch_live_catalog', lambda: live)
  fake_db.collection('config').docs['global'] = {'gcpProject': 'p'}
  client = orch.app.test_client()

  response = client.get('/api/config')
  assert response.status_code == 200
  assert response.get_json()['modelCatalogSource'] == 'shipped'


# ---------------------------------------------------------------------------
# Failure posture + role scoping
# ---------------------------------------------------------------------------
def test_data_endpoints_fail_soft_without_firestore_db_ui(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  # ROLE=app requires WORKER_URL; FIRESTORE_DB_UI left unset on purpose.
  orch = _load_orch(
      monkeypatch, ROLE='app', WORKER_URL='https://worker-test.a.run.app'
  )
  client = orch.app.test_client()

  for path in ('/api/config', '/api/projects', '/api/templates'):
    response = client.get(path)
    assert response.status_code == 500, path
    assert response.get_json() == {'error': 'FIRESTORE_DB_UI not configured'}
  response = client.post('/api/projects', json={'name': 'x'})
  assert response.status_code == 500
  assert response.get_json() == {'error': 'FIRESTORE_DB_UI not configured'}

  # The storage endpoints do not need the UI database.
  monkeypatch.setattr(orch, '_storage_client', FakeStorageClient())
  monkeypatch.setattr(orch, '_get_signing_credentials', lambda: None)
  monkeypatch.setitem(orch.config, 'gcsBucket', _BUCKET)
  assert client.get('/api/signUrl?path=remix-input/a.png').status_code == 200


def test_worker_role_has_no_data_routes(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch, ROLE='worker', FIRESTORE_DB_UI='frontdoor-ui-test'
  )

  rules = {rule.rule for rule in orch.app.url_map.iter_rules()}
  for route in _DATA_ROUTES:
    assert route not in rules

  client = orch.app.test_client()
  assert client.get('/api/projects').status_code == 404
  assert client.post('/api/uploadUrl', json={}).status_code == 404
  assert client.get('/api/config').status_code == 404
