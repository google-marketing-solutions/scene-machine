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

"""Handles the Cloud Run endpoints of Remix Engine.

This defines the endpoints /supplyNode and /triggerAction.

The deployment topology is selected via environment variables (all
optional; the defaults reproduce the single-service behavior exactly):

  ROLE: 'all' (default) | 'app' | 'worker'
    all:    today's three root routes (/supplyNode, /triggerAction,
            /getStatus), no auth, Host-derived Cloud Tasks callback.
    worker: /supplyNode + /triggerAction only (Cloud Run IAM/OIDC
            protects the service; no app-level auth).
    app:    /api/supplyNode + /api/getStatus (same handlers, /api
            prefix), and static serving of the built SPA, /definitions/*
            and the /status viewer.
  AUTH_MODE: 'none' (default) | 'iap'
    Only meaningful when ROLE='app'; gates /api/* requests. Static
    paths stay open.
  WORKER_URL: optional absolute URL; when set, overrides
    'https://' + Host as the Cloud Tasks callback base in both task
    creation entry points.
  IAP_AUDIENCE: required when AUTH_MODE='iap'; format
    /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME
  FIRESTORE_DB_UI: Firestore database id holding the UI's documents
    (projects, creativeTemplates, config). Required by the mediated
    data-plane endpoints (/api/config, /api/projects*, /api/templates*),
    which fail soft with a JSON 500 while it is unset.
"""

import copy
import datetime
import json
import logging
import os
import pathlib
import sys
import uuid

from common import ContentType
from common import Key
from flask import Flask
from flask import g as flask_g
from flask import request as flask_request
from flask import Response as flask_response
from flask import send_from_directory
from flask_cors import CORS
from google.auth import compute_engine
from google.auth import default as google_auth_default
from google.auth.transport import requests as google_auth_requests
from google.cloud import firestore
from google.cloud import storage
from google.oauth2 import id_token as google_id_token
import orchestrator
from util import database as util_database
from util import errors as util_errors
from werkzeug.security import safe_join

# At most the queue's allowed attempts minus one, so the workflow proceeds:
_MAX_ALLOWED_RETRIES = 10

_ROLE = os.environ.get('ROLE', 'all')
_AUTH_MODE = os.environ.get('AUTH_MODE', 'none')
_WORKER_URL = os.environ.get('WORKER_URL')
_IAP_AUDIENCE = os.environ.get('IAP_AUDIENCE')
_FIRESTORE_DB_UI = os.environ.get('FIRESTORE_DB_UI')

# DEV-ONLY: run backend actions in-process via the threaded execution path
# instead of scheduling Cloud Tasks (orchestrator.supply_node(data, None)).
# Honored ONLY when AUTH_MODE='none' (the local, unauthenticated dev posture),
# so it cannot activate in a deployed service: deploy.sh never sets LOCAL_WORKER
# and always deploys with AUTH_MODE=iap. Lets a developer run a full
# workflow on one machine without standing up a worker service or a Cloud Tasks
# queue. Long jobs then run in worker threads inside this single process, with no
# Cloud Tasks retry/backoff — fine for local iteration, not for load.
_LOCAL_WORKER = (
    os.environ.get('LOCAL_WORKER', '').strip().lower() in ('1', 'true', 'yes')
    and _AUTH_MODE == 'none'
)

_IAP_CERTS_URL = 'https://www.gstatic.com/iap/verify/public_key'

if _ROLE not in ('all', 'app', 'worker'):
  raise RuntimeError(f'Invalid ROLE: {_ROLE!r} (use all|app|worker)')
if _AUTH_MODE not in ('none', 'iap'):
  raise RuntimeError(f'Invalid AUTH_MODE: {_AUTH_MODE!r} (use none|iap)')
if _ROLE == 'app' and _AUTH_MODE == 'iap' and not _IAP_AUDIENCE:
  raise RuntimeError('IAP_AUDIENCE is required when AUTH_MODE=iap')
# Without WORKER_URL the app derives the Cloud Tasks callback base from its own
# Host header, so action callbacks loop back into the app's SPA catch-all
# (HTTP 200, no work done) and the workflow stalls forever with no error. Fail
# fast at startup instead. LOCAL_WORKER runs actions in-process and needs no URL.
if _ROLE == 'app' and not _LOCAL_WORKER and not _WORKER_URL:
  raise RuntimeError('WORKER_URL is required when ROLE=app (deploy.sh sets it)')

# Static content roots, anchored at this file (NOT the CWD):
_BASE_DIR = pathlib.Path(__file__).resolve().parent
_DEFINITIONS_DIR = _BASE_DIR / 'ui' / 'definitions'
_STATUS_VIEWER_DIR = _BASE_DIR / 'ui' / 'remix-engine-status-viewer'
_SPA_DIR = _BASE_DIR / 'ui' / 'dist' / 'ui' / 'browser'

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

if _LOCAL_WORKER:
  logger.warning(
      'LOCAL_WORKER active: backend actions run in-process in worker threads '
      '(DEV ONLY; no Cloud Tasks scheduling, no retry/backoff).'
  )

with open(orchestrator.CONFIG_JSON_PATH, 'r', encoding='utf-8') as file:
  config = json.load(file)

