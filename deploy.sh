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
# deploy.sh — single-image, two-service ("app" + "worker") Scene Machine
# deployment.
#
# Usage:
#   ./deploy.sh [--non-interactive]
#
#   Configuration comes from ./config.txt. The app service is always IAP-gated
#   (deployed --no-allow-unauthenticated --iap), so there is no auth-mode
#   choice to make.
#   --non-interactive is for headless/agent runs: it auto-confirms the
#   deployment-target prompt and makes any step that needs a human in the
#   console FAIL FAST (printing what to do and to
#   re-run) instead of waiting. It does NOT short-circuit the automatic
#   GCP-provisioning waits (default-SA / bucket-link), which resolve on their
#   own. The IAP arm's post-deploy console steps are printed in the final
#   summary either way; an agent runs the provisioning, a human finishes those.
#
# Topology deployed:
#   worker  private Cloud Run service (Cloud-Tasks-invoked): ROLE=worker,
#           cpu=8 / 16G / timeout 1800, runtime SA only invoker.
#   app     Cloud Run service serving the SPA + same-origin /api control
#           plane: ROLE=app, AUTH_MODE, WORKER_URL (Cloud Tasks callback
#           override), cpu=2 / 2Gi / timeout 300.
#   Both services run the SAME image, built once with `gcloud builds submit`.
#
# STATE-SAFETY GUARANTEES (hard requirements for this script):
#   * never calls `gcloud config set` (no gcloud config mutation);
#   * REST calls authenticate with an Application Default Credentials (ADC)
#     token (`gcloud auth application-default print-access-token`). This is
#     deliberate: under corporate Certificate-Based Access (CBA) the plain
#     `gcloud auth print-access-token` token is bound to the gcloud CLI client
#     and is rejected by these REST endpoints with HTTP 401. The ADC token is
#     read-only here — we only mint it for the Authorization header and never
#     write/mutate ADC state (`gcloud auth application-default login` is never
#     run);
#   * passes --project=$PROJECT on every gcloud call and
#     `x-goog-user-project: $PROJECT` on every curl, so it is runnable under
#     CLOUDSDK_ACTIVE_CONFIG_NAME=<any config> with zero writes to the
#     user's global gcloud/ADC state.
#
# Idempotency: every resource is describe-before-create (or create||update),
# so re-runs are safe.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Console output convention
# ---------------------------------------------------------------------------
# Lines beginning with "[>]" mark the start of a major deployment phase.
# Lines beginning with "[t]" close a phase: the "[t]" line names the phase that
# just finished, and the indented line below it reports the time of day, how
# long that phase took, and the total elapsed since the deploy started (h/m/s)
# — this script's runtime is itself a measured deliverable, so every phase is
# timed and totals are printed at the end.
# If something fails, copy the "[>]" prefix (or the full prefix + echo
# message) from the terminal and Ctrl+F in this file to jump straight to the
# matching section in the script.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
# Shared, reusable helpers — the IAM-binding retry wrapper, config-file
# generation, and the tool pre-flight check — live in deploy/libs.sh so they
# can be reused without copy-paste. Source them before anything below calls
# add_iam_binding / generate_config / require_tool.
source "$(dirname "$0")/deploy/libs.sh"

# --- Phase timing ------------------------------------------------------------
# phase "message": closes the previous phase and opens a new "[>]" banner.
# close_phase: closes the current phase without opening a new one (used right
# before totals / manual gates). Each closing "[t]" line names the phase, with
# the time of day, how long that phase took, and the total elapsed since the
# deploy started (formatted h/m/s) on the indented line below it.
CURRENT_PHASE=""
CURRENT_PHASE_START=0

# Formats a count of seconds as "..h..m..s" (e.g. 754 -> "0h 12m 34s").
fmt_hms() {
  local total=$1
  printf '%dh %02dm %02ds' $((total / 3600)) $(((total % 3600) / 60)) $((total % 60))
}

# Runs a long, quiet command while printing a heartbeat line every HEARTBEAT_SECS
# seconds, so the deploy never looks frozen. `gcloud builds submit` goes silent
# under CLOUD_LOGGING_ONLY (it can't stream the GCS log), so without this the
# terminal shows nothing for minutes during the image build. Returns the wrapped
# command's own exit code, so `set -e` still aborts the deploy if the build fails.
run_with_heartbeat() {
  local label=$1; shift
  local hb_secs=${HEARTBEAT_SECS:-20}
  local start rc=0
  start=$(date +%s)
  "$@" &
  local cmd_pid=$!
  # Heartbeat in a background subshell: it watches the command's PID and exits
  # when the command does. cmd_pid/start are inherited from this function scope.
  (
    while kill -0 "$cmd_pid" 2>/dev/null; do
      sleep "$hb_secs"
      kill -0 "$cmd_pid" 2>/dev/null || break
      echo "    … ${label} still running ($(fmt_hms $(( $(date +%s) - start ))) elapsed)"
    done
  ) &
  local hb_pid=$!
  wait "$cmd_pid" || rc=$?
  kill "$hb_pid" 2>/dev/null || true
  wait "$hb_pid" 2>/dev/null || true
  return $rc
}

# Emits the closing timing line for the current phase: wall-clock time of day,
# this phase's duration, and the running total since SCRIPT_START (h/m/s).
_emit_phase_time() {
  local now total
  now=$(date +%s)
  total=$((now - ${SCRIPT_START:-$now}))
  # Lead with the phase name so the reader sees WHAT just finished before the
  # numbers; the timing sits on the indented line below it. "[t]" stays the
  # flush-left grep anchor (like "[>]"). Blank lines float the block clear of
  # the phase output above and the next "[>]" banner below.
  echo
  echo "[t] ${CURRENT_PHASE}"
  echo "       $(date +%H:%M:%S)  ·  +$((now - CURRENT_PHASE_START))s this phase  ·  $(fmt_hms "$total") total"
  echo
}

phase() {
  [ -n "$CURRENT_PHASE" ] && _emit_phase_time
  CURRENT_PHASE="$1"
  CURRENT_PHASE_START=$(date +%s)
  echo "[>] $1"
}
close_phase() {
  if [ -n "$CURRENT_PHASE" ]; then
    _emit_phase_time
    CURRENT_PHASE=""
  fi
}

usage() {
  echo "Usage: $0 [--non-interactive]"
  echo "  --non-interactive  headless/agent run: auto-confirms the deploy-target"
  echo "                     prompt, and fails fast"
  echo "                     (instead of waiting) on any step needing a human in"
  echo "                     the console — printing what to do and to re-run."
  echo
  echo "  Faster-deploy flags (opt-in; a plain run does the full, safe deploy):"
  echo "  --app-only         build the image and deploy only the 'app' service,"
  echo "                     reusing the already-deployed worker. Errors if no"
  echo "                     worker exists yet."
  echo "  --skip-ui-build,   reuse the existing ui/dist instead of running npm ci +"
  echo "  --use-existing-ui-dist   ng build. Errors if ui/dist is missing or was"
  echo "                     built for local dev (sign-in disabled)."
  echo "  --no-build-cache   force a clean cold image build (ignore the Docker"
  echo "                     layer cache); use for a release or dependency refresh."
}

