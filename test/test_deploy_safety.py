"""Static safety guards on the deploy scripts.

These read the shell scripts as text and assert invariants. They need no backend
dependencies, so they always run in normal pytest collection (and in CI) and act
as cheap regression gates.
"""

import pathlib
import re

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