app = Flask(__name__)
# Match Cloud Run's own 32 MiB request-body limit so an oversized body returns a
# clean 413 here instead of a dropped connection at the edge.
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
# CORS only ever applies to a DIFFERENT origin. In production the browser is
# served the SPA and calls /api from the SAME Cloud Run origin, which the
# browser never CORS-checks — so the app's own (deploy-time, unpredictable) host
# does not belong here. The only genuine cross-origin caller is the Angular dev
# server (`ng serve`) on localhost:4200.
CORS(
    app,
    origins=[
        'http://localhost:4200',
    ],
)


def _unauthorized(message: str) -> flask_response:
  """Builds the 401 JSON response used by the auth middleware."""
  return flask_response(
      json.dumps({'error': message}),
      status=401,
      mimetype=ContentType.JSON.value,
  )


def _forbidden(message: str) -> flask_response:
  """Builds the 403 response for an authenticated but non-allowed user."""
  return flask_response(
      json.dumps({'error': message}),
      status=403,
      mimetype=ContentType.JSON.value,
  )


def require_api_auth() -> flask_response | None:
  """Gates /api/* requests according to AUTH_MODE (ROLE='app' only).

  Registered as a before_request hook only when ROLE='app' and
  AUTH_MODE is 'iap'. Static paths (anything outside /api/) are never
  gated.

  Returns:
    None to let the request through, or a 401 response.
  """
  if not flask_request.path.startswith('/api/'):
    return None
  if _AUTH_MODE == 'iap':
    assertion = flask_request.headers.get('X-Goog-IAP-JWT-Assertion')
    if not assertion:
      return _unauthorized('Missing IAP JWT assertion')
    try:
      flask_g.iap_claims = google_id_token.verify_token(
          assertion,
          google_auth_requests.Request(),
          audience=_IAP_AUDIENCE,
          certs_url=_IAP_CERTS_URL,
      )
    except Exception as e:  # pylint: disable=broad-exception-caught
      logger.warning('Rejected IAP JWT assertion: %s', e)
      return _unauthorized('Invalid IAP JWT assertion')
  return None


def supply_node_handler() -> flask_response:
  """Initiates a node execution by supplying input data to it.

  Returns:
    the default response object returned by Flask

  Raises:
    RuntimeError: if no host header is found and WORKER_URL is unset
  """
  if _LOCAL_WORKER:
    # DEV-ONLY: instance=None makes orchestrator.supply_node run this node (and,
    # recursively, its successors) in in-process threads instead of scheduling
    # Cloud Tasks. Gated by _LOCAL_WORKER (AUTH_MODE=none only); see above.
    instance = None
  else:
    instance = _WORKER_URL
    if not instance:
      host = flask_request.headers.get('Host')
      if not host:
        raise RuntimeError('No host header found')
      instance = 'https://' + host
  data = flask_request.get_json()
  if not isinstance(data, dict):
    return flask_response(
        json.dumps({'error': 'Malformed JSON body'}),
        status=400,
        mimetype=ContentType.JSON.value,
    )
  # workflowParams must be a JSON object. A client that omits it gets an empty
  # one (the pin below fills the cloud params); a client that sends a non-object
  # (e.g. a string) is rejected with 400 rather than crashing the handler.
  params = data.get(Key.WORKFLOW_PARAMS.value)
  if params is None:
    params = {}
    data[Key.WORKFLOW_PARAMS.value] = params
  elif not isinstance(params, dict):
    return flask_response(
        json.dumps({'error': 'workflowParams must be a JSON object'}),
        status=400,
        mimetype=ContentType.JSON.value,
    )
  # Pin the cloud params to the server's own config: they pick the GCP project,
  # location, bucket and Cloud Tasks queue the runtime SA acts against. An
  # IAP-admitted caller must not be able to point the app at an arbitrary
  # project/bucket/queue, so the client-supplied values are overwritten here
  # (same rationale as get_status_handler's gcsBucket pin above). Fail closed: a
  # value missing from the server config is a deploy misconfiguration, not a
  # reason to fall back to the client's value. config.template.json renders all
  # four, so this 500 only fires on a broken config, never in a normal deploy.
  for k in (
      Key.GCP_PROJECT.value,
      Key.GCP_LOCATION.value,
      Key.GCS_BUCKET.value,
      Key.TASKS_QUEUE_PREFIX.value,
  ):
    server_value = config.get(k)
    if not server_value:
      return flask_response(
          json.dumps({'error': f'Server cloud config incomplete: {k}'}),
          status=500,
          mimetype=ContentType.JSON.value,
      )
    params[k] = server_value
  execution_id = orchestrator.supply_node(data, instance)
  output = {Key.EXECUTION_ID.value: execution_id}
  return flask_response(
      json.dumps(output), status=200, mimetype=ContentType.JSON.value
  )


