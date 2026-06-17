"""Static safety guards on the deploy scripts.

These read the shell scripts as text and assert invariants. They need no backend
dependencies, so they always run in normal pytest collection (and in CI) and act
as cheap regression gates.
"""

import pathlib

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