# ---------------------------------------------------------------------------
# Main script
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Argument parsing --------------------------------------------------------
# The app service is always IAP-gated, so there is no auth-mode to choose. This
# fixed value only labels the banners below and gates the IAP post-deploy steps;
# the deployed Cloud Run services get AUTH_MODE=iap set explicitly where they
# are created.
AUTH_MODE="iap"
NONINTERACTIVE=0
# Faster-deploy flags. All default OFF: a plain `./deploy.sh` is the full,
# safe, end-to-end deploy. Each flag only shortcuts work that is safe to skip
# when the project is already provisioned, and each logs what it skipped.
APP_ONLY=0
SKIP_UI_BUILD=0
NO_BUILD_CACHE=0
for arg in "$@"; do
  case "$arg" in
    # Headless/agent runs: auto-confirm the target prompt AND fail fast on the
    # human-in-the-console gates instead of waiting (see the header comment).
    --non-interactive) NONINTERACTIVE=1 ;;
    --app-only) APP_ONLY=1 ;;
    --skip-ui-build|--use-existing-ui-dist) SKIP_UI_BUILD=1 ;;
    --no-build-cache) NO_BUILD_CACHE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; usage >&2; exit 1 ;;
  esac
done

echo
echo "================================================================================"
echo "  Scene Machine FRONT-DOOR deploy (AUTH_MODE=${AUTH_MODE}) — pre-flight checks..."
echo "================================================================================"
# --- Pre-flight: required tools and gcloud auth -----------------------------
# Fail fast if a required command is missing or gcloud isn't authenticated,
# rather than 30+ seconds into a gcloud call with a confusing error.
echo "[>] Checking required tools..."
require_tool gcloud   "Install: https://cloud.google.com/sdk/docs/install"
require_tool node     "Install Node.js ≥ v22: https://nodejs.org/en/download"
require_tool npm      "Install Node.js (includes npm): https://nodejs.org/en/download"
require_tool envsubst "Install gettext (macOS: 'brew install gettext'; Debian/Ubuntu: 'apt-get install gettext')"
require_tool curl     "Install curl (it ships with macOS and most Linux distributions)"
if [ $MISSING_TOOLS -gt 0 ]; then
  echo "Please install the missing tools above, then re-run $0."
  exit 1
fi
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "ERROR: gcloud has no active authenticated account." >&2
  echo "Run: gcloud auth login" >&2
  exit 1
fi
echo "✓ All required tools found (gcloud, node, npm, envsubst, curl)."
echo "✓ gcloud authenticated as: $ACTIVE_ACCOUNT"

# Application Default Credentials (ADC) are a SEPARATE login from `gcloud auth
# login` above. The REST calls later in the deploy (Firestore
# seeding, GCS bucket CORS) authenticate with an ADC token,
# so verify it now — otherwise the deploy would do much of its provisioning and
# then abort at the first REST call on a machine that has the CLI login but not
# ADC. (The original deploy's auth instructions named both logins.)
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "ERROR: Application Default Credentials (ADC) are not set up." >&2
  echo "Run: gcloud auth application-default login" >&2
  echo "(This is separate from 'gcloud auth login'; the deploy's REST calls need it.)" >&2
  exit 1
fi
echo "✓ Application Default Credentials present."

# --- Check config.txt -------------------------------------------------------
echo
echo "[>] Checking config.txt..."
REQUIRED_VARS=(
  "ARTIFACT_REPO"
  "BACKEND_SERVICE_NAME"
  "FIRESTORE_DB"
  "FIRESTORE_DB_UI"
  "GCS_BUCKET"
  "GEMINI_MODEL"
  "GEMINI_REGION"
  "PROJECT"
  "REGION"
  "TASKS_QUEUE_PREFIX"
  "VEO_MODEL"
  "VEO_REGION"
  "IMAGE_MODEL"
  "IMAGE_MODEL_REGION"
)
MISSING=0
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -qE "^(export )?${var}=[A-Za-z0-9._\$-]+" ./config.txt; then
    echo "ERROR: $var is missing, empty, or has invalid characters in config.txt" >&2
    MISSING=$((MISSING + 1))
  fi
done
if [ $MISSING -gt 0 ]; then
  echo "Validation failed. Please fix config.txt and try again." >&2
  exit 1
fi
source ./config.txt
# Single image name for both Cloud Run services (overridable via env).
IMAGE_NAME="${IMAGE_NAME:-scene-machine}"
# App service minimum instances: 0 (default) scales to zero; 1 keeps one
# instance warm to avoid cold starts. Validate it's an integer (mirrors the
# config-validation style above) since it goes straight into a gcloud flag.
APP_MIN_INSTANCES="${APP_MIN_INSTANCES:-0}"
if ! [[ "$APP_MIN_INSTANCES" =~ ^[0-9]+$ ]]; then
  echo "ERROR: APP_MIN_INSTANCES must be a non-negative integer (got '$APP_MIN_INSTANCES')." >&2
  echo "Validation failed. Please fix config.txt and try again." >&2
  exit 1
fi
# Data plane: the backend brokers all project data and media through the app
# service's /api endpoints (signed URLs). The browser holds no Firestore or
# Storage credentials and ships no client SDK, so there is no client data-plane
# surface at all. This is always the case — there is no data-plane mode to
# choose.
echo "✓ config.txt is valid. Target project: $PROJECT"

# --- Confirm deployment target ----------------------------------------------
# Final pre-flight gate. Shows gcloud's current state alongside config.txt's
# intended target. This script NEVER changes gcloud's
# active project — the display is informational only; every subsequent call
# carries an explicit --project=$PROJECT.
CURRENT_GCLOUD_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
[ -z "$CURRENT_GCLOUD_PROJECT" ] && CURRENT_GCLOUD_PROJECT="(none set)"
echo
echo "[>] Confirming deployment target..."
echo "════════════════════════════════════════════════════════════════════════"
echo "  DEPLOYMENT TARGET — please confirm"
echo "════════════════════════════════════════════════════════════════════════"
echo "  gcloud is currently configured for (informational — NOT modified):"
echo "    Account:    $ACTIVE_ACCOUNT"
echo "    Project:    $CURRENT_GCLOUD_PROJECT"
echo
echo "  config.txt says deploy to:"
echo "    Project:    $PROJECT"
echo "    Region:     $REGION"
echo "    Auth mode:  $AUTH_MODE"
echo "════════════════════════════════════════════════════════════════════════"
if [ "$NONINTERACTIVE" = "1" ]; then
  echo "✓ Auto-confirming the deployment target (--non-interactive)."