def trigger_action_handler() -> tuple[str, int]:
  """Triggers an action's execution.

  Returns:
    response message and HTTP response code

  Raises:
    RuntimeError: if no host header is found and WORKER_URL is unset
  """
  instance = _WORKER_URL
  if not instance:
    host = flask_request.headers.get('Host')
    if not host:
      raise RuntimeError('No host header found')
    instance = 'https://' + host
  data = flask_request.get_json(silent=True)
  if not isinstance(data, dict) or not all(
      key in data
      for key in (
          Key.ACTION.value,
          Key.EXECUTION_ID.value,
          Key.NODE_ID.value,
          Key.GROUP_ID.value,
          Key.WORKFLOW_DEF.value,
      )
  ):
    # Malformed task payload (e.g. missing the Cloud Tasks lock fields): reject
    # cleanly instead of raising a KeyError below and returning a 500.
    return 'Bad Request', 400
  retry_count = int(flask_request.headers.get('X-CloudTasks-TaskRetryCount', 0))
  if retry_count > 0:
    logger.info('Retried %s %s times', data[Key.ACTION.value], retry_count)
  execution_id = data[Key.EXECUTION_ID.value]
  node_id = data[Key.NODE_ID.value]
  group_id = data[Key.GROUP_ID.value]
  node = data[Key.WORKFLOW_DEF.value][node_id]
  if not orchestrator.db.acquire_task_lock(execution_id, node_id, group_id):
    logger.warning(
        '[%s] Node %s (group %s) was already triggered. Skipping execution.'
        ' (%s)',
        execution_id,
        node_id,
        group_id,
        node,
    )
    return 'Already Triggered', 200
  try:
    orchestrator.trigger_action(
        copy.deepcopy(data),
        instance,
        retry_count < _MAX_ALLOWED_RETRIES,
    )
  except Exception as e:  # pylint: disable=broad-exception-caught
    if util_errors.is_retryable(e):
      logger.error('Retrying action %s: %s', data[Key.ACTION.value], e)
      # Release the lock so that the retry can proceed
      orchestrator.db.release_task_lock(execution_id, node_id, group_id)
      return 'Quota Exceeded', 429  # Cloud Tasks may retry this
    else:
      logger.error('Fatal error for action %s: %s', data[Key.ACTION.value], e)
      return 'Internal Error', 200  # Cloud Tasks will NOT retry this
  return (
      (
          f'Action {data[Key.ACTION.value]} triggered for'
          f' {data[Key.INPUT_FILES.value]} and'
          f' {data.get(Key.PARAMETERS.value, {})}'
      ),
      200,
  )


def get_status_handler() -> flask_response:
  """Returns the status of the workflow execution.

  Returns:
    the default response object returned by Flask
  """
  execution_id = flask_request.args.get(Key.EXECUTION_ID.value)
  # Ignore any client-supplied gcsBucket: it would let a caller mint a
  # server-SA-signed URL against an arbitrary bucket. The only legitimate value
  # is the server's own configured bucket, matching the other mediated handlers.
  gcs_bucket_name = config.get('gcsBucket')
  sign_urls = flask_request.args.get(Key.SIGN_URLS.value) == 'true'
  if not execution_id:
    return flask_response(
        json.dumps({'error': 'Incomplete parameters for status request'}),
        status=400,
        mimetype=ContentType.JSON.value,
    )
  if not gcs_bucket_name:
    return flask_response(
        json.dumps({'error': 'gcsBucket not configured'}),
        status=500,
        mimetype=ContentType.JSON.value,
    )
  try:
    node_status = orchestrator.get_status(
        execution_id, gcs_bucket_name, True, sign_urls
    )
    return flask_response(
        json.dumps(node_status), status=200, mimetype=ContentType.JSON.value
    )
  except Exception as e:  # pylint: disable=broad-exception-caught
    sys.stderr.write(f'Error fetching status for execution {execution_id}: {e}')
    orchestrator.logger.error(
        'Error fetching status for execution %s: %s', execution_id, e
    )
    return flask_response(
        json.dumps({'error': 'Failed to retrieve execution status'}),
        status=500,
        mimetype=ContentType.JSON.value,
    )


# ---------------------------------------------------------------------------
# Mediated data plane (ROLE='app'): signed-URL minting for GCS plus CRUD on
# the UI Firestore database, so the SPA can run without direct Firebase
# SDK access. Module-level lazy singletons keep the per-request cost at
# ~1 IAM signBlob RPC per unique path (the per-call construction in
# util.gcs_wrapper.get_signed_url costs ~3 RPCs).
# ---------------------------------------------------------------------------

_SIGNED_GET_TTL = datetime.timedelta(hours=24)
_SIGNED_PUT_TTL = datetime.timedelta(hours=1)
# Cap the batch size of sign_url_handler: each path costs one IAM signBlob RPC,
# and MAX_CONTENT_LENGTH does not bound query-string params, so an uncapped list
# lets one admitted user exhaust the project's signBlob quota for everyone.
_MAX_SIGN_URL_PATHS = 100
_UPLOAD_PREFIXES = ('remix-input', 'thumbnail')

# Per-prefix maximum declared upload size (bytes). The client sends sizeBytes on
# the /api/uploadUrl request and the server rejects an oversized declaration
# before signing. This is a pre-sign convenience bound for the honest/accidental
# case (a custom client could still understate or omit sizeBytes); a bypass-proof
# bound would sign an x-goog-content-length-range into the PUT URL (follow-up).
_MAX_UPLOAD_BYTES = {
    'remix-input': 1024 * 1024 * 1024,  # 1 GiB (covers an uploaded source video)
    'thumbnail': 50 * 1024 * 1024,  # 50 MiB (generated thumbnails)
}

