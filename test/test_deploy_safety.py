"""Static safety guards on the deploy scripts.

These read the shell scripts as text and assert invariants. They need no backend
dependencies, so they always run in normal pytest collection (and in CI) and act
as cheap regression gates.
"""

import pathlib
import re
import json
import os
import subprocess
import sys

import pytest

_REPO = pathlib.Path(__file__).resolve().parent.parent
_DEPLOY_SCRIPTS = [
    _REPO / 'deploy.sh',
    _REPO / 'deploy' / 'libs.sh',
    _REPO / 'deploy' / 'grant-access.sh',
]


def _deploy_text() -> str:
  return '\n'.join(
      p.read_text(encoding='utf-8') for p in _DEPLOY_SCRIPTS if p.exists()
  )


def _deploy_sh() -> str:
  """Just deploy.sh (the SA/role logic lives here, not in the libs)."""
  return (_REPO / 'deploy.sh').read_text(encoding='utf-8')


def _dockerfile() -> str:
  return (_REPO / 'Dockerfile').read_text(encoding='utf-8')


def test_frontdoor_seed_has_the_new_project_defaults():
  """The deploy seed supplies the values used by both video-entry pages."""
  seed = json.loads(
      (_REPO / 'firestore_config_frontdoor.template.json').read_text(
          encoding='utf-8'))
  fields = seed['fields']
  assert fields['veoModel'] == {'stringValue': '${VEO_MODEL}'}
  assert fields['veoLocation'] == {'stringValue': '${VEO_REGION}'}
  assert fields['resolution'] == {'stringValue': '720p'}
  assert fields['generateAudio'] == {'booleanValue': True}
  assert fields['duration'] == {'integerValue': '4'}
  assert fields['numberOfCandidates'] == {'integerValue': '4'}


def _render_cors_origins(metadata):
  helper = _REPO / 'deploy' / 'render_cors_origins.py'
  return subprocess.run(
      [sys.executable, str(helper)],
      input=json.dumps(metadata),
      text=True,
      capture_output=True,
      check=False,
  )


def test_cors_generation_uses_all_returned_cloud_run_origins():
  """Both Cloud Run URLs must reach the generated bucket CORS document."""
  origins = [
      'https://app-27024139760.us-central1.run.app',
      'https://app-7jl6tkwhpa-uc.a.run.app',
  ]
  metadata_origins = [*origins, origins[0]]
  metadata = {
      'metadata': {
          'annotations': {
              'run.googleapis.com/urls': json.dumps(metadata_origins),
          }
      }
  }
  result = _render_cors_origins(metadata)
  assert result.returncode == 0, result.stderr
  rendered_template = (
      (_REPO / 'gcs-cors-config.template.json')
      .read_text(encoding='utf-8')
      .replace('${UI_CORS_ORIGINS}', result.stdout.strip())
  )
  config = json.loads(rendered_template)
  assert config[0]['origin'][:2] == [
      'http://localhost',
      'http://localhost:4200',
  ]
  assert config[0]['origin'][2:] == origins
  assert 'localhost' not in config[0]['origin']
  assert 'localhost:4200' not in config[0]['origin']
  assert config[0]['method'] == ['GET', 'HEAD', 'PUT']
  assert 'POST' not in config[0]['method']
  assert 'DELETE' not in config[0]['method']
  assert config[0]['responseHeader'] == ['Content-Type']
  assert config[0]['maxAgeSeconds'] == 3600


def test_status_viewer_iframe_sandbox_disallows_scripts():
  """CM-SM-001: status viewer iframe must be sandboxed without script execution."""
  viewer_js = (
      _REPO / 'ui' / 'remix-engine-status-viewer' / 'renderWorkflow.js'
  ).read_text(encoding='utf-8')
  assert "iframe.setAttribute('sandbox', '')" in viewer_js
  assert 'allow-scripts' not in viewer_js



