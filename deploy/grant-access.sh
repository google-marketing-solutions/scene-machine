#! /bin/bash
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

# ---------------------------------------------------------------------------
# grant-access.sh — admit a user through the Scene Machine IAP front door.
#
# After an IAP-mode deploy, the app is locked behind Identity-Aware Proxy and
# NOBODY can open it — not even the person who ran the deploy — until they hold
# the per-user access role on the 'app' service. deploy.sh creates that role
# (SceneMachineUser) but, by design, grants it to no one; it just prints the
# command to run by hand. This script runs that command for you: it checks
# whether a user already has access and, if not, grants it.
#
# Usage:
#   ./deploy/grant-access.sh <PROJECT_ID> <USER_EMAIL> [options]
#
# Examples:
#   ./deploy/grant-access.sh my-proj alice@example.com        # grant Alice access
#   ./deploy/grant-access.sh my-proj alice@example.com --check-only   # just check
#   ./deploy/grant-access.sh my-proj team@example.com         # an email works as-is
#   ./deploy/grant-access.sh my-proj group:team@example.com   # or a whole group
#
# Options:
#   --region <REGION>   Region the 'app' service was deployed to (default:
#                       us-central1 — only pass this if you changed REGION in
#                       config.txt during deploy).
#   --service <NAME>    Cloud Run service to admit the user to (default: app).
#   --check-only        Report whether the user already has access; grant nothing.
#   -h, --help          Show this help.
#
# Who can run this: you need permission to manage IAP access on the project —
# the "IAP Policy Admin" role (roles/iap.admin), or Owner, or a custom role that
# includes iap.webServices.setIamPolicy. IMPORTANT: this is NOT automatically
# whoever ran the deploy — the deploy never grants IAP access, so a deployer with
# only deploy permissions may not be able to run this. In that case, ask whoever
# administers access/IAP on the project to run it (or to grant you roles/iap.admin
# first).
#
# IAP is the deployed front-door auth (the only mode), so every deploy needs
# this: until a user holds the access role, IAP blocks them from the app. Run it
# once per user (or group) after deploy.
# ---------------------------------------------------------------------------

set -euo pipefail

# --- Defaults ----------------------------------------------------------------
REGION="${REGION:-us-central1}"   # matches config.txt's default REGION
SERVICE="app"                     # the public, IAP-protected Cloud Run service
CHECK_ONLY=0
PROJECT=""
USER_INPUT=""

usage() {
  # Print the header's Usage block (everything between the two markers).
  sed -n '/^# Usage:/,/^# ---/p' "$0" | sed 's/^# \{0,1\}//; /^---/d'
  exit "${1:-0}"
}

# --- Parse arguments ---------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --region)     REGION="${2:?--region needs a value}"; shift 2 ;;
    --service)    SERVICE="${2:?--service needs a value}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help)    usage 0 ;;
    -*)           echo "ERROR: unknown option: $1" >&2; usage 1 ;;
    *)
      if [ -z "$PROJECT" ]; then
        PROJECT="$1"
      elif [ -z "$USER_INPUT" ]; then
        USER_INPUT="$1"
      else
        echo "ERROR: unexpected extra argument: $1" >&2; usage 1
      fi
      shift ;;
  esac
done

if [ -z "$PROJECT" ] || [ -z "$USER_INPUT" ]; then
  echo "ERROR: need both a project id and a user." >&2
  echo "Usage: $0 <PROJECT_ID> <USER_EMAIL> [--region R] [--service S] [--check-only]" >&2
  exit 1
fi

# --- Normalise the member ----------------------------------------------------
# Strip any stray whitespace (e.g. a quoted "alice@example.com " argument, whose
# trailing space would otherwise make the "already has access?" check miss), then
# accept a bare email (treated as a user) or an explicit IAM member such as
# group:..., serviceAccount:..., or domain:...
USER_INPUT="${USER_INPUT//[[:space:]]/}"
case "$USER_INPUT" in
  allUsers|allAuthenticatedUsers)
    echo "ERROR: this helper admits specific people or groups; it won't grant '$USER_INPUT'," >&2
    echo "       which would make the app public and defeat the IAP front door." >&2
    exit 1 ;;
  user:*|group:*|serviceAccount:*|domain:*) MEMBER="$USER_INPUT" ;;
  *@*)                                       MEMBER="user:$USER_INPUT" ;;
  *)
    echo "ERROR: '$USER_INPUT' is not an email or a supported IAM member" \
         "(e.g. alice@example.com or group:team@example.com)." >&2
    exit 1 ;;