else
  if [ ! -t 0 ]; then
    echo "ERROR: stdin is not a TTY — cannot confirm. Re-run interactively or pass --non-interactive." >&2
    exit 1
  fi
  read -r -p "Proceed and deploy to '$PROJECT'? (y/N) " confirm
  confirm=$(echo "$confirm" | tr '[:upper:]' '[:lower:]')
  if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
    echo "Aborted. Update PROJECT in config.txt to match your intended target." >&2
    exit 1
  fi
fi
echo "✓ Continuing with project $PROJECT."

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  Starting Scene Machine front-door deployment (AUTH_MODE=${AUTH_MODE})..."
echo "════════════════════════════════════════════════════════════════════════"

# The wall-clock measurement starts AFTER the interactive confirmation, so
# human think-time at the prompt doesn't pollute the timing deliverable.
SCRIPT_START=$(date +%s)

# --- Enable services ---------------------------------------------------------
# Note: compute.googleapis.com is enabled here so the default Compute Engine
# service account (used for role bindings below) is guaranteed to exist.
# firestore.googleapis.com is the Cloud Firestore API the backend uses;
# iap.googleapis.com gates the front door.
phase "Enabling required Google Cloud APIs..."
REQUIRED_APIS="aiplatform.googleapis.com artifactregistry.googleapis.com \
cloudbuild.googleapis.com cloudtasks.googleapis.com compute.googleapis.com \
firestore.googleapis.com run.googleapis.com \
iap.googleapis.com"

# Only enable the APIs that aren't on yet, so a re-run on an already-provisioned
# project skips the slow `services enable` round-trips. If the enabled-list read
# fails for any reason, ENABLED_APIS is empty and every required API falls into
# TO_ENABLE, i.e. we enable all of them (the original behavior). We never want to
# under-enable, so an unreadable list errs toward enabling everything.
ENABLED_APIS=$(gcloud services list --enabled --project=$PROJECT \
  --format="value(config.name)" 2>/dev/null || true)
TO_ENABLE=""
total=0
already=0
for api in $REQUIRED_APIS; do
  total=$((total + 1))
  if printf '%s\n' "$ENABLED_APIS" | grep -Fxq "$api"; then
    already=$((already + 1))
  else
    TO_ENABLE="$TO_ENABLE $api"
  fi
done
echo "  ${already} of ${total} required APIs already enabled."
if [ -n "${TO_ENABLE// /}" ]; then
  # List each API being enabled so the run can be followed in the console.
  count=0
  for api in $TO_ENABLE; do
    echo "  - enabling ${api}"
    count=$((count + 1))
  done
  gcloud services enable $TO_ENABLE --project=$PROJECT > /dev/null
  echo "  ✓ Enabled ${count} API(s)."
else
  echo "  ✓ All required APIs already enabled, nothing to do."
fi

# Warm up Vertex AI service agent. On a fresh project, the agent
# (service-<PROJECT_NUMBER>@gcp-sa-aiplatform.iam.gserviceaccount.com) is
# created lazily on first API use, and its auto-granted Storage Object access
# needs time to propagate. Without this, the user's first Veo generation
# fails with "Service agents are being provisioned." Triggering identity
# creation now starts the propagation window during the rest of the deploy.
#
# `services identity create` is still on the `beta` surface today; try the GA
# path first so we survive its eventual promotion (the beta command will be
# removed at some point and would silently fail on a future toolchain).
phase "Provisioning service agents (Vertex AI + IAP)..."
gcloud services identity create --service=aiplatform.googleapis.com --project=$PROJECT 2>/dev/null \
  || gcloud beta services identity create --service=aiplatform.googleapis.com --project=$PROJECT
# The IAP service agent (service-<PROJECT_NUMBER>@gcp-sa-iap.iam.
# gserviceaccount.com) must exist so we can grant it run.invoker on the app
# service after deploy (Cloud Run built-in IAP requirement).
gcloud services identity create --service=iap.googleapis.com --project=$PROJECT 2>/dev/null \
  || gcloud beta services identity create --service=iap.googleapis.com --project=$PROJECT

# --- Derived values ----------------------------------------------------------
phase "Resolving project number and runtime service account..."
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format="value(projectNumber)")
# Two distinct identities (least privilege, P2#1):
#   BUILD_SA   - the default Compute Engine SA, which is also the default Cloud
#                Build identity. Used ONLY to build and push the container image
#                (`gcloud builds submit`, no --service-account). It holds the
#                build-time roles (artifactregistry.writer, logging.logWriter,
#                storage.objectUser for the source) and is NOT a request-serving
#                identity.
#   RUNTIME_SA - a dedicated SA that the app + worker Cloud Run services run as.
#                It carries only the roles the running app needs. Crucially it
#                does NOT get roles/artifactregistry.writer, so a compromise of
#                the public-facing app cannot push or overwrite container images.
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
RUNTIME_SA="sm-runtime@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${ARTIFACT_REPO}/${IMAGE_NAME}:latest"
# The IAP audience is the app service's RESOURCE path (project number + region +
# service name) — deterministic and known before the service exists. We do NOT
# predict the Cloud Run URL/host: it's only assigned at deploy time, its form
# isn't predictable, and nothing needs it at build time (the front door is
# same-origin). The real host is read from status.url after the app deploy for
# the one thing that genuinely needs it: the GCS bucket CORS list. The deploy
# does NOT touch the authorized-domains list (IAP gates the app, so that list
# is irrelevant).
IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/app"
echo "  Project number: ${PROJECT_NUMBER}"
echo "  Build SA:       ${BUILD_SA}"
echo "  Runtime SA:     ${RUNTIME_SA}"
echo "  Image:          ${IMAGE}"

# The default Compute Engine SA (BUILD_SA) is created when compute.googleapis.com
# is enabled (above), but its propagation isn't instant on fresh projects. Wait
# for it to exist before attempting role bindings below, rather than failing
# inside the loop with a confusing "service account not found" error.
phase "Waiting for default Compute Engine service account to exist..."
SA_WAIT_ATTEMPTS=0
SA_WAIT_MAX=120   # 120 × 5s = 10 min total
until gcloud iam service-accounts describe "${BUILD_SA}" --project=$PROJECT &> /dev/null; do
  SA_WAIT_ATTEMPTS=$((SA_WAIT_ATTEMPTS + 1))
  if [ $SA_WAIT_ATTEMPTS -ge $SA_WAIT_MAX ]; then
    echo "ERROR: default Compute Engine SA did not appear after 10 minutes." >&2
    echo "Try enabling Compute Engine API manually, then re-run $0:" >&2
    echo "  gcloud services enable compute.googleapis.com --project=$PROJECT" >&2
    exit 1
  fi
  sleep 5
