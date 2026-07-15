"""Behavioral tests for service-account provisioning in the deploy helpers."""

import os
import pathlib
import subprocess

import pytest


_REPO = pathlib.Path(__file__).resolve().parent.parent
_DEPLOY_LIBS = _REPO / 'deploy' / 'libs.sh'
_DEPLOY_SH = _REPO / 'deploy.sh'
_POLICY_ERROR_PREAMBLE = (
    'ERROR: Policy modification failed. For a binding with condition, run'
    ' "gcloud alpha iam policies lint-condition" to identify issues in'
    ' condition.'
)


def _runtime_sa_iam_lag(project: str = 'test-project') -> str:
  return (
      f'{_POLICY_ERROR_PREAMBLE}\n'
      'ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: '
      f'Service account sm-runtime@{project}.iam.gserviceaccount.com does not '
      'exist.'
  )


_RUNTIME_SA_IAM_LAG = _runtime_sa_iam_lag()


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
      timeout=5,
  )
  calls = (
      trace.read_text(encoding='utf-8').splitlines() if trace.exists() else []
  )
  return result, calls


def _run_project_iam_binding(
    tmp_path: pathlib.Path,
    *,
    write_error: str,
    failures_before_success: int,
    member: str | None = None,
    project: str = 'test-project',
    write_errors: tuple[str, ...] = (),
):
  trace = tmp_path / 'project-iam-trace.txt'
  if member is None:
    member = f'serviceAccount:sm-runtime@{project}.iam.gserviceaccount.com'
  env = os.environ.copy()
  env.update({
      'GCLOUD_TRACE': str(trace),
      'WRITE_ERROR': write_error,
      'FAILURES_BEFORE_SUCCESS': str(failures_before_success),
      'IAM_MEMBER': member,
      'IAM_PROJECT': project,
  })
  for index, error in enumerate(write_errors, start=1):
    env[f'WRITE_ERROR_{index}'] = error
  env['WRITE_ERROR_COUNT'] = str(len(write_errors))
  script = f"""
set -euo pipefail
source "{_DEPLOY_LIBS}"

sleep() {{
  printf 'sleep:%s\n' "$1" >>"$GCLOUD_TRACE"
}}

gcloud() {{
  if [[ "$*" == "projects get-iam-policy"* ]]; then
    printf 'get-policy\n' >>"$GCLOUD_TRACE"
    return 0
  fi

  if [[ "$*" == "projects add-iam-policy-binding"* ]]; then
    printf 'add-binding\n' >>"$GCLOUD_TRACE"
    local write_count
    write_count=$(grep -c '^add-binding$' "$GCLOUD_TRACE")
    if [ "$write_count" -le "$WRITE_ERROR_COUNT" ]; then
      local error_var="WRITE_ERROR_${{write_count}}"
      printf '%s\n' "${{!error_var}}" >&2
      return 1
    fi
    if [ "$write_count" -le "$FAILURES_BEFORE_SUCCESS" ]; then
      printf '%s\n' "$WRITE_ERROR" >&2
      return 1
    fi
    return 0
  fi

  printf 'unexpected gcloud call: %s\n' "$*" >&2
  return 2
}}

add_iam_binding \
  "$IAM_PROJECT" \
  "--member=$IAM_MEMBER" \
  '--role=roles/aiplatform.user'
"""
  result = subprocess.run(
      ['bash', '-c', script],
      check=False,
      capture_output=True,
      env=env,
      text=True,
      timeout=5,
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


@pytest.mark.parametrize(
    'write_error',
    [_RUNTIME_SA_IAM_LAG, _RUNTIME_SA_IAM_LAG.splitlines()[-1]],
)
def test_runtime_sa_project_binding_retries_until_iam_accepts_member(
    tmp_path, write_error
):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=2,
  )

  assert result.returncode == 0, result.stderr
  assert calls[0] == 'get-policy'
  assert calls.count('add-binding') == 3
  assert sum(call.startswith('sleep:') for call in calls) == 2
  assert 'succeeded on attempt 3' in result.stdout