# Content types the client legitimately uploads: media (image/audio/video), the
# plain-text workflow payloads uploadText sends (prompts/briefings/arrangements),
# and the application/octet-stream fallback the browser uses when a File has no
# detected type. The signed PUT binds this content type, so allow-listing it
# server-side stops a caller from minting a signed URL that stores arbitrary,
# mislabelled content (e.g. application/pdf, text/html, application/x-msdownload)
# in the bucket. (Size is a separate concern — see the upload handler.)
_ALLOWED_UPLOAD_TYPE_PREFIXES = ('image/', 'audio/', 'video/')
_ALLOWED_UPLOAD_TYPES_EXACT = ('text/plain', 'application/octet-stream')


def _is_allowed_upload_content_type(content_type: str) -> bool:
  """Whether a client-supplied upload content type is on the allow-list."""
  return content_type in _ALLOWED_UPLOAD_TYPES_EXACT or content_type.startswith(
      _ALLOWED_UPLOAD_TYPE_PREFIXES
  )

_storage_client = None
_ui_db = None
_signing_credentials = None


def _get_storage_client() -> storage.Client:
  """Returns the lazily-built module-level Cloud Storage client."""
  global _storage_client
  if _storage_client is None:
    _storage_client = storage.Client()
  return _storage_client


def _get_ui_db() -> firestore.Client | None:
  """Returns the lazily-built client for the UI database, or None.

  None signals that FIRESTORE_DB_UI is not configured; the data-plane
  endpoints then fail soft with a JSON 500.
  """
  global _ui_db
  if _ui_db is None:
    if not _FIRESTORE_DB_UI:
      return None
    _ui_db = firestore.Client(database=_FIRESTORE_DB_UI)
  return _ui_db


def _get_signing_credentials() -> compute_engine.IDTokenCredentials:
  """Returns cached IAM-signing credentials, rebuilding them on expiry.

  Inlines the flask-context mechanics of util.gcs_wrapper.get_signed_url:
  the metadata-server credentials carry no private key, so URL signing
  goes through the IAM signBlob API via compute_engine.IDTokenCredentials
  (requires roles/iam.serviceAccountTokenCreator on the runtime SA).
  """
  global _signing_credentials
  if _signing_credentials is None or _signing_credentials.expired:
    auth_request = google_auth_requests.Request()
    source_credentials, _ = google_auth_default()
    source_credentials.refresh(auth_request)
    _signing_credentials = compute_engine.IDTokenCredentials(
        auth_request,
        '',
        service_account_email=source_credentials.service_account_email,  # pyright: ignore[reportAttributeAccessIssue]
    )
  return _signing_credentials


def _signed_url(
    blob, method: str, expiration: datetime.timedelta, content_type=None
) -> str:
  """Generates a V4 signed URL for the blob with the cached credentials."""
  kwargs = {}
  if content_type is not None:
    kwargs['content_type'] = content_type
  return blob.generate_signed_url(
      version='v4',
      expiration=expiration,
      method=method,
      credentials=_get_signing_credentials(),
      **kwargs,
  )


def _request_email() -> str | None:
  """Returns the verified identity of the current request, if any.

  Uses the verified iap_claims email path. Under AUTH_MODE='none' no claims
  exist on flask.g and the identity is None.
  """
  iap_claims = flask_g.get('iap_claims', {})
  return iap_claims.get('email') or None


def _json_response(payload, status: int = 200) -> flask_response:
  """Builds a JSON response with the shared mimetype."""
  return flask_response(
      json.dumps(payload), status=status, mimetype=ContentType.JSON.value
  )


def _json_error(message: str, status: int) -> flask_response:
  """Builds the {'error': message} JSON error body all endpoints share."""
  return _json_response({'error': message}, status=status)


def _valid_object_path(path: str) -> bool:
  """Validates a client-supplied GCS object path for signing."""
  if not path or path.startswith('/') or path.startswith('gs://'):
    return False
  if '..' in path:
    return False
  return True


def _parse_iso_datetime(value):
  """Converts an ISO-8601 string to datetime; everything else passes."""
  if not isinstance(value, str):
    return value
  try:
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  except ValueError:
    return value


def _convert_project_dates(payload) -> None:
  """Converts ProjectConfig date fields from ISO strings to datetime.

  The Firebase JS SDK stores Date values as Firestore Timestamps; over
  the mediated JSON API they arrive as ISO strings. Converting before
  set() keeps the stored types (Firestore Timestamps) consistent with the
  documents the JS SDK wrote, so legacy projects and date ordering still work.
  """
  if 'lastEdited' in payload:
    payload['lastEdited'] = _parse_iso_datetime(payload['lastEdited'])
  render_runs = payload.get('renderRuns')
  if isinstance(render_runs, list):
    for run in render_runs:
      if isinstance(run, dict) and 'createdAt' in run:
        run['createdAt'] = _parse_iso_datetime(run['createdAt'])