done
echo "✓ Service account ${BUILD_SA} ready."

# The dedicated runtime SA is NOT auto-created with the project, so create it on
# demand (idempotent: skip if it already exists), then wait for propagation the
# same way before granting it roles below.
phase "Ensuring runtime service account ${RUNTIME_SA} exists..."
gcloud iam service-accounts describe "${RUNTIME_SA}" --project=$PROJECT &> /dev/null \
  || gcloud iam service-accounts create sm-runtime --project=$PROJECT \
       --display-name="Scene Machine runtime (app + worker)"
RUNTIME_SA_WAIT_ATTEMPTS=0
until gcloud iam service-accounts describe "${RUNTIME_SA}" --project=$PROJECT &> /dev/null; do
  RUNTIME_SA_WAIT_ATTEMPTS=$((RUNTIME_SA_WAIT_ATTEMPTS + 1))
  if [ $RUNTIME_SA_WAIT_ATTEMPTS -ge $SA_WAIT_MAX ]; then
    echo "ERROR: runtime SA ${RUNTIME_SA} did not appear after 10 minutes." >&2
    exit 1
  fi
  sleep 5
done
echo "✓ Service account ${RUNTIME_SA} ready."

# --- IAM: runtime SA roles + service agents ----------------------------------
# Least privilege: only project-wide roles the runtime genuinely needs at
# project scope are listed here. The SA's self-impersonation rights
# (serviceAccountTokenCreator for signing GCS URLs, serviceAccountUser for
# setting itself as the Cloud Tasks OIDC SA) are granted on the SA's OWN
# resource below, NOT project-wide, so a compromised app can only act as
# itself. run.invoker is granted service-scoped on the worker only (later),
# not project-wide. roles/artifactregistry.writer is a BUILD-time role and is
# deliberately NOT here: it is granted to BUILD_SA instead (below), so the
# request-serving identity cannot push or overwrite container images (P2#1).
ROLES=(
  "roles/datastore.user"
  "roles/aiplatform.user"
  "roles/cloudtasks.enqueuer"
  "roles/storage.objectUser"
  "roles/logging.logWriter"
)
phase "Granting ${#ROLES[@]} roles to ${RUNTIME_SA}..."
for ROLE in "${ROLES[@]}"; do
  echo "  - $ROLE"
  add_iam_binding $PROJECT --member="serviceAccount:${RUNTIME_SA}" --role="$ROLE" --condition=None
done
echo "✓ Roles granted."

# Explicitly grant the Vertex AI service agent storage access. The agent is
# auto-granted this on first use but propagation lags; binding it
# now eliminates the first-Veo-generation "Service agents are being
# provisioned" failure.
AIPLATFORM_SA="service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com"
echo
echo "Granting roles/storage.objectUser to Vertex AI service agent..."
add_iam_binding $PROJECT --member="serviceAccount:${AIPLATFORM_SA}" --role="roles/storage.objectUser" --condition=None

# Build-time roles, granted ONLY to BUILD_SA (the Compute Engine default SA that
# `gcloud builds submit` runs as), never to the runtime SA:
#   - logging.logWriter:        the build's CLOUD_LOGGING_ONLY mode
#                               (cloudbuild.yaml) writes build logs to Cloud
#                               Logging.
#   - artifactregistry.writer:  the build pushes the image to Artifact Registry.
#   - storage.objectUser:       `gcloud builds submit` stages the source tarball
#                               in the build bucket, which the build reads.
# Granted HERE, early — the bindings then have minutes to propagate before the
# build runs (after the UI build); granting them right before the build risks
# the build starting first.
echo
echo "Granting build-time roles to the Cloud Build service account..."
for BUILD_ROLE in "roles/logging.logWriter" "roles/artifactregistry.writer" "roles/storage.objectUser"; do
  echo "  - $BUILD_ROLE"
  add_iam_binding $PROJECT --member="serviceAccount:${BUILD_SA}" --role="$BUILD_ROLE" --condition=None
done

# Cloud Tasks service agent: project-level serviceAgent role, plus the
# SA-resource-level tokenCreator binding that lets the Tasks agent mint OIDC
# tokens AS the runtime SA (required for the private worker invocations).
CLOUD_TASKS_ACCOUNT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
echo
echo "Granting Cloud Tasks service agent permissions..."
add_iam_binding "${PROJECT}" --member="serviceAccount:${CLOUD_TASKS_ACCOUNT}" --role="roles/cloudtasks.serviceAgent" --condition=None
add_sa_iam_binding "${RUNTIME_SA}" "serviceAccount:${CLOUD_TASKS_ACCOUNT}" "roles/iam.serviceAccountTokenCreator" "$PROJECT"

# Runtime SA self-impersonation, scoped to its OWN resource (not project-wide):
#   - serviceAccountTokenCreator (self): lets the app sign GCS URLs as itself
#     (the IAM signBlob path, no exported key).
#   - serviceAccountUser (self): lets the app set itself as the OIDC service
#     account on the Cloud Tasks it creates for the worker.
# Scoping to the SA means a compromised app can only act as itself, never mint
# tokens for or impersonate other service accounts in the project.
echo
echo "Granting the runtime SA self-impersonation (signBlob + Cloud Tasks OIDC)..."
add_sa_iam_binding "${RUNTIME_SA}" "serviceAccount:${RUNTIME_SA}" "roles/iam.serviceAccountTokenCreator" "$PROJECT"
add_sa_iam_binding "${RUNTIME_SA}" "serviceAccount:${RUNTIME_SA}" "roles/iam.serviceAccountUser" "$PROJECT"

# --- Cloud Tasks queues -------------------------------------------------------
phase "Setting up Cloud Tasks queues..."
QUEUES=("Other" "Gemini" "Veo")
for QUEUE_SUFFIX in "${QUEUES[@]}"; do
  QUEUE_NAME="${TASKS_QUEUE_PREFIX}${QUEUE_SUFFIX}"
  if [[ "$QUEUE_SUFFIX" == "Veo" ]]; then
    PER_SECOND=1
    CONCURRENT=10
    BACKOFF="5s"
  elif [[ "$QUEUE_SUFFIX" == "Gemini" ]]; then
    PER_SECOND=20
    CONCURRENT=500
    BACKOFF="5s"
  else
    PER_SECOND=500
    CONCURRENT=3000
    BACKOFF="2s"
  fi
  if ! gcloud tasks queues describe "$QUEUE_NAME" --location="${REGION}" --project="${PROJECT}" &> /dev/null; then
    echo "Creating Cloud Tasks queue: $QUEUE_NAME"
    COMMAND="create"
  else
    echo "Updating existing Cloud Tasks queue: $QUEUE_NAME"
    COMMAND="update"
  fi
  gcloud tasks queues "$COMMAND" "$QUEUE_NAME" \
    --location="${REGION}" \
    --max-attempts=30 \
    --max-concurrent-dispatches="$CONCURRENT" \
    --max-dispatches-per-second="$PER_SECOND" \
    --min-backoff="$BACKOFF" \
    --max-backoff=300s \
    --max-doublings=3 \
    --project="$PROJECT"