@pytest.mark.parametrize(
    'write_error',
    [
        f'WARNING: Google Cloud CLI update available.\n{_RUNTIME_SA_IAM_LAG}',
        f'{_RUNTIME_SA_IAM_LAG}\nNOTICE: diagnostic details omitted.',
    ],
)
def test_runtime_sa_project_binding_tolerates_benign_extra_output(
    tmp_path, write_error
):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
  )

  assert result.returncode == 0, result.stderr
  assert calls[0] == 'get-policy'
  assert calls.count('add-binding') == 2
  assert sum(call.startswith('sleep:') for call in calls) == 1
  assert 'succeeded on attempt 2' in result.stdout


@pytest.mark.parametrize(
    'extra_error',
    [
        'PERMISSION_DENIED: access denied',
        'ABORTED: stale etag',
        'ERROR: RESOURCE_EXHAUSTED',
    ],
)
def test_runtime_sa_project_binding_rejects_extra_error_output(
    tmp_path, extra_error
):
  write_error = (
      'WARNING: Google Cloud CLI update available.\n'
      f'{_RUNTIME_SA_IAM_LAG}\n{extra_error}'
  )
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
  )

  assert result.returncode == 1
  assert calls == ['get-policy', 'add-binding']
  assert write_error in result.stderr


def test_runtime_sa_propagation_budget_ignores_retry_words_in_project_id(
    tmp_path,
):
  project = 'stale-project'
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=_runtime_sa_iam_lag(project),
      failures_before_success=6,
      project=project,
  )

  assert result.returncode == 0, result.stderr
  assert calls.count('add-binding') == 7
  assert sum(call.startswith('sleep:') for call in calls) == 6
  assert 'succeeded on attempt 7' in result.stdout


def test_runtime_sa_propagation_budget_survives_later_etag_conflict(tmp_path):
  errors = (_RUNTIME_SA_IAM_LAG,) * 5 + ('ABORTED: stale etag',)
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error='',
      failures_before_success=0,
      write_errors=errors,
  )

  assert result.returncode == 0, result.stderr
  assert calls.count('add-binding') == 7
  assert sum(call.startswith('sleep:') for call in calls) == 6
  assert 'succeeded on attempt 7' in result.stdout


def test_fatal_error_after_propagation_does_not_inherit_long_retry_budget(
    tmp_path,
):
  project = 'stale-project'
  fatal_error = f'ERROR: project {project} was not found.'
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error='',
      failures_before_success=0,
      project=project,
      write_errors=(_runtime_sa_iam_lag(project), fatal_error),
  )

  assert result.returncode == 1
  assert calls.count('add-binding') == 2
  assert sum(call.startswith('sleep:') for call in calls) == 1
  assert fatal_error in result.stderr


def test_unrelated_error_after_propagation_masks_retry_word_in_project_id(
    tmp_path,
):
  project = 'stale-project'
  unrelated_error = (
      f'ERROR: RESOURCE_EXHAUSTED: quota exceeded for project {project}.'
  )
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error='',
      failures_before_success=0,
      project=project,
      write_errors=(_runtime_sa_iam_lag(project), unrelated_error),
  )

  assert result.returncode == 1
  assert calls.count('add-binding') == 2
  assert sum(call.startswith('sleep:') for call in calls) == 1
  assert unrelated_error in result.stderr


def test_known_missing_sa_line_with_conflict_output_fails_closed(tmp_path):
  missing_sa_line = _RUNTIME_SA_IAM_LAG.splitlines()[-1]
  write_error = f'{missing_sa_line}\nABORTED: stale etag'
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
  )

  assert result.returncode == 1
  assert calls == ['get-policy', 'add-binding']
  assert write_error in result.stderr


def test_runtime_sa_mixed_permission_error_fails_in_stale_named_project(
    tmp_path,
):
  project = 'stale-project'
  write_error = f'{_runtime_sa_iam_lag(project)}\nPERMISSION_DENIED: denied'
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
      project=project,
  )

  assert result.returncode == 1
  assert calls == ['get-policy', 'add-binding']
  assert write_error in result.stderr