def upload_url_handler() -> flask_response:
  """Returns signed GET + PUT URLs for a client-named upload object.

  The client keeps computing the content-hash object name
  (${prefix}/${base}-${sha256}.${ext}) and passes it as fileName, so the
  workflow payloads are stable and content-addressed. exists=True is a
  dedupe probe: when the object is already present the client skips the PUT.
  The bucket always comes from the server config, never the client.
  """
  data = flask_request.get_json(silent=True)
  if not isinstance(data, dict):
    return _json_error('Malformed JSON body', 400)
  prefix = data.get('path')
  file_name = data.get('fileName')
  content_type = data.get('contentType')
  if prefix not in _UPLOAD_PREFIXES:
    return _json_error(
        "path must be one of 'remix-input' or 'thumbnail'", 400
    )
  if (
      not file_name
      or not isinstance(file_name, str)
      or '/' in file_name
      or '..' in file_name
  ):
    return _json_error('Invalid fileName', 400)
  if not content_type or not isinstance(content_type, str):
    return _json_error('Missing contentType', 400)
  if not _is_allowed_upload_content_type(content_type):
    return _json_error('Unsupported contentType', 400)
  # prefix is validated against _UPLOAD_PREFIXES above, so it is a key of
  # _MAX_UPLOAD_BYTES here. Reject an oversized declared size before signing.
  size_bytes = data.get('sizeBytes')
  if size_bytes is not None:
    if (
        not isinstance(size_bytes, int)
        or isinstance(size_bytes, bool)
        or size_bytes < 0
    ):
      return _json_error('sizeBytes must be a non-negative integer', 400)
    if size_bytes > _MAX_UPLOAD_BYTES[prefix]:
      return _json_error(f'Upload exceeds the size limit for {prefix}', 400)
  bucket_name = config.get('gcsBucket')
  if not bucket_name:
    return _json_error('gcsBucket not configured', 500)
  object_path = f'{prefix}/{file_name}'
  blob = _get_storage_client().bucket(bucket_name).blob(object_path)
  exists = blob.exists()
  upload_url = None
  if not exists:
    upload_url = _signed_url(
        blob, 'PUT', _SIGNED_PUT_TTL, content_type=content_type
    )
  # Return the GET URL's expiry so the client caches it against the server's
  # actual TTL instead of hard-coding it (ARCH2 — one source of truth, like
  # sign_url_handler). The GET URL is signed for _SIGNED_GET_TTL below.
  expires_at = (
      datetime.datetime.now(datetime.timezone.utc) + _SIGNED_GET_TTL
  ).isoformat()
  return _json_response({
      'exists': exists,
      'path': object_path,
      'url': _signed_url(blob, 'GET', _SIGNED_GET_TTL),
      'expiresAt': expires_at,
      'uploadUrl': upload_url,
  })


def sign_url_handler() -> flask_response:
  """Returns signed GET URLs for the given object paths (batchable).

  No exists-check is performed: GCS 404s missing objects naturally.

  Any syntactically valid path in the configured bucket can be signed (no
  per-prefix or per-user allow-list). This is safe by construction here: the
  bucket is single-tenant (deploy.sh creates a dedicated ${PROJECT}-scene-machine
  bucket that only ever holds this app's objects), and the deployment uses the
  shared-team model where every admitted user may already read all media. A
  per-user/per-prefix restriction would therefore add no real protection while
  breaking legitimate reads of execution-id-named workflow outputs (which have no
  fixed prefix). If a deployment ever points GCS_BUCKET at a shared bucket, add a
  prefix allow-list here.
  """
  paths = flask_request.args.getlist('path')
  if not paths:
    return _json_error('Missing path parameter', 400)
  # Sign each distinct path once: repeated 'path' params must not each spend an
  # IAM signBlob RPC. dict.fromkeys keeps first-seen order for a stable response.
  paths = list(dict.fromkeys(paths))
  # Cap the DISTINCT-path count. Each distinct path is one signBlob RPC, so this
  # bounds the signing work one request can trigger on the shared project's
  # quota; deduping first means the cap measures real cost, not repeated params.
  if len(paths) > _MAX_SIGN_URL_PATHS:
    return _json_error(
        f'Too many paths: {len(paths)} (max {_MAX_SIGN_URL_PATHS})', 400
    )
  for path in paths:
    if not _valid_object_path(path):
      return _json_error(f'Invalid path: {path}', 400)
  bucket_name = config.get('gcsBucket')
  if not bucket_name:
    return _json_error('gcsBucket not configured', 500)
  ttl = _SIGNED_GET_TTL
  ttl_arg = flask_request.args.get('ttl')
  if ttl_arg is not None:
    if not ttl_arg.isdecimal() or not 1 <= int(ttl_arg) <= 86400:
      return _json_error('ttl must be 1-86400 seconds', 400)
    ttl = datetime.timedelta(seconds=int(ttl_arg))
  bucket = _get_storage_client().bucket(bucket_name)
  urls = {
      path: _signed_url(bucket.blob(path), 'GET', ttl) for path in paths
  }
  expires_at = (
      datetime.datetime.now(datetime.timezone.utc) + ttl
  ).isoformat()
  return _json_response({'urls': urls, 'expiresAt': expires_at})


def ui_config_handler() -> flask_response:
  """Returns the config/global document from the UI database verbatim."""
  ui_db = _get_ui_db()
  if ui_db is None:
    return _json_error('FIRESTORE_DB_UI not configured', 500)
  snapshot = ui_db.collection('config').document('global').get()
  if not snapshot.exists:
    return _json_error('Config not seeded', 404)
  return _json_response(
      util_database.firestore_to_json_serialisable(snapshot.to_dict())
  )