done
echo "  ✓ ${#QUEUES[@]} Cloud Tasks queues ready (${QUEUES[*]/#/${TASKS_QUEUE_PREFIX}})."

# --- GCS bucket ---------------------------------------------------------------
# Scene Machine signs GET URLs for ANY object in $GCS_BUCKET (see
# sign_url_handler in orch.py), so the bucket must be dedicated to this app. The
# deploy creates it and labels it app=scene-machine. On a later run: a labeled
# bucket is reused; an UNLABELED bucket with the default ${PROJECT}-scene-machine
# name (an upgrade of an existing deployment — that name is app- and project-
# specific, so it is ours) is adopted in place by adding the label, no data
# moved; any OTHER pre-existing or custom-named bucket is refused unless the
# deployer sets ADOPT_EXISTING_BUCKET=1 — so a shared bucket cannot have its
# contents exposed through signed URLs. (Needs roles/storage.admin, already
# required.)
phase "Setting up GCS bucket..."
DEFAULT_BUCKET="${PROJECT}-scene-machine"
if ! gcloud storage buckets describe "gs://$GCS_BUCKET" --project=$PROJECT &> /dev/null; then
    echo "Creating dedicated GCS bucket gs://$GCS_BUCKET in ${REGION}..."
    gcloud storage buckets create "gs://$GCS_BUCKET" --project=$PROJECT --location="$REGION" --labels=app=scene-machine
    echo "  ✓ Bucket gs://$GCS_BUCKET created (labeled app=scene-machine)."
else
    EXISTING_APP_LABEL=$(gcloud storage buckets describe "gs://$GCS_BUCKET" --project=$PROJECT --format="value(labels.app)" 2>/dev/null || true)
    if [ "$EXISTING_APP_LABEL" = "scene-machine" ]; then
        BUCKET_LOCATION=$(gcloud storage buckets describe "gs://$GCS_BUCKET" --project=$PROJECT --format="value(location)")
        echo "  ✓ Reusing Scene Machine bucket gs://$GCS_BUCKET (location: $BUCKET_LOCATION)."
    elif [ "$GCS_BUCKET" = "$DEFAULT_BUCKET" ]; then
        # The canonical, project-scoped Scene Machine bucket name. An unlabeled
        # bucket with this exact name predates label-based ownership (i.e. an
        # upgrade of an existing deployment); it is Scene Machine's own, so adopt
        # it in place — add the label and reuse it, no flag and no data movement.
        echo "Adopting the existing Scene Machine bucket gs://$GCS_BUCKET (adding the app=scene-machine label)..."
        gcloud storage buckets update "gs://$GCS_BUCKET" --project=$PROJECT --update-labels=app=scene-machine
        echo "  ✓ Adopted gs://$GCS_BUCKET (labeled app=scene-machine)."
    else
        echo "WARNING: gs://$GCS_BUCKET already exists, is not labeled app=scene-machine, and is" >&2
        echo "not the default ${DEFAULT_BUCKET} name. Scene Machine issues signed download URLs" >&2
        echo "for EVERY object in this bucket, so it must be dedicated to Scene Machine and not" >&2
        echo "shared with other data." >&2
        if [ "${ADOPT_EXISTING_BUCKET:-0}" = "1" ]; then
            echo "ADOPT_EXISTING_BUCKET=1 set: adopting it and adding the app=scene-machine label." >&2
            gcloud storage buckets update "gs://$GCS_BUCKET" --project=$PROJECT --update-labels=app=scene-machine
            echo "  ✓ Adopted gs://$GCS_BUCKET (labeled app=scene-machine)."
        else
            echo "Refusing to use it. Either set GCS_BUCKET in config.txt to a new, unused name" >&2
            echo "(the deploy will create it), or re-run with ADOPT_EXISTING_BUCKET=1 ONLY if you" >&2
            echo "are certain this bucket is dedicated to Scene Machine." >&2
            exit 1
        fi
    fi
fi

# --- Firestore databases (two) -------------------------------------------------
phase "Setting up Firestore databases..."
if ! gcloud firestore databases describe --database="$FIRESTORE_DB" --project=$PROJECT &> /dev/null; then
    echo "Creating Firestore database: $FIRESTORE_DB"
    gcloud firestore databases create --database="$FIRESTORE_DB" --project=$PROJECT --location="$REGION"
else
    echo "Firestore database $FIRESTORE_DB already exists in the following location:"
    gcloud firestore databases describe --database="$FIRESTORE_DB" --project=$PROJECT --format="value(locationId)"
fi

echo
echo "[>] Configuring TTL on cloudTasks collection..."
if gcloud firestore fields ttls list --collection-group=cloudTasks --database="$FIRESTORE_DB" --project=$PROJECT 2>/dev/null | grep -q "expiresAt"; then
    echo "✓ TTL is already enabled on cloudTasks collection."
else
    echo "Enabling TTL on cloudTasks collection..."
    gcloud firestore fields ttls update expiresAt --collection-group=cloudTasks --enable-ttl --database="$FIRESTORE_DB" --project=$PROJECT --async || echo "  ⚠ Could not enable TTL (it might already be enabled or provisioning)."
fi
if ! gcloud firestore databases describe --database="$FIRESTORE_DB_UI" --project=$PROJECT &> /dev/null; then
    echo "Creating Firestore database: $FIRESTORE_DB_UI"
    gcloud firestore databases create --database="$FIRESTORE_DB_UI" --project=$PROJECT --location="$REGION"
else
    echo "Firestore database $FIRESTORE_DB_UI already exists in the following location:"
    gcloud firestore databases describe --database="$FIRESTORE_DB_UI" --project=$PROJECT --format="value(locationId)"
fi

# --- Render UI env + config (must precede the single image build) -------------
# Order matters: these artifacts are baked into the image (Dockerfile
# `COPY . .`), so they must exist before `gcloud builds submit`.
phase "Rendering ui/src/env.ts and ui/definitions/config.json..."
# IAP is the only deployable front-door mode (controlPlaneMode 'none' is local
# dev only), and the data plane is always mediated, so there is nothing to
# choose here — the UI is always built for IAP.
export UI_CONTROL_PLANE_MODE="iap"
echo "  Front-door auth: IAP (the only deployable mode)"
# env.ts: UI_CONTROL_PLANE_MODE
# is additionally exported for the front-door env.template.txt field
# (controlPlaneMode) — a no-op against templates that don't reference it.
envsubst < ./ui/src/env.template.txt > ./ui/src/env.ts
# config.json: read by the backend (orch.py) for the project/bucket/database
# params and rendered into the deploy. The app serves the SPA, /api and the
# status viewer from one Cloud Run service, so the browser always calls /api
# RELATIVE to wherever the page loaded; no app host is baked in. Only
# $FIRESTORE_DB / $GCS_BUCKET / $PROJECT / $REGION / $TASKS_QUEUE_PREFIX are
# substituted.
generate_config