@pytest.mark.parametrize(
    'metadata',
    [
        {},
        {'metadata': {'annotations': {}}},
        {'metadata': {'annotations': {'run.googleapis.com/urls': 'not-json'}}},
        {
            'metadata': {
                'annotations': {
                    'run.googleapis.com/urls': ['https://app.example']
                }
            }
        },
        {'metadata': {'annotations': {'run.googleapis.com/urls': '[]'}}},
        {
            'metadata': {
                'annotations': {
                    'run.googleapis.com/urls': json.dumps(
                        ['https://app.example/path']
                    )
                }
            }
        },
        {
            'metadata': {
                'annotations': {
                    'run.googleapis.com/urls': json.dumps(
                        ['https://app.example/*']
                    )
                }
            }
        },
        {
            'metadata': {
                'annotations': {
                    'run.googleapis.com/urls': json.dumps(
                        ['https://user:pass@app.example']
                    )
                }
            }
        },
        {
            'metadata': {
                'annotations': {
                    'run.googleapis.com/urls': json.dumps(
                        ['https://app.example\t']
                    )
                }
            }
        },
    ],
)
def test_cors_generation_fails_closed_for_malformed_url_metadata(metadata):
  """Missing/invalid annotations must not fabricate a CORS origin."""
  result = _render_cors_origins(metadata)
  assert result.returncode != 0
  assert result.stdout == ''


def test_deploy_wires_returned_origins_into_bucket_template():
  """The deploy must use the validated annotation output, not ignore it."""
  text = _deploy_sh()
  metadata = "--format='json(metadata.annotations.\"run.googleapis.com/urls\")'"
  render = 'python3 ./deploy/render_cors_origins.py'
  assert metadata in text
  assert render in text
  assert 'export UI_CORS_ORIGINS' in text
  render_pos = text.index(render)
  export_pos = text.index('export UI_CORS_ORIGINS')
  template_pos = text.index('envsubst < ./gcs-cors-config.template.json')
  assert render_pos < export_pos < template_pos


def test_no_destructive_authorized_domains_update():
  """Regression guard for issue #102.

  The old deploy-ui.sh PATCHed the Identity Toolkit config with
  updateMask=authorizedDomains and a hardcoded array. Because PATCH replaces the
  whole array, it wiped every other app's authorized domains on a shared
  project, causing auth outages. The app is gated by IAP now, so the deploy
  never needs to touch the Firebase authorized-domains list at all.

  If this guard fails, an authorized-domains write was reintroduced. Remove it.
  Only if a merge-safe update is ever genuinely required, implement a
  GET-then-merge-then-deduplicate update and update this test deliberately.
  """
  text = _deploy_text()
  assert 'updateMask=authorizedDomains' not in text, (
      'A deploy script PATCHes updateMask=authorizedDomains. This replaces the '
      'whole authorized-domains list and wipes other apps on a shared project '
      '(issue #102). Remove it, or make it GET-merge-dedup safe and update this '
      'guard.'
  )
  # The camelCase API field should not appear at all (prose like
  # "authorized-domains" in comments is fine; the API identifier is not).
  assert 'authorizedDomains' not in text, (
      'A deploy script references the authorizedDomains API field. The deploy '
      'must not write the Firebase authorized-domains list (issue #102).'
  )


def test_firebase_auth_stays_removed():
  """The app is IAP-only: the Firebase-Auth sign-in path was removed. This
  guards that posture so a regression that re-adds Firebase Auth fails here,
  in every PR, with no backend deps. It checks the three places the removed
  auth path lived:

    * the UI no longer depends on @angular/fire (the Firebase web SDK),
    * orch.py has no firebaseCustomToken route and no firebase_admin import
      (the backend no longer mints custom tokens for the browser),
    * requirements.txt has no direct firebase-admin entry.
  """
  pkg = (_REPO / 'ui' / 'package.json').read_text(encoding='utf-8')
  assert '@angular/fire' not in pkg, (
      'ui/package.json depends on @angular/fire. The app is IAP-only; the '
      'Firebase web SDK was removed, so this dependency must not return.'
  )

  orch = (_REPO / 'orch.py').read_text(encoding='utf-8')
  assert 'firebaseCustomToken' not in orch, (
      'orch.py references firebaseCustomToken. The app is IAP-only; the backend '
      'no longer mints a Firebase custom token for the browser.'
  )
  assert 'import firebase_admin' not in orch, (
      'orch.py imports firebase_admin. The app is IAP-only; the backend uses '
      'the Cloud client libraries for Firestore/Storage, not firebase_admin.'
  )

  reqs = (_REPO / 'requirements.txt').read_text(encoding='utf-8')
  # A direct dependency is pinned at the start of a line ("firebase-admin==").
  # Transitive "# via firebase-admin" comment lines are harmless and allowed.
  has_direct = any(
      line.startswith('firebase-admin==') for line in reqs.splitlines()
  )
  assert not has_direct, (
      'requirements.txt has a direct firebase-admin entry. The app is IAP-only '
      'and the backend no longer uses firebase-admin, so it must not return as '
      'a direct dependency.'
  )