# --- Project persistence: storyboard split ---------------------------------
# Throughout this section "project" means a SCENE MACHINE project — one of the
# user's creative projects (a storyboard with its scenes and candidates), stored
# as a document in the `projects` collection of the UI Firestore database. It is
# NOT the Google Cloud project (that is `$PROJECT` in deploy.sh). The id in
# projects/<id> is a Scene Machine project id, not the GCP project id.
#
# The whole-document autosave used to write the entire ProjectConfig (every
# scene with its accumulated candidates) into a single projects/<id>
# document. A heavily-used project exceeds Firestore's 1 MiB document limit,
# the autosave PATCH 500s, and the candidates created that session are lost on
# reopen. To raise that ceiling the scenes are stored one-per-document in a
# projects/<id>/scenes subcollection, so the 1 MiB limit applies per scene
# rather than to the whole project. Reads reassemble the storyboard, so the
# split is invisible to API clients (the mediated UI is unchanged).
_SCENES_SUBCOLLECTION = 'scenes'
# Firestore caps a write batch at 500 operations, so writes are grouped into
# batches of this size. A project whose root doc + scene writes + prunes fit in
# one batch commits atomically; a larger project spans multiple batches that are
# committed in sequence and are NOT atomic as a whole (see _commit_in_batches),
# so a mid-write failure can leave it partially updated until the next save.
_SCENE_BATCH_LIMIT = 450


def _scene_doc_id(index: int) -> str:
  """Zero-padded id so a subcollection stream returns scenes in order."""
  return f'{index:06d}'


def _commit_in_batches(ui_db, ops) -> None:
  """Applies (op, ref, data) writes in Firestore batches of _SCENE_BATCH_LIMIT.

  Each batch commits atomically on its own; multiple batches are committed in
  sequence and are not atomic as a group.
  """
  for start in range(0, len(ops), _SCENE_BATCH_LIMIT):
    batch = ui_db.batch()
    for op, ref, data in ops[start : start + _SCENE_BATCH_LIMIT]:
      if op == 'set':
        batch.set(ref, data)
      else:
        batch.delete(ref)
    batch.commit()


def _write_project_doc(ui_db, doc_ref, payload: dict) -> None:
  """Writes a project, splitting its storyboard into the scenes subcollection.

  The root document keeps every field except the scene list (stored empty);
  each scene becomes projects/<id>/scenes/<index>. Scene docs left over from
  a previous, longer storyboard are deleted so a shrunk storyboard does not
  resurrect old scenes on the next read. These writes are grouped into Firestore
  batches: a project that fits in one batch commits atomically; a larger one
  spans multiple batches committed in sequence (not atomic as a whole), so a
  failure partway through can leave the project partially written until the next
  save.
  """
  scenes = payload.get('storyboard')
  if not isinstance(scenes, list):
    scenes = []
  root = dict(payload)
  root['storyboard'] = []
  scenes_ref = doc_ref.collection(_SCENES_SUBCOLLECTION)
  keep_ids = {_scene_doc_id(i) for i in range(len(scenes))}
  ops = [('set', doc_ref, root)]
  for index, scene in enumerate(scenes):
    ops.append(('set', scenes_ref.document(_scene_doc_id(index)), scene))
  for snapshot in scenes_ref.stream():
    if snapshot.id not in keep_ids:
      ops.append(('delete', scenes_ref.document(snapshot.id), None))
  _commit_in_batches(ui_db, ops)


def _read_project_doc(doc_ref, snapshot=None, *, first_scene_only=False):
  """Reassembles a project dict, restoring storyboard from the subcollection.

  Returns None when the project document does not exist. The optional
  snapshot lets callers that already fetched the root doc skip a re-read.

  first_scene_only fetches just the first scene instead of streaming the whole
  subcollection. The project list only needs storyboard[0] (for each card's
  thumbnail), so listing N projects costs N+N reads rather than
  N + total-scene-count, and returns far less data over the wire.
  """
  if snapshot is None:
    snapshot = doc_ref.get()
  if not snapshot.exists:
    return None
  data = snapshot.to_dict()
  scenes_ref = doc_ref.collection(_SCENES_SUBCOLLECTION)
  if first_scene_only:
    first = scenes_ref.document(_scene_doc_id(0)).get()
    data['storyboard'] = [first.to_dict()] if first.exists else []
  else:
    data['storyboard'] = [scene.to_dict() for scene in scenes_ref.stream()]
  return data


def _delete_project_doc(ui_db, doc_ref) -> None:
  """Deletes a project and every scene in its subcollection."""
  scenes_ref = doc_ref.collection(_SCENES_SUBCOLLECTION)
  ops = [
      ('delete', scenes_ref.document(snapshot.id), None)
      for snapshot in scenes_ref.stream()
  ]
  ops.append(('delete', doc_ref, None))
  _commit_in_batches(ui_db, ops)