def test_retry_word_in_runtime_email_does_not_make_other_error_retryable(
    tmp_path,
):
  project = 'stale-project'
  write_error = (
      'INVALID_ARGUMENT: member serviceAccount:'
      f'sm-runtime@{project}.iam.gserviceaccount.com is malformed'
  )
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
      project=project,
  )

  assert result.returncode == 1
  assert calls == ['get-policy', 'add-binding']
  assert write_error in result.stderr


def test_runtime_sa_project_binding_propagation_retry_is_bounded(tmp_path):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=_RUNTIME_SA_IAM_LAG,
      failures_before_success=99,
  )

  delays = [
      int(call.removeprefix('sleep:'))
      for call in calls
      if call.startswith('sleep:')
  ]
  assert result.returncode == 1
  assert calls.count('add-binding') == 14
  assert len(delays) == 13
  assert max(delays) <= 60
  assert 480 <= sum(delays) < 600
  assert 'after 14 attempts' in result.stderr


def test_project_binding_first_attempt_success_does_not_sleep(tmp_path):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=_RUNTIME_SA_IAM_LAG,
      failures_before_success=0,
  )

  assert result.returncode == 0, result.stderr
  assert calls == ['get-policy', 'add-binding']


def test_existing_etag_retry_keeps_its_six_attempt_bound(tmp_path):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error='ABORTED: stale etag',
      failures_before_success=99,
  )

  assert result.returncode == 1
  assert calls.count('add-binding') == 6
  assert sum(call.startswith('sleep:') for call in calls) == 5
  assert 'after 6 attempts' in result.stderr


@pytest.mark.parametrize(
    ('write_error', 'member'),
    [
        (
            (
                'ERROR: (gcloud.projects.add-iam-policy-binding)'
                ' INVALID_ARGUMENT: Service account'
                ' other@test-project.iam.gserviceaccount.com does not exist.'
            ),
            'serviceAccount:other@test-project.iam.gserviceaccount.com',
        ),
        (
            (
                'ERROR: (gcloud.projects.add-iam-policy-binding)'
                ' INVALID_ARGUMENT: Service account'
                ' sm-runtime@other-project.iam.gserviceaccount.com does not'
                ' exist.'
            ),
            'serviceAccount:sm-runtime@other-project.iam.gserviceaccount.com',
        ),
        (
            f'{_RUNTIME_SA_IAM_LAG}\nPERMISSION_DENIED: access denied',
            'serviceAccount:sm-runtime@test-project.iam.gserviceaccount.com',
        ),
        (
            'INVALID_ARGUMENT: referenced resource does not exist',
            'serviceAccount:sm-runtime@test-project.iam.gserviceaccount.com',
        ),
        (
            'NOT_FOUND: an unrelated IAM resource does not exist',
            'serviceAccount:sm-runtime@test-project.iam.gserviceaccount.com',
        ),
    ],
)
def test_project_binding_does_not_retry_unrelated_errors(
    tmp_path, write_error, member
):
  result, calls = _run_project_iam_binding(
      tmp_path,
      write_error=write_error,
      failures_before_success=1,
      member=member,
  )

  assert result.returncode == 1
  assert calls == ['get-policy', 'add-binding']
  assert write_error in result.stderr


def test_deploy_uses_the_tested_runtime_sa_helper():
  text = _DEPLOY_SH.read_text(encoding='utf-8')

  assert (
      'ensure_runtime_service_account "$RUNTIME_SA" "$PROJECT" "$SA_WAIT_MAX"'
      in text
  )
  assert '|| gcloud iam service-accounts create sm-runtime' not in text


def test_deploy_runtime_roles_use_the_tested_project_binding_helper():
  text = _DEPLOY_SH.read_text(encoding='utf-8')
  runtime_roles = text.split(
      'phase "Granting ${#ROLES[@]} roles to ${RUNTIME_SA}..."', 1
  )[1].split('echo "✓ Roles granted."', 1)[0]

  assert (
      'add_iam_binding $PROJECT '
      '--member="serviceAccount:${RUNTIME_SA}" '
      '--role="$ROLE" --condition=None'
      in runtime_roles
  )