def test_build_and_runtime_service_accounts_are_distinct():
  """P2#1: the build identity and the request-serving (runtime) identity must be
  two different service accounts. Sharing one SA means every build-time role
  (notably artifactregistry.writer) also lands on the public-facing app, so a
  compromised app could push container images. If this fails, BUILD_SA and
  RUNTIME_SA were collapsed back into one identity.
  """
  text = _deploy_sh()
  build = re.search(r'^BUILD_SA="([^"]+)"', text, re.MULTILINE)
  runtime = re.search(r'^RUNTIME_SA="([^"]+)"', text, re.MULTILINE)
  assert build, 'deploy.sh has no BUILD_SA="..." definition.'
  assert runtime, 'deploy.sh has no RUNTIME_SA="..." definition.'
  assert build.group(1) != runtime.group(1), (
      'BUILD_SA and RUNTIME_SA resolve to the same service account. The build '
      'and runtime identities must differ so build-time roles never reach the '
      'request-serving identity (P2#1).'
  )


def test_artifactregistry_writer_is_build_only_not_runtime():
  """P2#1: roles/artifactregistry.writer is a build-time push permission. It
  must be granted to the build identity only, never to the runtime SA role list,
  so a compromise of the public-facing app cannot push or overwrite container
  images. If this fails, the push role was added back to the runtime ROLES
  array — move it to the BUILD_SA grants instead.
  """
  text = _deploy_sh()
  roles_array = re.search(r'^ROLES=\((.*?)^\)', text, re.MULTILINE | re.DOTALL)
  assert roles_array, 'Could not find the runtime ROLES=( ... ) array.'
  assert 'artifactregistry.writer' not in roles_array.group(1), (
      'roles/artifactregistry.writer is in the runtime SA ROLES array. It is a '
      'build-time push role and must live on BUILD_SA only, not the '
      'request-serving identity (P2#1).'
  )
  # It must still be granted somewhere — the image build needs it on BUILD_SA.
  assert 'artifactregistry.writer' in text, (
      'roles/artifactregistry.writer is granted nowhere in deploy.sh; the image '
      'build needs it on BUILD_SA to push the image.'
  )


def test_cloudtasks_lock_ttl_step_present():
  """PR #113 added a duplicate-execution lock (Cloud Tasks is at-least-once):
  the orchestrator records a `cloudTasks/{exec}_{node}_{group}` doc with an
  `expiresAt`, and the deploy enables a Firestore TTL on that collection so the
  lock docs auto-expire. This PR rewrites deploy.sh, so guard that the TTL step
  survives — without it the lock docs accumulate forever (and a stale one could
  wrongly block a legitimate re-run). See util/database.py acquire_task_lock.
  """
  text = _deploy_sh()
  assert (
      'fields ttls update expiresAt' in text
      and '--collection-group=cloudTasks' in text
  ), (
      'deploy.sh no longer enables the Firestore TTL on the cloudTasks '
      'collection. The Cloud Tasks duplicate-execution lock (PR #113) relies on '
      'it so lock docs auto-expire; re-add the `gcloud firestore fields ttls '
      'update expiresAt --collection-group=cloudTasks` step after the backend '
      'Firestore database is ensured.'
  )


def test_iam_bindings_go_through_retry_wrappers():
  """D1/D2: deploy.sh must not call `gcloud {run services|iam service-accounts}
  add-iam-policy-binding` directly. Those raw read-modify-writes have no
  etag-retry, so a transient concurrent-policy race aborts the deploy after the
  services are already live. Every such binding must go through the libs.sh
  wrappers (add_run_invoker_binding / add_sa_iam_binding), which share the
  tested retry path. (The raw gcloud calls legitimately live inside the wrappers
  in deploy/libs.sh, which this guard does not read.)
  """
  text = _deploy_sh()
  for raw in (
      'gcloud run services add-iam-policy-binding',
      'gcloud iam service-accounts add-iam-policy-binding',
  ):
    assert raw not in text, (
        f'deploy.sh calls `{raw}` directly. Route it through the retrying '
        'wrapper in deploy/libs.sh (add_run_invoker_binding / '
        'add_sa_iam_binding) so a transient IAM race cannot abort the deploy.'
    )