def projects_handler() -> flask_response:
  """Lists (GET) or creates (POST) UI project documents.

  GET ?createdBy=me filters on the verified identity; the default
  unfiltered list preserves the shared-projects product behavior.
  POST stamps createdBy from the verified identity, overriding any
  client-supplied value (None under AUTH_MODE='none').
  """
  ui_db = _get_ui_db()
  if ui_db is None:
    return _json_error('FIRESTORE_DB_UI not configured', 500)
  collection = ui_db.collection('projects')
  if flask_request.method == 'GET':
    created_by = flask_request.args.get('createdBy')
    query = collection
    if created_by is not None:
      if created_by != 'me':
        return _json_error("Unsupported createdBy filter (only 'me')", 400)
      identity = _request_email()
      if not identity:
        return _json_error('createdBy=me requires a verified identity', 400)
      query = query.where(
          filter=firestore.FieldFilter('createdBy', '==', identity)
      )
    projects = [
        util_database.firestore_to_json_serialisable(
            _read_project_doc(
                collection.document(snapshot.id),
                snapshot,
                first_scene_only=True,
            )
        )
        for snapshot in query.stream()
    ]
    return _json_response({'projects': projects})
  # POST: full ProjectConfig, client uuid id accepted (setDoc parity).
  data = flask_request.get_json(silent=True)
  if not isinstance(data, dict):
    return _json_error('Malformed JSON body', 400)
  payload = copy.deepcopy(data)
  project_id = payload.get('id')
  if project_id is None:
    project_id = str(uuid.uuid4())
  elif not isinstance(project_id, str) or not project_id or '/' in project_id:
    return _json_error('Invalid project id', 400)
  payload['id'] = project_id
  doc_ref = collection.document(project_id)
  # Create-only: POST must not overwrite an existing project (which would also
  # re-stamp createdBy to the poster, reassigning the owner shown in "My
  # projects"). Updates go through PATCH, which preserves createdBy. A repeated
  # POST of the same id returns 409 instead of silently clobbering.
  if doc_ref.get().exists:
    return _json_error('Project already exists', 409)
  payload['createdBy'] = _request_email()
  _convert_project_dates(payload)
  _write_project_doc(ui_db, doc_ref, payload)
  return _json_response({'id': project_id})


def project_detail_handler(project_id: str) -> flask_response:
  """Reads (GET), overwrites (PATCH) or deletes (DELETE) one project.

  PATCH is the faithful port of the UI's whole-document autosave: a full
  set() with createdBy stripped from the payload (immutable; the stored
  owner is preserved) and lastEdited refreshed server-side.

  SHARED-TEAM MODEL (intentional): there is deliberately NO per-user
  ownership check on any method. Every IAP-admitted user may read, edit and
  delete every project (createdBy is a display label, not an access gate).
  This matches the documented model in README.md. Do not add an ownership
  gate here without changing that product decision.
  """
  ui_db = _get_ui_db()
  if ui_db is None:
    return _json_error('FIRESTORE_DB_UI not configured', 500)
  doc_ref = ui_db.collection('projects').document(project_id)
  snapshot = doc_ref.get()
  if flask_request.method == 'GET':
    if not snapshot.exists:
      return _json_error('Not found', 404)
    return _json_response(
        util_database.firestore_to_json_serialisable(
            _read_project_doc(doc_ref, snapshot)
        )
    )
  if flask_request.method == 'PATCH':
    if not snapshot.exists:
      return _json_error('Not found', 404)
    stored = snapshot.to_dict()
    data = flask_request.get_json(silent=True)
    if not isinstance(data, dict):
      return _json_error('Malformed JSON body', 400)
    payload = copy.deepcopy(data)
    payload.pop('createdBy', None)
    payload['createdBy'] = stored.get('createdBy')
    payload['id'] = project_id
    _convert_project_dates(payload)
    payload['lastEdited'] = datetime.datetime.now(datetime.timezone.utc)
    _write_project_doc(ui_db, doc_ref, payload)
    return _json_response({'id': project_id})
  # DELETE is idempotent: 200 whether or not the document exists. Any admitted
  # user may delete any project (shared-team model; see the docstring above).
  _delete_project_doc(ui_db, doc_ref)
  return _json_response({'id': project_id})


def templates_handler() -> flask_response:
  """Lists (GET) or creates (POST) creative templates.

  GET orders by createdAt ascending and injects the document id, like
  the UI's direct query. POST forces readOnly=False: only seeded
  templates are read-only.
  """
  ui_db = _get_ui_db()
  if ui_db is None:
    return _json_error('FIRESTORE_DB_UI not configured', 500)
  collection = ui_db.collection('creativeTemplates')
  if flask_request.method == 'GET':
    templates = []
    for snapshot in collection.order_by('createdAt').stream():
      template = util_database.firestore_to_json_serialisable(
          snapshot.to_dict()
      )
      template['id'] = snapshot.id
      templates.append(template)
    return _json_response({'templates': templates})
  data = flask_request.get_json(silent=True)
  if not isinstance(data, dict):
    return _json_error('Malformed JSON body', 400)
  payload = copy.deepcopy(data)
  payload['readOnly'] = False
  # GET orders by createdAt, and Firestore drops docs missing the field, so a
  # template created without one would never appear in the list. Stamp it
  # server-side as epoch milliseconds, matching the client (Date.now()) and the
  # seeded templates (integer createdAt) so all three sort together.
  if 'createdAt' not in payload:
    payload['createdAt'] = int(
        datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    )
  _, doc_ref = collection.add(payload)
  return _json_response({'id': doc_ref.id})


