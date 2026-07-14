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

# shellcheck shell=bash
# ---------------------------------------------------------------------------
# deploy/libs.sh — shared helper functions for the Scene Machine deploy scripts.
#
# This file is meant to be SOURCED, not run directly:
#     source "$(dirname "$0")/deploy/libs.sh"
#
# It defines the IAM-binding retry wrapper, config-file generation, and the tool
# pre-flight check so deploy.sh (and any future deploy helper) can reuse them
# without copy-paste.
# ---------------------------------------------------------------------------

# Core retry+backoff loop shared by every add-*-iam-binding wrapper below.
# Background GCP work (service-agent provisioning) modifies IAM
# policies in parallel with our sequential read-modify-writes, occasionally
# racing our etag; the gcloud error itself recommends "retry with exponential
# backoff", which this does. It retries ONLY on concurrent-modification/etag
# races and fails fast on real errors (permission-denied, bad argument).
#   $1     - log label, e.g. " (for roles/run.invoker on app)"
#   $2..   - the full gcloud argv to run (--quiet is appended)
# Used by add_iam_binding (project), add_run_invoker_binding (run service), and
# add_sa_iam_binding (service-account resource) so all three share one tested
# retry path instead of three hand-rolled raw calls. (D1/D2)
_retry_iam_write() {
  local label="$1"
  shift

  # Capture stderr in a variable (stdout discarded) rather than a temp file +
  # RETURN trap: a RETURN trap set in this helper would also fire on the
  # CALLER wrapper's return, dereferencing an out-of-scope var under `set -u`
  # and aborting the deploy.
  local err
  local attempt=1
  local max_attempts=6
  while true; do
    if err=$("$@" --quiet 2>&1 >/dev/null); then
      if [ $attempt -gt 1 ]; then
        echo "  ✓ IAM binding${label} succeeded on attempt $attempt."
      fi
      return 0
    fi

    # Only retry on concurrent-modification / etag races. Permission, argument,
    # and not-found errors won't fix themselves — surface them immediately.
    if ! grep -qiE 'concurrent|aborted|etag|stale' <<<"$err"; then
      echo "  ERROR: IAM binding${label} failed with a non-retryable error:" >&2
      echo "$err" >&2
      return 1
    fi

    if [ $attempt -ge $max_attempts ]; then
      echo "  ERROR: IAM binding${label} still conflicting after $max_attempts attempts:" >&2
      echo "$err" >&2
      return 1
    fi

    # Exponential backoff with ±25% jitter to desynchronise retries when
    # multiple bindings race the same background modifier.
    local base=$((2 ** attempt))
    local jitter=$((RANDOM % (base / 2 + 1) - base / 4))
    local backoff=$((base + jitter))
    [ $backoff -lt 1 ] && backoff=1

    echo "  IAM binding${label} hit a transient conflict — retrying in ${backoff}s (attempt $attempt/$max_attempts)..."
    sleep $backoff
    attempt=$((attempt + 1))
  done
}

# Ensure the dedicated Scene Machine runtime service account exists and is
# visible before the deploy grants it roles. A second deploy can observe the
# account as missing while IAM is still propagating it, then lose the create
# race with ALREADY_EXISTS. Treat only that specific create result as benign;
# real create failures (permission, policy, invalid arguments) still fail
# immediately. Call as: ensure_runtime_service_account <email> <project> <max>
ensure_runtime_service_account() {
  local runtime_sa="$1" project="$2" max_attempts="$3"
  local create_output=""

  if gcloud iam service-accounts describe "$runtime_sa" \
      --project="$project" &>/dev/null; then
    return 0
  fi

  if create_output=$(gcloud iam service-accounts create sm-runtime \
      --project="$project" \
      --display-name="Scene Machine runtime (app + worker)" 2>&1); then
    [ -z "$create_output" ] || printf '%s\n' "$create_output"
  elif grep -q 'ALREADY_EXISTS:' <<<"$create_output" \
      || grep -Fq \
        "Service account sm-runtime already exists within project projects/${project}" \
        <<<"$create_output"; then
    echo "  Runtime service account was created by another deploy; waiting for visibility."
  else
    echo "ERROR: failed to create runtime SA ${runtime_sa}:" >&2
    printf '%s\n' "$create_output" >&2
    return 1
  fi

  local attempts=0
  until gcloud iam service-accounts describe "$runtime_sa" \
      --project="$project" &>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      echo "ERROR: runtime SA ${runtime_sa} did not appear after 10 minutes." >&2
      return 1
    fi
    sleep 5
  done
}

