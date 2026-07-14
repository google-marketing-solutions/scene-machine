"""Behavioral tests for service-account provisioning in the deploy helpers."""

import os
import pathlib
import subprocess

import pytest


_REPO = pathlib.Path(__file__).resolve().parent.parent
_DEPLOY_LIBS = _REPO / 'deploy' / 'libs.sh'
_DEPLOY_SH = _REPO / 'deploy.sh'


def _run_runtime_sa_helper(tmp_path: pathlib.Path, create_error: str):
  """Run the helper with a fake gcloud and a persistent invocation trace."""
  trace = tmp_path / 'gcloud-trace.txt'
  env = os.environ.copy()
  env['GCLOUD_TRACE'] = str(trace)
  env['CREATE_ERROR'] = create_error
  script = f"""
set -euo pipefail
source "{_DEPLOY_LIBS}"

sleep() {{
  printf 'sleep:%s\\n' "$1" >>"$GCLOUD_TRACE"
}}

gcloud() {{
  if [[ "$*" == "iam service-accounts describe"* ]]; then
    printf 'describe\\n' >>"$GCLOUD_TRACE"
    local describe_count
    describe_count=$(grep -c '^describe$' "$GCLOUD_TRACE")
    if [ "$describe_count" -ge 3 ]; then
      return 0
    fi
    printf 'NOT_FOUND: service account is not visible yet\\n' >&2
    return 1
  fi

  if [[ "$*" == "iam service-accounts create"* ]]; then
    printf 'create\\n' >>"$GCLOUD_TRACE"
    if [ -z "$CREATE_ERROR" ]; then
      return 0
    fi
    printf '%s\\n' "$CREATE_ERROR" >&2
    return 1
  fi

  printf 'unexpected gcloud call: %s\\n' "$*" >&2
  return 2
}}

ensure_runtime_service_account \
  'sm-runtime@test-project.iam.gserviceaccount.com' \
  'test-project' \
  3
"""
  result = subprocess.run(
      ['bash', '-c', script],
      check=False,
      capture_output=True,
      env=env,
      text=True,
  )
  calls = (
      trace.read_text(encoding='utf-8').splitlines() if trace.exists() else []
  )
  return result, calls


@pytest.mark.parametrize(
    'create_error',
    [
        'ALREADY_EXISTS: service account already exists',
        (
            'Service account sm-runtime already exists within project '
            'projects/test-project.'
        ),
    ],
)
def test_runtime_sa_concurrent_create_waits_until_visible(
    tmp_path, create_error
):
  result, calls = _run_runtime_sa_helper(tmp_path, create_error)

  assert result.returncode == 0, result.stderr
  assert calls == ['describe', 'create', 'describe', 'sleep:5', 'describe']
  assert 'created by another deploy' in result.stdout


def test_runtime_sa_create_waits_until_visible(tmp_path):
  result, calls = _run_runtime_sa_helper(tmp_path, '')

  assert result.returncode == 0, result.stderr
  assert calls == ['describe', 'create', 'describe', 'sleep:5', 'describe']


def test_runtime_sa_nonretryable_create_error_fails_immediately(tmp_path):
  result, calls = _run_runtime_sa_helper(tmp_path, 'PERMISSION_DENIED')

  assert result.returncode == 1
  assert calls == ['describe', 'create']
  assert 'PERMISSION_DENIED' in result.stderr


def test_runtime_sa_does_not_hide_mixed_permission_error(tmp_path):
  result, calls = _run_runtime_sa_helper(
      tmp_path,
      'PERMISSION_DENIED: resource already exists but access is denied',
  )

  assert result.returncode == 1
  assert calls == ['describe', 'create']
  assert 'PERMISSION_DENIED' in result.stderr


def test_deploy_uses_the_tested_runtime_sa_helper():
  text = _DEPLOY_SH.read_text(encoding='utf-8')

  assert (
      'ensure_runtime_service_account "$RUNTIME_SA" "$PROJECT" "$SA_WAIT_MAX"'
      in text
  )
  assert '|| gcloud iam service-accounts create sm-runtime' not in text