esac

# --- Preflight ---------------------------------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: the 'gcloud' command was not found. Install the Google Cloud CLI first." >&2
  exit 1
fi

echo "Project:  ${PROJECT}"
echo "Service:  ${SERVICE} (region ${REGION})"
echo "User:     ${MEMBER}"
echo

# Pick the role to grant. Prefer the project's own least-privilege custom role;
# if it isn't there (e.g. deploy hasn't run, or it was named differently), fall
# back to the equivalent built-in — same permission, same app-only scope.
BUILTIN_ROLE="roles/iap.httpsResourceAccessor"
if gcloud iam roles describe SceneMachineUser --project="$PROJECT" >/dev/null 2>&1; then
  PRIMARY_ROLE="projects/${PROJECT}/roles/SceneMachineUser"
else
  echo "Note: custom role 'SceneMachineUser' not found in ${PROJECT};" \
       "using built-in ${BUILTIN_ROLE} (same access)."
  PRIMARY_ROLE="$BUILTIN_ROLE"
fi

# --- Test: does the user already have access? --------------------------------
# List the IAP roles this member already holds on the service. Either the
# custom role or the built-in accessor role means they're already admitted.
held_roles=$(gcloud iap web get-iam-policy \
  --resource-type=cloud-run --service="$SERVICE" --region="$REGION" --project="$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.members=${MEMBER}" \
  --format="value(bindings.role)" 2>/dev/null || true)

# Fixed-string, whole-line match for either role. Use two -F checks rather than a
# single -E alternation so the literal dots in role ids (e.g.
# roles/iap.httpsResourceAccessor) are matched as dots, not "any char".
if printf '%s\n' "$held_roles" | grep -Fxq "$PRIMARY_ROLE" \
   || printf '%s\n' "$held_roles" | grep -Fxq "$BUILTIN_ROLE"; then
  echo "✓ ${MEMBER} already has access to '${SERVICE}'. Nothing to do."
  exit 0
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "✗ ${MEMBER} does NOT have access to '${SERVICE}' yet."
  echo "  Re-run without --check-only to grant it."
  exit 0
fi

# --- Grant -------------------------------------------------------------------
grant_role() {
  gcloud iap web add-iam-policy-binding \
    --resource-type=cloud-run --service="$SERVICE" --region="$REGION" \
    --member="$MEMBER" --role="$1" --project="$PROJECT" \
    >/dev/null 2>"$ERR_FILE"
}

ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

echo "Granting access (${PRIMARY_ROLE})..."
if grant_role "$PRIMARY_ROLE"; then
  GRANTED_ROLE="$PRIMARY_ROLE"
elif grep -qE 'PERMISSION_DENIED|[Pp]ermission denied|[Pp]ermission .*denied|HTTPError 403|Error 403|does not have permission' "$ERR_FILE"; then
  # A permissions problem is about WHO is running this, not which role — retrying
  # with a different role won't help, so stop and explain. (gcloud phrases 403s
  # several ways across versions, hence the broad match.)
  cat "$ERR_FILE" >&2
  echo >&2
  echo "ERROR: you don't have permission to set IAP access on ${PROJECT}." >&2
  echo "       You need IAP Policy Admin (roles/iap.admin) or Owner on the project." >&2
  echo "       The deploy does not grant this, so whoever ran it may not have it —" >&2
  echo "       ask the person who administers IAP/access on ${PROJECT} to run this" >&2
  echo "       (or to grant you roles/iap.admin), then re-run." >&2
  exit 1
elif [ "$PRIMARY_ROLE" != "$BUILTIN_ROLE" ]; then
  # Some gcloud versions reject a custom role on this command. The built-in
  # accessor role grants the identical access, so fall back to it.
  echo "Custom role was rejected; retrying with built-in ${BUILTIN_ROLE}..." >&2
  if grant_role "$BUILTIN_ROLE"; then
    GRANTED_ROLE="$BUILTIN_ROLE"
  else
    cat "$ERR_FILE" >&2
    exit 1
  fi
else
  cat "$ERR_FILE" >&2
  exit 1
fi

echo "✓ Granted ${MEMBER} access to '${SERVICE}' via ${GRANTED_ROLE}."
echo "  They can now open the app and sign in. New IAP grants can take a minute"
echo "  or two to take effect."