def template_detail_handler(template_id: str) -> flask_response:
  """Updates (PATCH) or deletes (DELETE) one creative template.

  Both methods 403 on read-only (seeded) templates; PATCH strips
  readOnly from the payload so clients cannot flip the guard.
  """
  ui_db = _get_ui_db()
  if ui_db is None:
    return _json_error('FIRESTORE_DB_UI not configured', 500)
  doc_ref = ui_db.collection('creativeTemplates').document(template_id)
  snapshot = doc_ref.get()
  if flask_request.method == 'PATCH':
    if not snapshot.exists:
      return _json_error('Not found', 404)
    if snapshot.to_dict().get('readOnly'):
      return _json_error('Template is read-only', 403)
    data = flask_request.get_json(silent=True)
    if not isinstance(data, dict):
      return _json_error('Malformed JSON body', 400)
    payload = copy.deepcopy(data)
    payload.pop('readOnly', None)
    if not payload:
      # readOnly is server-controlled and stripped above, so a body of only
      # {readOnly: ...} (or {}) leaves nothing to write. Returning 200 here
      # would tell the client the edit saved when no write happened; reject it.
      return _json_error('No updatable fields in request', 400)
    doc_ref.update(payload)
    return _json_response({'id': template_id})
  # DELETE: idempotent for missing docs, guarded for read-only ones.
  if snapshot.exists and snapshot.to_dict().get('readOnly'):
    return _json_error('Template is read-only', 403)
  doc_ref.delete()
  return _json_response({'id': template_id})


def definitions_handler(filename: str) -> flask_response:
  """Serves workflow definition files (ROLE='app')."""
  return send_from_directory(_DEFINITIONS_DIR, filename)


def status_viewer_handler(filename: str = 'status.html') -> flask_response:
  """Serves the status viewer files (ROLE='app')."""
  return send_from_directory(_STATUS_VIEWER_DIR, filename)


def spa_handler(path: str = '') -> flask_response:
  """Serves the built SPA, falling back to index.html (ROLE='app').

  A request for an existing file under ui/dist/ui/browser serves that file;
  anything else serves index.html so the Angular router can handle the route.
  Unknown /api/ paths are NOT swallowed by the fallback. (This is the
  same-origin Cloud Run replacement for the old App Engine static-file routing.)
  """
  if path.startswith('api/'):
    return flask_response(
        json.dumps({'error': 'Not found'}),
        status=404,
        mimetype=ContentType.JSON.value,
    )
  candidate = safe_join(str(_SPA_DIR), path) if path else None
  if candidate and os.path.isfile(candidate):
    return send_from_directory(_SPA_DIR, path)
  return send_from_directory(_SPA_DIR, 'index.html')


# Route registration per ROLE. ROLE='all' (the default) registers
# exactly today's three root routes with no auth middleware.
if _ROLE in ('all', 'worker'):
  app.add_url_rule(
      '/' + orchestrator.ENDPOINT_SUPPLY_NODE,
      view_func=supply_node_handler,
      methods=['POST'],
  )
  app.add_url_rule(
      '/' + orchestrator.ENDPOINT_TRIGGER_ACTION,
      view_func=trigger_action_handler,
      methods=['POST'],
  )

if _ROLE == 'all':
  app.add_url_rule(
      '/' + orchestrator.ENDPOINT_GET_STATUS,
      view_func=get_status_handler,
      methods=['GET'],
  )

if _ROLE == 'app':
  if _AUTH_MODE != 'none':
    app.before_request(require_api_auth)
  app.add_url_rule(
      '/api/' + orchestrator.ENDPOINT_SUPPLY_NODE,
      endpoint='api_supply_node',
      view_func=supply_node_handler,
      methods=['POST'],
  )
  app.add_url_rule(
      '/api/' + orchestrator.ENDPOINT_GET_STATUS,
      endpoint='api_get_status',
      view_func=get_status_handler,
      methods=['GET'],
  )
  # Mediated data-plane endpoints: covered by require_api_auth above and
  # registered before the SPA catch-all below.
  app.add_url_rule(
      '/api/uploadUrl', view_func=upload_url_handler, methods=['POST']
  )
  app.add_url_rule('/api/signUrl', view_func=sign_url_handler, methods=['GET'])
  app.add_url_rule('/api/config', view_func=ui_config_handler, methods=['GET'])
  app.add_url_rule(
      '/api/projects', view_func=projects_handler, methods=['GET', 'POST']
  )
  app.add_url_rule(
      '/api/projects/<project_id>',
      view_func=project_detail_handler,
      methods=['GET', 'PATCH', 'DELETE'],
  )
  app.add_url_rule(
      '/api/templates', view_func=templates_handler, methods=['GET', 'POST']
  )
  app.add_url_rule(
      '/api/templates/<template_id>',
      view_func=template_detail_handler,
      methods=['PATCH', 'DELETE'],
  )
  app.add_url_rule(
      '/definitions/<path:filename>',
      view_func=definitions_handler,
      methods=['GET'],
  )
  app.add_url_rule(
      '/status',
      endpoint='status_viewer_handler',
      view_func=status_viewer_handler,
      defaults={'filename': 'status.html'},
      methods=['GET'],
  )
  app.add_url_rule(
      '/status/<path:filename>',
      endpoint='status_viewer_handler',
      view_func=status_viewer_handler,
      methods=['GET'],
  )
  # The SPA catch-all is registered LAST so every other route wins:
  app.add_url_rule(
      '/', defaults={'path': ''}, view_func=spa_handler, methods=['GET']
  )
  app.add_url_rule('/<path:path>', view_func=spa_handler, methods=['GET'])


if __name__ == '__main__':
  logger.info('Running in Flask mode')
  app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