# `gcloud projects add-iam-policy-binding` with the shared retry, plus a cheap
# get-iam-policy pre-check so a re-run on an already-provisioned project does no
# write (no etag race). Call as: add_iam_binding "$PROJECT" --member=... --role=...
add_iam_binding() {
  local role=""
  local member=""
  for arg in "$@"; do
    case "$arg" in
      --role=*) role="${arg#--role=}" ;;
      --member=*) member="${arg#--member=}" ;;
    esac
  done
  local label="${role:+ (for $role)}"
  local project="$1"  # first positional arg

  if [ -n "$role" ] && [ -n "$member" ] && [ -n "$project" ]; then
    if gcloud projects get-iam-policy "$project" \
        --flatten="bindings[].members" \
        --filter="bindings.role=${role} AND bindings.members=${member}" \
        --format="value(bindings.role)" 2>/dev/null | grep -q .; then
      echo "  ✓ ${member} already has ${role} — skipping."
      return 0
    fi
  fi

  _retry_iam_write "$label" gcloud projects add-iam-policy-binding "$@"
}

# Service-scoped run.invoker on a Cloud Run SERVICE, with the same pre-check +
# retry as add_iam_binding. Replaces a raw `gcloud run services
# add-iam-policy-binding` that could abort the deploy on a transient race. (D1)
# Call as: add_run_invoker_binding <service> <region> <project> <member>
add_run_invoker_binding() {
  local service="$1" region="$2" project="$3" member="$4"
  local label=" (for roles/run.invoker on ${service})"

  if gcloud run services get-iam-policy "$service" \
      --region="$region" --project="$project" \
      --flatten="bindings[].members" \
      --filter="bindings.role=roles/run.invoker AND bindings.members=${member}" \
      --format="value(bindings.role)" 2>/dev/null | grep -q .; then
    echo "  ✓ ${member} already has run.invoker on ${service} — skipping."
    return 0
  fi

  _retry_iam_write "$label" \
    gcloud run services add-iam-policy-binding "$service" \
    --region="$region" --project="$project" \
    --member="$member" --role="roles/run.invoker"
}

# A role on a SERVICE-ACCOUNT resource (self-impersonation, Cloud Tasks OIDC),
# with the same pre-check + retry. Replaces a raw `gcloud iam service-accounts
# add-iam-policy-binding` that could abort the deploy on a transient race. (D2)
# Call as: add_sa_iam_binding <sa> <member> <role> <project>
add_sa_iam_binding() {
  local sa="$1" member="$2" role="$3" project="$4"
  local label=" (for ${role} on ${sa})"

  if gcloud iam service-accounts get-iam-policy "$sa" --project="$project" \
      --flatten="bindings[].members" \
      --filter="bindings.role=${role} AND bindings.members=${member}" \
      --format="value(bindings.role)" 2>/dev/null | grep -q .; then
    echo "  ✓ ${member} already has ${role} on ${sa} — skipping."
    return 0
  fi

  _retry_iam_write "$label" \
    gcloud iam service-accounts add-iam-policy-binding "$sa" \
    --member="$member" --role="$role" --project="$project"
}

# Generate ui/definitions/config.json for backend and frontend.
generate_config() {
  envsubst < ui/definitions/config.template.json > ui/definitions/config.json
}

# Pre-flight helper + counter, kept together so the function and its
# state aren't split across the script. All missing tools are reported
# in one pass rather than failing on the first miss.
MISSING_TOOLS=0
require_tool() {
  local name="$1"
  local hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "ERROR: '$name' is not installed. $hint" >&2
    MISSING_TOOLS=$((MISSING_TOOLS + 1))
  fi
}