def test_no_infinite_gunicorn_timeout():
  """D7: the gunicorn CMD must not use `--timeout 0`, which disables the
  worker-kill watchdog so a wedged request thread is never reaped (only Cloud
  Run's own request timeout bounds it). The CPU-bound worker must set a finite
  GUNICORN_TIMEOUT (above its Cloud Run request timeout, so a legitimate render
  is never killed early).
  """
  assert '--timeout 0' not in _dockerfile(), (
      'Dockerfile gunicorn CMD uses `--timeout 0`, disabling the request '
      'timeout so a wedged thread is never reaped. Use a finite timeout (D7).'
  )
  assert 'GUNICORN_TIMEOUT=' in _deploy_sh(), (
      'deploy.sh does not set GUNICORN_TIMEOUT for the worker. The CPU-bound '
      'worker needs a finite gunicorn timeout above its Cloud Run request '
      'timeout (D7).'
  )


def test_dictation_flag_is_optional_validated_and_app_only():
  """Dictation defaults on, remains opt-out, and is app-only."""
  template = (_REPO / 'config.template.txt').read_text(encoding='utf-8')
  text = _deploy_sh()
  assert 'export DICTATION_ENABLED=1' in template
  assert 'DICTATION_ENABLED="${DICTATION_ENABLED:-1}"' in text
  assert 'DICTATION_ENABLED must be 0 or 1' in text
  assert 'export DICTATION_MODE=SMART' in template
  assert 'DICTATION_MODE="${DICTATION_MODE-SMART}"' in text
  assert 'DICTATION_MODE must be SMART or VERBATIM' in text
  worker_block = text.split('gcloud run deploy worker', 1)[1].split(
      'gcloud run deploy app', 1
  )[0]
  assert 'DICTATION_ENABLED=' not in worker_block
  assert 'DICTATION_MODE=' not in worker_block
  app_blocks = text.split('--set-env-vars=ROLE=app')[1:]
  assert app_blocks and all('DICTATION_ENABLED=${DICTATION_ENABLED}' in block for block in app_blocks)
  assert all('DICTATION_MODE=${DICTATION_MODE}' in block for block in app_blocks)


@pytest.mark.parametrize('value, selected, expected, error', [
    (None, '1', 0, ''),
    ('0', '0', 0, ''),
    ('1', '1', 0, ''),
    ('invalid', None, 1, 'DICTATION_ENABLED must be 0 or 1'),
    ('2', None, 1, 'DICTATION_ENABLED must be 0 or 1'),
])
def test_dictation_deploy_validation_executes_default_and_opt_out(
    value, selected, expected, error
):
  """Execute the deploy.sh flag block without running the deploy."""
  text = _deploy_sh()
  match = re.search(
      r'(?ms)^(DICTATION_ENABLED="\$\{DICTATION_ENABLED:-1\}"\n'
      r'if \[\[.*?^fi)$',
      text,
  )
  assert match
  block = match.group(1) + '\nprintf "%s\\n" "$DICTATION_ENABLED"\n'
  environment = os.environ.copy()
  environment.pop('DICTATION_ENABLED', None)
  if value is not None:
    environment['DICTATION_ENABLED'] = value
  result = subprocess.run(
      ['bash', '-c', block], env=environment, capture_output=True, text=True,
      check=False,
  )
  assert result.returncode == expected
  if selected is not None:
    assert result.stdout.strip() == selected
  else:
    assert error in result.stderr