# Safety: never build or ship a UI rendered for LOCAL DEV (controlPlaneMode
# 'none' turns the sign-in gate off). The line above always sets 'iap', so this
# only trips on a stray UI_CONTROL_PLANE_MODE override; fail loudly rather than
# deploy an app with authentication disabled.
if grep -q "controlPlaneMode: 'none'" ./ui/src/env.ts; then
  echo "ERROR: ui/src/env.ts rendered with controlPlaneMode 'none' (sign-in disabled)." >&2
  echo "       Refusing to build a deploy with the front-door auth gate off." >&2
  echo "       This should not happen on a normal deploy; check for a stray" >&2
  echo "       UI_CONTROL_PLANE_MODE in your environment, then re-run $0." >&2
  exit 1
fi

# --- UI build ------------------------------------------------------------------
if [ "$SKIP_UI_BUILD" = "1" ]; then
  if [ ! -d ui/dist ]; then
    echo "ERROR: --skip-ui-build given but ui/dist does not exist." >&2
    echo "       Run a normal deploy once (or 'cd ui && npx ng build') first." >&2
    exit 1
  fi
  # The render above rewrote env.ts/config.json, but a skipped build leaves the
  # OLD env baked into ui/dist. Refuse if that prior build was a local-dev,
  # sign-in-disabled build, so --skip-ui-build can never ship one to production.
  if grep -rqs 'controlPlaneMode:"none"' ui/dist || grep -rqs "controlPlaneMode:'none'" ui/dist; then
    echo "ERROR: the existing ui/dist was built for local dev (controlPlaneMode 'none'," >&2
    echo "       sign-in disabled). Refusing to deploy it. Drop --skip-ui-build and run a" >&2
    echo "       normal deploy to rebuild the UI first." >&2
    exit 1
  fi
  phase "Reusing existing ui/dist (--skip-ui-build)..."
  echo "[skip] Building the Angular UI — skipped (--skip-ui-build); reusing ui/dist."
else
  phase "Building the Angular UI (npm ci + ng build)..."
  export NG_CLI_ANALYTICS=ci
  (
    cd ui \
      && npm ci --legacy-peer-deps \
      && npx ng build --configuration production
  )
fi