@pytest.mark.parametrize('value, selected, expected, error', [
    (None, 'SMART', 0, ''),
    ('SMART', 'SMART', 0, ''),
    ('VERBATIM', 'VERBATIM', 0, ''),
    ('', None, 1, 'DICTATION_MODE must be SMART or VERBATIM'),
    ('smart', None, 1, 'DICTATION_MODE must be SMART or VERBATIM'),
    ('OTHER', None, 1, 'DICTATION_MODE must be SMART or VERBATIM'),
])
def test_dictation_mode_deploy_validation_executes_exact_allowlist(
    value, selected, expected, error
):
  """Execute the deploy.sh mode block without running the deploy."""
  text = _deploy_sh()
  match = re.search(
      r'(?ms)^(DICTATION_MODE="\$\{DICTATION_MODE-SMART\}"\n'
      r'if \[\[.*?^fi)$',
      text,
  )
  assert match
  block = match.group(1) + '\nprintf "%s\\n" "$DICTATION_MODE"\n'
  environment = os.environ.copy()
  environment.pop('DICTATION_MODE', None)
  if value is not None:
    environment['DICTATION_MODE'] = value
  result = subprocess.run(
      ['bash', '-c', block], env=environment, capture_output=True, text=True,
      check=False,
  )
  assert result.returncode == expected
  if selected is not None:
    assert result.stdout.strip() == selected
  else:
    assert error in result.stderr


def test_announcement_seed_is_create_only_and_validated_before_write():
  """Announcement seeding must never overwrite an operator document."""
  template = (_REPO / 'config.template.txt').read_text(encoding='utf-8')
  text = _deploy_sh()
  assert 'ANNOUNCEMENT_ID' not in template
  assert 'export ANNOUNCEMENT_MARKDOWN_FILE=config/announcement.md' in template
  assert 'export ANNOUNCEMENT_ENABLED=1' in template
  assert 'scripts/seed_announcement.py convert' in text
  assert 'ANNOUNCEMENT_SEED_JSON=' not in text
  assert 'documents/config?documentId=announcement' in text
  assert 'ANNOUNCEMENT_SEED_STATUS' in text
  assert 'ANNOUNCEMENT_ID' not in text
  announcement_block = text.split('ANNOUNCEMENT_MARKDOWN_FILE=', 1)[1]
  assert 'python3 scripts/seed_announcement.py seed' in announcement_block
  assert 'if ! ANNOUNCEMENT_SEED_STATUS=$(' in announcement_block
  assert 'documents/config/announcement' not in announcement_block
  assert announcement_block.index('scripts/seed_announcement.py convert') < announcement_block.index(
      'scripts/seed_announcement.py seed'
  )


def test_announcement_seed_is_not_enabled_on_worker():
  text = _deploy_sh()
  worker_block = text.split('gcloud run deploy worker', 1)[1].split(
      'gcloud run deploy app', 1
  )[0]
  assert 'ANNOUNCEMENT' not in worker_block


@pytest.mark.parametrize(
    "config_val, mock_responses, expected_rc, expected_val, expected_err",
    [
        # Config value wins over live value (1 over live 0, and 0 over live 1)
        (
            "1",
            {
                "list": "app",
                "full_env": "ROLE,DICTATION_ENABLED",
                "describe": "0",
            },
            0,
            "1",
            "",
        ),
        (
            "0",
            {
                "list": "app",
                "full_env": "ROLE,DICTATION_ENABLED",
                "describe": "1",
            },
            0,
            "0",
            "",
        ),
        # Live 0 is preserved when config omits the flag
        (
            None,
            {
                "list": "app",
                "full_env": "ROLE,DICTATION_ENABLED",
                "describe": "0",
            },
            0,
            "0",
            "",
        ),
        # Live 1 is preserved when config omits the flag
        (
            None,
            {
                "list": "app",
                "full_env": "ROLE,DICTATION_ENABLED",
                "describe": "1",
            },
            0,
            "1",
            "",
        ),
        # Service-absent (first deploy) falls back to 1
        (None, {"list": ""}, 0, "1", ""),
        # Full-env non-empty but no DICTATION_ENABLED falls back to 1
        (
            None,
            {"list": "app", "full_env": "ROLE,AUTH_MODE", "describe": ""},
            0,
            "1",
            "",
        ),
        # Full-env extraction returns empty -> abort, non-zero exit
        (
            None,
            {"list": "app", "full_env": "", "describe": ""},
            1,
            None,
            "Could not extract environment from existing 'app' service",
        ),
        # Full-env describe-failure aborts rather than defaulting
        (
            None,
            {"list": "app", "full_env_fail": True},
            1,
            None,
            "Failed to read environment from existing 'app' service",
        ),
        # Dictation describe-failure aborts rather than defaulting
        (
            None,
            {
                "list": "app",
                "full_env": "ROLE,AUTH_MODE",
                "describe_fail": True,
            },
            1,
            None,
            "Failed to read DICTATION_ENABLED from existing 'app' service",
        ),
        # List-failure aborts rather than defaulting
        (
            None,
            {"list_fail": True},
            1,
            None,
            "Failed to query Cloud Run services",
        ),
        # Prefix/substring service names (e.g. my-app) do not match exact 'app'
        (
            None,
            {"list": "my-app\nscene-machine-app", "full_env_fail": True},
            0,
            "1",
            "",
        ),
        # Invalid live DICTATION_ENABLED value on existing service aborts
        (
            None,
            {
                "list": "app",
                "full_env": "ROLE,DICTATION_ENABLED",
                "describe": "invalid",
            },
            1,
            None,
            "DICTATION_ENABLED must be 0 or 1",
        ),
    ],
)
def test_dictation_env_preservation_precedence_and_failure_modes(
    config_val, mock_responses, expected_rc, expected_val, expected_err
):
  """Verify live dictation preservation, precedence, and fail-closed checks."""
  text = _deploy_sh()
  match = re.search(
      r"(?ms)^(if \[ -z \"\$\{DICTATION_ENABLED:-\}\" \]; then\n"
      r".*?\n"
      r"DICTATION_ENABLED=\"\$\{DICTATION_ENABLED:-1\}\"\n"
      r"if \[\[.*?^fi)$",
      text,
  )
  assert match, "DICTATION_ENABLED preservation and validation block not found"
  block = match.group(1)

  mock_parts = ["gcloud() {"]
  if mock_responses.get("list_fail"):
    mock_parts.append(
        '  if [ "$1" = "run" ] && [ "$2" = "services" ] && '
        '[ "$3" = "list" ]; then return 1; fi'
    )
  elif "list" in mock_responses:
    list_val = mock_responses["list"]
    mock_parts.append(
        '  if [ "$1" = "run" ] && [ "$2" = "services" ] && '
        f'[ "$3" = "list" ]; then echo "{list_val}"; return 0; fi'
    )

  mock_parts.append(
      '  if [ "$1" = "run" ] && [ "$2" = "services" ] && '
      '[ "$3" = "describe" ]; then'
  )
  mock_parts.append('    case "$*" in')
  if mock_responses.get("full_env_fail"):
    mock_parts.append('      *"extract(name)"*) return 1 ;;')
  else:
    full_env_val = mock_responses.get("full_env", "ROLE,AUTH_MODE")
    mock_parts.append(
        f'      *"extract(name)"*) echo "{full_env_val}"; return 0 ;;'
    )

  if mock_responses.get("describe_fail"):
    mock_parts.append('      *"filter(name=DICTATION_ENABLED)"*) return 1 ;;')
  else:
    desc_val = mock_responses.get("describe", "")
    mock_parts.append(
        '      *"filter(name=DICTATION_ENABLED)"*) '
        f'echo "{desc_val}"; return 0 ;;'
    )

  mock_parts.append('    esac')
  mock_parts.append('  fi')
  mock_parts.append("  return 1\n}")
  mock_func = "\n".join(mock_parts)

  script = f"""{mock_func}
{block}
printf "%s\\n" "$DICTATION_ENABLED"
"""
  environment = os.environ.copy()
  environment["REGION"] = "us-central1"
  environment["PROJECT"] = "test-project"
  environment.pop("DICTATION_ENABLED", None)
  if config_val is not None:
    environment["DICTATION_ENABLED"] = config_val

  result = subprocess.run(
      ["bash", "-c", script],
      env=environment,
      capture_output=True,
      text=True,
      check=False,
  )
  assert result.returncode == expected_rc
  if expected_val is not None:
    assert result.stdout.strip() == expected_val
  if expected_err:
    assert expected_err in result.stderr