# --- Version stamp + Artifact Registry + ONE image build -----------------------
phase "Building the single container image (Cloud Build)..."
# Version stamp (with a fallback so a missing/
# detached git checkout doesn't abort the whole deploy under set -e).
COMMIT_DATE=$(git log -1 --format=%cI 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "${GIT_BRANCH}/${COMMIT_DATE}" > deployed_version.txt
sync
if ! gcloud artifacts repositories describe "${ARTIFACT_REPO}" --project=$PROJECT --location="$REGION" &> /dev/null; then
  echo "Creating artifact repository: $ARTIFACT_REPO"
  gcloud artifacts repositories create "${ARTIFACT_REPO}" --repository-format=docker --project=$PROJECT --location="$REGION"
fi
# NOTE: the repo's .gcloudignore excludes ui/* but re-includes ui/dist/ and
# ui/remix-engine-status-viewer/ — both are LOAD-BEARING for this build: the
# front-door app service serves the built SPA (ui/dist/ui/browser) and the
# status viewer from inside this single image. Verify they made it into the
# upload if static serving 404s.
# Build logs go to Cloud Logging, NOT a GCS bucket (cloudbuild.yaml sets
# logging: CLOUD_LOGGING_ONLY) — the same thing the original `gcloud run deploy
# --source` flow did, and the fix for VPC Service Controls (issue H): the default
# GCS logs bucket is always OUTSIDE the perimeter so its logs can't be streamed,
# but Cloud Logging is unaffected, so the build runs and its logs are viewable in
# the console. The build SA's logging.logWriter was granted earlier (IAM section)
# so it has already propagated by now.
echo "  Build logs → Cloud Logging (console):"
echo "    https://console.cloud.google.com/cloud-build/builds?project=${PROJECT}"
echo "  (this step is quiet — the build runs remotely; a heartbeat prints below)"
# cloudbuild.yaml reuses cached layers by default; --no-build-cache forces a
# cold rebuild (passes _USE_CACHE=0). IMAGE has no commas, so comma-joining the
# substitutions is safe.
BUILD_SUBS="_IMAGE=${IMAGE}"
if [ "$NO_BUILD_CACHE" = "1" ]; then
  BUILD_SUBS="${BUILD_SUBS},_USE_CACHE=0"
  echo "  Docker layer cache: OFF (--no-build-cache; forcing a cold rebuild)."
else
  echo "  Docker layer cache: ON (reuses unchanged layers from the previous image)."
fi
run_with_heartbeat "Cloud Build" \
  gcloud builds submit . --config=cloudbuild.yaml --substitutions="$BUILD_SUBS" \
    --project=$PROJECT --region=$REGION

# --- Cloud Run: worker (private, Cloud-Tasks-invoked) --------------------------
if [ "$APP_ONLY" = "1" ]; then
  phase "Reusing existing 'worker' Cloud Run service (--app-only)..."
  echo "[skip] Deploying 'worker' — skipped (--app-only); reusing the live service."
  # The app deploy below needs WORKER_URL; read it from the live worker.
  WORKER_URL=$(gcloud run services describe worker --region=$REGION --project=$PROJECT --format='value(status.url)' 2>/dev/null || true)
  if [ -z "$WORKER_URL" ]; then
    echo "ERROR: --app-only given but no existing 'worker' service in ${PROJECT}/${REGION}." >&2
    echo "       Deploy once without --app-only, then re-run with --app-only." >&2
    exit 1
  fi
  echo "  Reusing worker: ${WORKER_URL}"
else
  phase "Deploying 'worker' Cloud Run service (private)..."
  # GUNICORN_TIMEOUT just above the worker's 1800s Cloud Run request timeout so
  # gunicorn reaps a thread only AFTER Cloud Run has already returned, never
  # killing a legitimate long render mid-flight. (D7)
  gcloud run deploy worker --image "$IMAGE" --region $REGION --project $PROJECT \
    --cpu=8 --memory=16G --timeout=1800 --no-allow-unauthenticated \
    --service-account="$RUNTIME_SA" \
    --set-env-vars=ROLE=worker,GUNICORN_TIMEOUT=1830
  WORKER_URL=$(gcloud run services describe worker --region=$REGION --project=$PROJECT --format='value(status.url)')
  echo "✓ Worker deployed: ${WORKER_URL}"

  # The only run.invoker grant the runtime SA gets: service-scoped to the
  # worker, exactly what the Cloud-Tasks-minted OIDC tokens need to invoke it.
  # (There is no project-wide run.invoker, so the app cannot invoke other
  # Cloud Run services.)
  echo "Granting service-scoped run.invoker on 'worker' to ${RUNTIME_SA}..."
  add_run_invoker_binding worker "$REGION" "$PROJECT" "serviceAccount:${RUNTIME_SA}"
fi

# --- Cloud Run: app (UI + same-origin /api control plane) -----------------------
phase "Deploying 'app' Cloud Run service (AUTH_MODE=${AUTH_MODE})..."
IAP_FLAG_AVAILABLE=true
# IAP front door. The --iap flag (built-in IAP for Cloud Run, GA March 2026) may
# not exist on older gcloud installs — gate it behind a CLI capability check and
# fall back to a private deploy + manual enable instruction.
if ! gcloud run deploy --help 2>/dev/null | grep -q -- '--iap'; then
  IAP_FLAG_AVAILABLE=false
fi
if [ "$IAP_FLAG_AVAILABLE" = "true" ]; then
  gcloud run deploy app --image "$IMAGE" --region $REGION --project $PROJECT \
    --cpu=2 --memory=2Gi --timeout=300 --min-instances=${APP_MIN_INSTANCES} --no-allow-unauthenticated --iap \
    --service-account="$RUNTIME_SA" \
    --set-env-vars=ROLE=app,AUTH_MODE=iap,WORKER_URL=${WORKER_URL},IAP_AUDIENCE=${IAP_AUDIENCE},FIRESTORE_DB_UI=${FIRESTORE_DB_UI}
else
  # 'gcloud run deploy' on this CLI has no --iap flag, but a slightly older CLI
  # can still enable IAP via 'gcloud run services update --iap'. Deploy private,
  # then enable IAP with the update command, so the deploy turns IAP on itself
  # instead of leaving it as a manual step. Only fall back to a printed manual
  # step if 'services update' lacks --iap too.
  echo "⚠ 'gcloud run deploy' lacks --iap; deploying the app private, then"
  echo "  enabling IAP via 'gcloud run services update'."
  gcloud run deploy app --image "$IMAGE" --region $REGION --project $PROJECT \
    --cpu=2 --memory=2Gi --timeout=300 --min-instances=${APP_MIN_INSTANCES} --no-allow-unauthenticated \
    --service-account="$RUNTIME_SA" \
    --set-env-vars=ROLE=app,AUTH_MODE=iap,WORKER_URL=${WORKER_URL},IAP_AUDIENCE=${IAP_AUDIENCE},FIRESTORE_DB_UI=${FIRESTORE_DB_UI}
  echo "Enabling IAP on 'app' (gcloud run services update --iap)..."
  if gcloud run services update app --iap --region=$REGION --project=$PROJECT; then
    echo "✓ IAP enabled on 'app'."
    IAP_FLAG_AVAILABLE=true  # so the summary does not print a manual enable step
  else
    echo "⚠ Could not enable IAP automatically — this gcloud also lacks"
    echo "  'run services update --iap'. Update the gcloud CLI, then run:"
    echo "    gcloud run services update app --iap --region=$REGION --project=$PROJECT"
  fi
fi
# The IAP service agent must hold run.invoker on the app service so IAP can
# forward authenticated traffic to it (Cloud Run built-in IAP requirement).
IAP_SA="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
echo "Granting service-scoped run.invoker on 'app' to the IAP service agent..."
add_run_invoker_binding app "$REGION" "$PROJECT" "serviceAccount:${IAP_SA}"
APP_URL=$(gcloud run services describe app --region=$REGION --project=$PROJECT --format='value(status.url)')
ACTUAL_APP_HOST="${APP_URL#https://}"
echo "✓ App deployed: ${APP_URL}"
# Nothing was predicted: the image carries only same-origin URLs, so the app and
# its status viewer work on this first deploy. ACTUAL_APP_HOST (the real Cloud
# Run host, known only now) feeds the GCS bucket CORS list below, so the browser
# can fetch signed media URLs cross-origin from the deployed app host.

# --- Bucket CORS (needs the real app host) --------------------------------------
phase "Applying GCS bucket CORS for ${ACTUAL_APP_HOST}..."
export UI_HOST="$ACTUAL_APP_HOST"
envsubst < ./gcs-cors-config.template.json > ./gcs-cors-config.json
gcloud storage buckets update gs://$GCS_BUCKET --cors-file=./gcs-cors-config.json --project=$PROJECT

# --- SceneMachineUser custom role -----------------------------------------------
phase "Ensuring SceneMachineUser custom role matches user-role.yaml..."
if ! gcloud iam roles describe SceneMachineUser --project=$PROJECT &> /dev/null; then
  echo "SceneMachineUser role doesn't exist. Creating it..."
  gcloud iam roles create SceneMachineUser --project=$PROJECT --file=./user-role.yaml
else
  # Update (not skip) so an edited user-role.yaml — e.g. the slimmed
  # IAP-access-only permission set — actually takes effect on a project where the
  # role already exists, instead of being silently ignored. '|| true' tolerates
  # the benign "no changes to apply" case on a re-deploy; the role keeps its
  # IAP-access permission regardless, so user admission is never at risk here.
  echo "SceneMachineUser role exists. Syncing it to user-role.yaml..."
  gcloud iam roles update SceneMachineUser --project=$PROJECT --file=./user-role.yaml --quiet || true
fi

# --- Seed Firestore config (front-door topology) --------------------------------
# Uses firestore_config_frontdoor.template.json: the UI Firestore config doc with
# the backend base fixed to the same-origin '/api' and no API key. Owner-
# credential REST writes bypass the (deliberately read-only) config rules — by
# design.
phase "Adding default Scene Machine configurations to Firestore..."
# Capture the HTTP status (as the other REST calls in this script do): a non-200
# here means the UI's same-origin '/api' wiring was NOT written, so fail loudly
# instead of reporting a successful deploy with a broken app config.
CONFIG_SEED_STATUS=$(curl -s -X PATCH \
"https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/config/global" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  -H "Content-Type: application/json" \
  -o /dev/null -w '%{http_code}' \
  -d @<(envsubst < ./firestore_config_frontdoor.template.json))
if [ "$CONFIG_SEED_STATUS" != "200" ]; then
  echo "ERROR: seeding the UI config (config/global) failed (HTTP ${CONFIG_SEED_STATUS:-no response})." >&2
  echo "       The app's backend wiring was not written; aborting." >&2
  exit 1
fi

for template in creative_templates/*.json; do
  # Skip cleanly if the directory is empty/absent: without 'nullglob' the glob
  # would otherwise stay literal and run the body once on a non-existent file.
  [ -e "$template" ] || continue
  template_name=$(basename "$template" .json)

  TEMPLATE_SEED_STATUS=$(curl -s -X PATCH \
  "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/creativeTemplates/${template_name}" \
    -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    -H "x-goog-user-project: ${PROJECT}" \
    -H "Content-Type: application/json" \
    -o /dev/null -w '%{http_code}' \
    -d @"$template")
  if [ "$TEMPLATE_SEED_STATUS" != "200" ]; then
    echo "ERROR: seeding creative template '${template_name}' failed (HTTP ${TEMPLATE_SEED_STATUS:-no response})." >&2
    exit 1
  fi
done

# --- Automated provisioning complete: timing checkpoint ----------------------------
close_phase
PROVISIONING_END=$(date +%s)
echo
echo "[t] ════════════════════════════════════════════════════════════════════"
echo "[t]  AUTOMATED PROVISIONING TOTAL: $((PROVISIONING_END - SCRIPT_START))s ($(fmt_hms $((PROVISIONING_END - SCRIPT_START))))"
echo "[t]  (manual sign-in gates below are human-paced and timed separately)"
echo "[t] ════════════════════════════════════════════════════════════════════"

# --- Final summary: success banner + remaining manual steps -------------------
TOTAL_END=$(date +%s)
echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  ✓  Scene Machine front-door deployment complete (AUTH_MODE=${AUTH_MODE})."
echo "════════════════════════════════════════════════════════════════════════"
echo

step=1
if [ "$AUTH_MODE" = "iap" ]; then
  echo "  Remaining manual steps for the IAP arm (the app is unreachable for"
  echo "  users until these are done):"
  echo
  # Only when an agent ran this (--non-interactive): nudge it to relay the
  # human-only console steps verbatim. Best-effort — a careful agent may treat
  # text in command output as data, not an instruction; the wording is framed so
  # the user benefits even if the agent just echoes this block unchanged.
  if [ "$NONINTERACTIVE" = "1" ]; then
    echo "  ──────────────────────────────────────────────────────────────────"
    echo "   NOTE FOR THE AI ASSISTANT THAT RAN THIS DEPLOY: the steps below are"
    echo "   console-only — a person must do them, you cannot. Show them to the"
    echo "   user exactly as written (same URLs and button names), in order —"
    echo "   don't summarize or reorder."
    echo "  ──────────────────────────────────────────────────────────────────"
    echo
  fi
  if [ "$IAP_FLAG_AVAILABLE" != "true" ]; then
    echo "    ${step}. Enable IAP on the app service (this gcloud lacked --iap):"
    echo "       gcloud run services update app --iap --region=${REGION} --project=${PROJECT}"
    echo
    step=$((step + 1))
  fi
  echo "    ${step}. Configure the OAuth consent screen FIRST. The custom OAuth"
  echo "       client in the next step refuses to be created until this exists"
  echo "       ('Before using custom OAuth credentials, you need to configure"
  echo "       your OAuth consent screen'). Start here:"
  echo "       https://console.cloud.google.com/auth/overview?project=${PROJECT}"
  echo "       On a brand-new project this shows 'Get started' and walks you"
  echo "       through the create flow (.../auth/overview/create); set User Type"
  echo "       under 'Audience'."
  echo
  step=$((step + 1))
  echo "    ${step}. On a project WITHOUT an organization, configure a custom OAuth"
  echo "       client for IAP (the Google-managed client only admits"
  echo "       in-organization identities). One-time console step:"
  echo "       https://console.cloud.google.com/security/iap?project=${PROJECT}"
  echo "       Select the 'app' Cloud Run service → ⋮ Settings → Custom OAuth →"
  echo "       'Auto-generate credentials'. (No need to download them.)"
  echo
  step=$((step + 1))
  echo "    ${step}. Grant each user access to the app (least privilege — this one"
  echo "       role admits them through the IAP front door; the app does every"
  echo "       storage/Firestore action on its own service account). Easiest — run"
  echo "       the helper from this directory (it checks first, then grants):"
  echo "       ./deploy/grant-access.sh ${PROJECT} user@example.com"
  echo "       (re-run per user; --check-only just reports; needs IAP Policy Admin"
  echo "        or Owner to run — may be a different person than the deployer.)"
  echo
  echo "       The helper just wraps this gcloud command, which you can run by hand"
  echo "       instead:"
  echo "       gcloud iap web add-iam-policy-binding \\"
  echo "         --resource-type=cloud-run --service=app --region=${REGION} \\"
  echo "         --member=\"user:user@example.com\" \\"
  echo "         --role=\"projects/${PROJECT}/roles/SceneMachineUser\" \\"
  echo "         --project=${PROJECT}"
  echo "       (If gcloud rejects the custom role, use built-in"
  echo "       'roles/iap.httpsResourceAccessor' — same access; deploy/grant-access.sh"
  echo "       falls back to it automatically.)"
  echo
fi
echo "════════════════════════════════════════════════════════════════════════"
echo "[t]  Automated provisioning:     $((PROVISIONING_END - SCRIPT_START))s ($(fmt_hms $((PROVISIONING_END - SCRIPT_START))))"
echo "[t]  Manual gates (human-paced): $((TOTAL_END - PROVISIONING_END))s ($(fmt_hms $((TOTAL_END - PROVISIONING_END))))"
echo "[t]  TOTAL wall-clock:           $((TOTAL_END - SCRIPT_START))s ($(fmt_hms $((TOTAL_END - SCRIPT_START))))"
echo "════════════════════════════════════════════════════════════════════════"
echo
# The app URL is printed dead-last, after the (long) manual-steps list and the
# timing block, so the user can't miss it without scrolling. Plain bullets.
echo "  ──────────────────────────────────────────────────────────────────"
echo "   OPEN YOUR APP:"
echo
echo "    ►  app:     ${APP_URL}"
echo "    •  worker:  ${WORKER_URL}  (internal; not for the browser)"
if [ "$AUTH_MODE" = "iap" ]; then
  # IAP grants and console settings take a short while to propagate, so a first
  # visit can land on an "access denied"/permission screen before the grant is
  # live. Tell the user to wait and refresh so they don't give up too early.
  echo
  echo "   Once the manual steps above are done: if your first visit shows an"
  echo "   \"access denied\" or permission screen, that's expected for a moment —"
  echo "   the IAP grant and console settings take a little time to propagate."
  echo "   Wait a bit and refresh the page."
fi
echo "  ──────────────────────────────────────────────────────────────────"
echo