def test_first_deploy_dictation_probe_runs_after_api_enablement(tmp_path):
  """A first deploy must enable Cloud Run before probing the absent service."""
  text = _deploy_sh()
  enable_start = text.index('# --- Enable services')
  enable_call = text.index('gcloud services enable $TO_ENABLE', enable_start)
  explicit_validation = text.index(
      'if [ -n "${DICTATION_ENABLED:-}" ] && [[',
  )
  confirmation = text.index('read -r -p "Proceed and deploy')
  assert explicit_validation < confirmation < enable_start
  probe_start = text.index('if [ -z "${DICTATION_ENABLED:-}" ]; then')
  assert enable_call < probe_start

  enable_block = text[enable_start:text.index(
      '# Warm up Vertex AI service agent.', enable_call
  )]
  script = f'''\
set -euo pipefail
gcloud() {{
  if [ "${{1:-}}" = services ] && [ "${{2:-}}" = list ]; then
    printf '%s\\n' "$ENABLED_APIS"
  elif [ "${{1:-}}" = services ] && [ "${{2:-}}" = enable ] && \
      [[ " $* " == *" run.googleapis.com "* ]]; then
    printf 'services-enable\\n' >> "$TRACE_FILE"
  elif [ "${{1:-}}" = run ] && [ "${{2:-}}" = services ] && \
      [ "${{3:-}}" = list ]; then
    printf 'run-list\\n' >> "$TRACE_FILE"
  else
    printf 'unexpected gcloud call: %s\\n' "$*" >&2
    return 1
  fi
}}
phase() {{ :; }}
PROJECT=test-project
REGION=us-central1
ENABLED_APIS=
{enable_block}
printf 'value=%s\\n' "$DICTATION_ENABLED"
'''
  environment = os.environ.copy()
  environment['TRACE_FILE'] = str(tmp_path / 'trace')
  environment.pop('DICTATION_ENABLED', None)
  trace_path = pathlib.Path(environment['TRACE_FILE'])
  trace_path.unlink(missing_ok=True)
  try:
    result = subprocess.run(
        ['bash', '-c', script], env=environment, capture_output=True,
        text=True, check=False,
    )
    trace = trace_path.read_text(encoding='utf-8')
  finally:
    trace_path.unlink(missing_ok=True)
  assert result.returncode == 0, result.stderr
  assert result.stdout.rstrip().endswith('value=1')
  assert trace.splitlines() == ['services-enable', 'run-list']


@pytest.mark.parametrize(
    "line, expected_match",
    [
        ("PROJECT=my-project", True),
        ("export PROJECT=my-project", True),
        ("PROJECT=\"my-project\"", True),
        ("export PROJECT=\"my-project\"", True),
        ("REGION=\"us central1\"", False),
        ("export REGION=\"us central1\"", False),
        ("export REGION=us central1", False),
        ("export PROJECT=\"my-project\" extra", False),
        ("export PROJECT=\"<YOUR_PROJECT_ID>\"", False),
        ("export REGION=us-central1 # inline comment", True),
        ("export GCS_BUCKET=\"${PROJECT}-scene-machine\"", True),
        ("export GCS_BUCKET=${PROJECT}-scene-machine", True),
        ("PROJECT=", False),
        ("export PROJECT=", False),
        ("PROJECT=\"\"", False),
        ("export PROJECT=\"\"", False),
        ("PROJECT='my-project'", False),
        ("export PROJECT='my-project'", False),
    ],
)
def test_config_validation_regex_accepts_quoted_and_rejects_empty(
    line, expected_match
):
  """Preflight regex accepts double-quoted config values but rejects empty."""
  text = _deploy_sh()
  match = re.search(
      r'(grep -qE "\^\(export \)\?\$\{var\}=\(.*?\)") \./config\.txt',
      text,
  )
  assert match, "Config validation grep command not found in deploy.sh"
  grep_cmd = match.group(1)
  var_match = re.match(r"^(?:export\s+)?([A-Za-z_]+)=", line)
  var = var_match.group(1) if var_match else "PROJECT"
  script = f"set -euo pipefail\nvar={var}\n{grep_cmd}\n"
  proc = subprocess.run(
      ["bash", "-c", script],
      input=line,
      capture_output=True,
      text=True,
      check=False,
  )
  assert proc.stderr == "", f"Bash error evaluating grep command: {proc.stderr}"
  assert (proc.returncode == 0) == expected_match
