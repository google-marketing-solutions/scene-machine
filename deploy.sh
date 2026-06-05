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
# Console output convention
# ---------------------------------------------------------------------------
# Lines beginning with "[>]" mark the start of a major deployment phase.
# If something fails, copy the "[>]" prefix (or the full prefix + echo message)
# from the terminal and Ctrl+F in this file to jump straight to the matching
# section in the script.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
# Wrapper for `gcloud projects add-iam-policy-binding` that (a) suppresses the
# verbose updated-policy YAML on success, and (b) retries with exponential
# backoff on concurrent-modification etag conflicts. Background GCP work (App
# Engine setup, Firebase, service-agent provisioning) modifies the project
# policy in parallel with our sequential read-modify-writes, occasionally
# racing our etag. The gcloud error itself recommends "retry with exponential
# backoff" — this helper does that automatically.
add_iam_binding() {
  # Pull the role out of the args so retry/success messages identify which
  # binding hit the conflict (otherwise the log just says "an IAM binding").
  local role=""
  for arg in "$@"; do
    case "$arg" in --role=*) role="${arg#--role=}" ;; esac
  done
  local label="${role:+ (for $role)}"

  local stderr_file
  stderr_file=$(mktemp)
  trap 'rm -f "$stderr_file"' RETURN

  local attempt=1
  local max_attempts=6
  while true; do
    if gcloud projects add-iam-policy-binding "$@" --quiet >/dev/null 2>"$stderr_file"; then
      if [ $attempt -gt 1 ]; then
        echo "  ✓ IAM binding${label} succeeded on attempt $attempt."
      fi
      return 0
    fi

    # Only retry on concurrent-modification / etag races. Permission, argument,
    # and not-found errors won't fix themselves — surface them immediately.
    if ! grep -qiE 'concurrent|aborted|etag|stale' "$stderr_file"; then
      echo "  ERROR: IAM binding${label} failed with a non-retryable error:" >&2
      cat "$stderr_file" >&2
      return 1
    fi

    if [ $attempt -ge $max_attempts ]; then
      echo "  ERROR: IAM binding${label} still conflicting after $max_attempts attempts:" >&2
      cat "$stderr_file" >&2
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

# Generate ui/definitions/config.json for backend and frontend
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

# ---------------------------------------------------------------------------
# Main script
# ---------------------------------------------------------------------------
set -euo pipefail

# Parse arguments
AUTO_CONFIRM=false
DEPLOY_BACKEND=false
DEPLOY_UI=false
TARGETED=false
DEPLOY_MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive)
      AUTO_CONFIRM=true
      shift
      ;;
    --backend-only|--be-only)
      DEPLOY_BACKEND=true
      TARGETED=true
      shift
      ;;
    --ui-only)
      DEPLOY_UI=true
      TARGETED=true
      shift
      ;;
    local|--local)
      DEPLOY_MODE="local"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [options]" >&2
      exit 1
      ;;
  esac
done

# If no targeting flags were specified, deploy both backend and UI by default
if [ "$TARGETED" = "false" ]; then
  DEPLOY_BACKEND=true
  DEPLOY_UI=true
fi

echo
echo "================================================================================"
echo "  Scene Machine backend deploy — running pre-flight checks first..."
echo "================================================================================"
# --- Pre-flight: required tools and gcloud auth -----------------------------
# Fail fast if a required command is missing or gcloud isn't authenticated,
# rather than 30+ seconds into a gcloud/firebase call with a confusing error.
echo "[>] Checking required tools..."
require_tool gcloud   "Install: https://cloud.google.com/sdk/docs/install"
require_tool firebase "Install: npm i -g firebase-tools"
require_tool node     "Install Node.js ≥ v22: https://nodejs.org/en/download"
require_tool npm      "Install Node.js (includes npm): https://nodejs.org/en/download"
require_tool envsubst "Install gettext (macOS: 'brew install gettext'; Debian/Ubuntu: 'apt-get install gettext')"
if [ $MISSING_TOOLS -gt 0 ]; then
  echo "Please install the missing tools above, then re-run $0."
  exit 1
fi
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "ERROR: gcloud has no active authenticated account." >&2
  echo "Run: gcloud auth login && gcloud auth application-default login" >&2
  exit 1
fi
echo "✓ All required tools found (gcloud, firebase, node, npm, envsubst)."
echo "✓ gcloud authenticated as: $ACTIVE_ACCOUNT"

# --- Check config.txt -------------------------------------------------------
echo
echo "[>] Checking config.txt..."
REQUIRED_VARS=(
  "API_GATEWAY"
  "API_GATEWAY_REGION"
  "APP_ENGINE_REGION"
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
  "OUTPAINTER_MODEL"
  "OUTPAINTER_REGION"
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
echo "✓ config.txt is valid. Target project: $PROJECT"

# --- Confirm deployment target ----------------------------------------------
# Final pre-flight gate. Always shows gcloud's current state alongside
# config.txt's intended target and prompts the user to confirm. Catches the
# footgun of forgetting to update either side when switching between
# deployments. The script proceeds to overwrite gcloud's active project
# immediately after this, so this is the last point at which a wrong target
# can be aborted without any GCP mutation having occurred.
CURRENT_GCLOUD_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
[ -z "$CURRENT_GCLOUD_PROJECT" ] && CURRENT_GCLOUD_PROJECT="(none set)"
echo
echo "[>] Confirming deployment target..."
echo "════════════════════════════════════════════════════════════════════════"
echo "  DEPLOYMENT TARGET — please confirm"
echo "════════════════════════════════════════════════════════════════════════"
echo "  gcloud is currently configured for:"
echo "    Account:    $ACTIVE_ACCOUNT"
echo "    Project:    $CURRENT_GCLOUD_PROJECT"
echo
echo "  config.txt says deploy to:"
echo "    Project:    $PROJECT"
echo "    Region:     $REGION"
if [ "$CURRENT_GCLOUD_PROJECT" != "$PROJECT" ]; then
  echo
  echo "  ⚠ Project mismatch — this script will switch gcloud's active project"
  echo "    to '$PROJECT' before deploying."
fi
echo "════════════════════════════════════════════════════════════════════════"
if [ "$AUTO_CONFIRM" = "true" ]; then
  echo "Auto-confirming deployment to target project: $PROJECT"
  confirm="y"
else
  if [ ! -t 0 ]; then
    echo "ERROR: stdin is not a TTY. Run interactively or pass --yes / -y." >&2
    exit 1
  fi
  read -r -p "Proceed and deploy to '$PROJECT'? (y/N) " confirm
  confirm=$(echo "$confirm" | tr '[:upper:]' '[:lower:]')
fi
if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
  echo "Aborted. To align gcloud with config.txt:" >&2
  echo "  gcloud config set project $PROJECT" >&2
  echo "Or update PROJECT in config.txt to match your intended target." >&2
  exit 1
fi
echo "✓ Continuing with project $PROJECT."

echo 
echo "════════════════════════════════════════════════════════════════════════"
echo "  Starting Scene Machine backend deployment (estimated runtime ≈15 minutes)..."
echo "════════════════════════════════════════════════════════════════════════"

echo "[>] Setting active project to $PROJECT"
gcloud config set project $PROJECT > /dev/null
echo
gcloud auth application-default set-quota-project $PROJECT > /dev/null || echo "  WARNING: Failed to set ADC quota project. This is usually non-fatal. Continuing..."

# Initialize enabled services cache
echo "[>] Fetching list of enabled Google Cloud APIs..."
ENABLED_APIS=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null || true)

is_service_enabled() {
  local service="$1"
  if [ -n "$ENABLED_APIS" ]; then
    echo "$ENABLED_APIS" | grep -q "^${service}$"
  else
    return 1
  fi
}

if [ "$DEPLOY_BACKEND" = "true" ]; then
  echo 
  echo "════════════════════════════════════════════════════════════════════════"
  echo "  Starting Scene Machine backend deployment (estimated runtime ≈15 minutes)..."
  echo "════════════════════════════════════════════════════════════════════════"

# Enable services
# Note: compute.googleapis.com is enabled here so the default Compute Engine
# service account (used for role bindings below) is guaranteed to exist. Most
# projects already have it enabled transitively; this handles fresh projects.
echo
echo "[>] Checking required Google Cloud APIs..."
REQUIRED_APIS=(
  "aiplatform.googleapis.com"
  "apigateway.googleapis.com"
  "artifactregistry.googleapis.com"
  "cloudbuild.googleapis.com"
  "cloudtasks.googleapis.com"
  "compute.googleapis.com"
  "firestore.googleapis.com"
  "run.googleapis.com"
  "servicecontrol.googleapis.com"
  "iap.googleapis.com"
)
APIS_TO_ENABLE=()
for api in "${REQUIRED_APIS[@]}"; do
  if ! is_service_enabled "$api"; then
    APIS_TO_ENABLE+=("$api")
  fi
done

if [ ${#APIS_TO_ENABLE[@]} -gt 0 ]; then
  echo "Enabling missing APIs: ${APIS_TO_ENABLE[*]} (may take 30-60s)..."
  gcloud services enable "${APIS_TO_ENABLE[@]}" --project="$PROJECT" > /dev/null
  # Refresh cache
  ENABLED_APIS=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null || true)
else
  echo "✓ All required Google Cloud APIs are already enabled."
fi

# Warm up Vertex AI service agent. On a fresh project, the agent
# (service-<PROJECT_NUMBER>@gcp-sa-aiplatform.iam.gserviceaccount.com) is
# created lazily on first API use, and its auto-granted Storage Object access
# takes ~5-15 min to propagate. Without this, the user's first Veo generation
# fails with "Service agents are being provisioned." Triggering identity
# creation now starts the propagation window during the rest of the deploy.
#
# `services identity create` is still on the `beta` surface today; try the GA
# path first so we survive its eventual promotion (the beta command will be
# removed at some point and would silently fail on a future toolchain).
echo
echo "[>] Provisioning Vertex AI service agent..."
gcloud services identity create --service=aiplatform.googleapis.com --project=$PROJECT 2>/dev/null \
  || gcloud beta services identity create --service=aiplatform.googleapis.com --project=$PROJECT

# Create databases
echo
echo "[>] Setting up GCS bucket and Firestore databases..."
if ! gcloud storage buckets describe "gs://$GCS_BUCKET" &> /dev/null; then
    gcloud storage buckets create "gs://$GCS_BUCKET" --project=$PROJECT --location="$REGION"
else
    echo "Bucket gs://$GCS_BUCKET already exists in the following location:"
    gcloud storage buckets describe "gs://$GCS_BUCKET" --format="value(location)"
fi
if ! gcloud firestore databases describe --database="$FIRESTORE_DB" --project=$PROJECT &> /dev/null; then
    echo "Creating Firestore database: $FIRESTORE_DB"
    gcloud firestore databases create --database="$FIRESTORE_DB" --project=$PROJECT --location="$REGION"
else
    echo "Firestore database $FIRESTORE_DB already exists in the following location:"
    gcloud firestore databases describe --database="$FIRESTORE_DB" --project=$PROJECT --format="value(locationId)"
fi
if ! gcloud firestore databases describe --database="$FIRESTORE_DB_UI" --project=$PROJECT &> /dev/null; then
    echo "Creating Firestore database: $FIRESTORE_DB_UI"
    gcloud firestore databases create --database="$FIRESTORE_DB_UI" --project=$PROJECT --location="$REGION"
else
    echo "Firestore database $FIRESTORE_DB_UI already exists in the following location:"
    gcloud firestore databases describe --database="$FIRESTORE_DB_UI" --project=$PROJECT --format="value(locationId)"
fi

echo
echo "[>] Setting up Firebase project and Web App..."
if is_service_enabled "firebase.googleapis.com"; then
  echo "Firebase is already enabled for the project."
else
  echo "Enabling Firebase..."
  gcloud services enable firebase.googleapis.com --project=$PROJECT
  firebase projects:addfirebase $PROJECT
  # Refresh cache
  ENABLED_APIS=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null || true)
fi

if firebase apps:list --project $PROJECT | grep "$PROJECT" | grep -q "WEB"; then
  echo "Firebase App already exists. Skipping."
else
  echo "Firebase App doesn't exist. Creating it (Estimated time: ≈1 minute)..."
  firebase --project $PROJECT apps:create WEB $PROJECT
fi

# Deploy rules for Backend Firestore DB
export CURRENT_FIRESTORE_DB=$FIRESTORE_DB
envsubst < ./firebase/firebase.template.json > ./firebase/firebase.json
envsubst < ./firebase/.firebaserc.template > ./firebase/.firebaserc
firebase target:apply --config firebase/firebase.json storage bucket_target $GCS_BUCKET --project $PROJECT

echo
echo "[>] Deploying rules for Backend Firestore DB..."
firebase deploy --config firebase/firebase.json --only firestore --project $PROJECT

rm firebase/firebase.json
rm firebase/.firebaserc

FIREBASE_API_KEY=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"apiKey":' | awk -F '"' '{print $4}')
if [ -z "$FIREBASE_API_KEY" ]; then
  echo "ERROR: Failed to extract Firebase API key from 'firebase apps:sdkconfig WEB'. Check that the Firebase Web app exists in project $PROJECT." >&2
  exit 1
fi
export FIREBASE_API_KEY

echo
echo "[>] Setting up App Engine app..."
if ! gcloud app describe --project=$PROJECT &> /dev/null; then
  echo "App Engine app doesn't exist. Creating it (Estimated time: ≈3 minutes)..."
  gcloud app create --region $APP_ENGINE_REGION --project $PROJECT
else
  echo "App Engine app already exists. Skipping."
fi

if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  export UI_HOST="${CUSTOM_DOMAIN}"
  echo "✓ Using custom domain: ${UI_HOST}"
else
  export UI_HOST=$(gcloud app describe --project=$PROJECT --format="value(defaultHostname)")
fi

# Identify service account and assign required permissions BEFORE deployment
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format="value(projectNumber)")
SERVICE_ACCOUNT="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
# The default Compute Engine SA is created when compute.googleapis.com is
# enabled (above), but its propagation can take 30-60s on fresh projects.
# Wait for it to exist before attempting role bindings below, rather than
# failing inside the loop with a confusing "service account not found" error.
echo
echo "[>] Waiting for default Compute Engine service account to exist..."
SA_WAIT_ATTEMPTS=0
SA_WAIT_MAX=120   # 120 × 5s = 10 min total
until gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" --project=$PROJECT &> /dev/null; do
  SA_WAIT_ATTEMPTS=$((SA_WAIT_ATTEMPTS + 1))
  if [ $SA_WAIT_ATTEMPTS -ge $SA_WAIT_MAX ]; then
    echo "ERROR: default Compute Engine SA did not appear after 10 minutes." >&2
    echo "Try enabling Compute Engine API manually, then re-run $0:" >&2
    echo "  gcloud services enable compute.googleapis.com --project=$PROJECT" >&2
    exit 1
  fi
  sleep 5
done
echo "✓ Service account ${SERVICE_ACCOUNT} ready."

ROLES=(
  "roles/datastore.user"
  "roles/aiplatform.user"
  "roles/iam.serviceAccountTokenCreator"
  "roles/run.invoker"
  "roles/cloudtasks.enqueuer"
  "roles/storage.objectUser"
  "roles/artifactregistry.writer"
  "roles/logging.logWriter"
  "roles/iam.serviceAccountUser"
)
echo
echo "[>] Granting ${#ROLES[@]} roles to $SERVICE_ACCOUNT..."
for ROLE in "${ROLES[@]}"; do
  echo "  - $ROLE"
  add_iam_binding $PROJECT --member="serviceAccount:${SERVICE_ACCOUNT}" --role="$ROLE" --condition=None
done
echo "✓ Roles granted."

# Explicitly grant the Vertex AI service agent storage access. The agent is
# auto-granted this on first use but propagation lags by ~5-15 min; binding it
# now eliminates the first-Veo-generation "Service agents are being
# provisioned" failure (see DEPLOY_NOTES.md issue #6).
AIPLATFORM_SA="service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com"
echo
echo "[>] Granting roles/storage.objectUser to Vertex AI service agent..."
add_iam_binding $PROJECT --member="serviceAccount:${AIPLATFORM_SA}" --role="roles/storage.objectUser" --condition=None

# Deploy backend (Cloud Run)
COMMIT_DATE=$(git log -1 --format=%cI)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "${GIT_BRANCH}/${COMMIT_DATE}" > deployed_version.txt
sync
if ! gcloud artifacts repositories describe "${ARTIFACT_REPO}" --project=$PROJECT --location="$REGION" &> /dev/null; then
  echo "Creating artifact repository: $ARTIFACT_REPO"
  gcloud artifacts repositories create "${ARTIFACT_REPO}" --repository-format=docker --project=$PROJECT --location="$REGION"
fi

# Write config.json since backend needs part of it
generate_config

echo
echo "[>] Deploying backend to Cloud Run (Estimated time: ~5 minutes)..."
gcloud run deploy "$BACKEND_SERVICE_NAME" --source . --image $REGION-docker.pkg.dev/$PROJECT/$ARTIFACT_REPO/$BACKEND_SERVICE_NAME:latest --region $REGION --project $PROJECT --cpu=8 --memory=16G --timeout=1800 --no-allow-unauthenticated
export CLOUD_RUN_URL=$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region=$REGION --project=$PROJECT --format='value(status.url)')

# Ensure queues
echo
echo "[>] Setting up Cloud Tasks queues..."
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

# Apply IAM bindings for the Cloud Tasks service agent.
CLOUD_TASKS_ACCOUNT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
echo
echo "[>] Granting Cloud Tasks service agent permissions..."
add_iam_binding "${PROJECT}" --member="serviceAccount:${CLOUD_TASKS_ACCOUNT}" --role="roles/cloudtasks.serviceAgent" --condition=None
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT}" --member="serviceAccount:${CLOUD_TASKS_ACCOUNT}" --role="roles/iam.serviceAccountTokenCreator" --quiet > /dev/null

echo
echo "[>] Provisioning API Gateway and routing infrastructure (Estimated time: ≈10 minutes)..."
if ! gcloud api-gateway apis describe scenemachine-api --project=$PROJECT --format="value(managed_service)" &> /dev/null; then
  echo "API doesn't exist. Creating it..."
  gcloud api-gateway apis create scenemachine-api --project=$PROJECT
else
  echo "API already exists. Skipping."
fi

export API_MANAGED_SERVICE_HOST=$(gcloud api-gateway apis describe scenemachine-api --project=$PROJECT --format="value(managed_service)")
envsubst < ./apispec.template.yaml > ./apispec.yaml

if ! gcloud api-gateway api-configs describe scenemachine-api-config --api=scenemachine-api --project=$PROJECT &> /dev/null; then
  echo "API Configuration doesn't exist. Creating it..."
  gcloud api-gateway api-configs create scenemachine-api-config --api=scenemachine-api --openapi-spec=./apispec.yaml --project=$PROJECT
else
  echo "API Configuration already exists. Skipping."
fi

if ! gcloud api-gateway gateways describe scenemachine-api-gateway --project=$PROJECT --location=$API_GATEWAY_REGION --format="value(defaultHostname)" &> /dev/null; then
  echo "API Gateway doesn't exist. Creating it..."
  gcloud api-gateway gateways create scenemachine-api-gateway --api=scenemachine-api --api-config=scenemachine-api-config --location=$API_GATEWAY_REGION --project=$PROJECT
else
  echo "API Gateway already exists. Skipping."
fi

if is_service_enabled "$API_MANAGED_SERVICE_HOST"; then
  echo "API Managed Service Host $API_MANAGED_SERVICE_HOST is already enabled."
else
  echo "Enabling API Managed Service Host..."
  gcloud services enable $API_MANAGED_SERVICE_HOST --project=$PROJECT
  ENABLED_APIS=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null || true)
fi

#TODO: add --allowed-referrers
API_UID=$(gcloud services api-keys list --filter="displayName='Scene Machine API Key'" --format="value(uid)" --project=$PROJECT)
if [ -z "$API_UID" ]; then
  echo "API Key doesn't exist. Creating it..."
  gcloud services api-keys create --display-name="Scene Machine API Key" --api-target=service=$API_MANAGED_SERVICE_HOST --project=$PROJECT
  # Fetch the UID again after creation
  API_UID=$(gcloud services api-keys list --filter="displayName='Scene Machine API Key'" --format="value(uid)" --project=$PROJECT)
else
  echo "API Key already exists. Skipping."
fi

if [ -n "$API_UID" ]; then
  export API_KEY=$(gcloud services api-keys get-key-string $API_UID --project=$PROJECT --format="value(keyString)")
else
  echo "ERROR: Failed to retrieve API Key UID." >&2
  exit 1
fi
export API_GATEWAY_HOST=$(gcloud api-gateway gateways describe scenemachine-api-gateway --project=$PROJECT --location=$API_GATEWAY_REGION --format="value(defaultHostname)")

# Write config.json again, now with all values needed for UI
generate_config

# Set permissions and create user role
envsubst < ./gcs-cors-config.template.json > ./gcs-cors-config.json
gcloud storage buckets update gs://$GCS_BUCKET --cors-file=./gcs-cors-config.json --project=$PROJECT

if ! gcloud iam roles describe SceneMachineUser --project=$PROJECT &> /dev/null; then
  echo "SceneMachineUser role doesn't exist. Creating it..."
  gcloud iam roles create SceneMachineUser --project=$PROJECT --file=./user-role.yaml
else
  echo "SceneMachineUser role already exists. Skipping."
fi

# Upload example files
gcloud storage cp workflow_examples/input/* gs://${GCS_BUCKET}/examples/

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  ✓  Scene Machine backend deployment complete."
echo "════════════════════════════════════════════════════════════════════════"
fi

if [ "$DEPLOY_UI" = "true" ]; then
echo
echo "  Next: ./deploy-ui.sh deploys the Angular UI to App Engine."
echo
echo "  Before that, 3 manual console steps are required. deploy-ui.sh polls"
echo "  every 15s (or prompts you) and picks up automatically when you complete"
echo "  them, so you can launch it now and finish the manual steps in parallel."
echo
echo "    1. Configure OAuth consent screen"
echo "       https://console.cloud.google.com/auth/branding?project=${PROJECT}"
echo "       First time on this project: click 'Get started' and walk through"
echo "       the setup dialog. User Type is set under 'Audience' — pick"
echo "       'Internal' if you have a Workspace org; otherwise 'External' and"
echo "       add yourself as a test user."
echo
echo "    2. Enable Google as a Firebase sign-in provider"
echo "       https://console.firebase.google.com/project/${PROJECT}/authentication/providers"
echo "       If the providers list isn't visible yet, click 'Get started' on"
echo "       the Authentication page first to reach it. Then: 'Add new"
echo "       provider' → 'Google' → enable → save."
echo
echo "    3. Set up Firebase Storage — TWO sequential actions on this page:"
echo "       https://console.firebase.google.com/project/${PROJECT}/storage"
echo "       (a) Click 'Get started' and walk through the wizard. This creates"
echo "           the project's default <project>.firebasestorage.app bucket"
echo "           (separate from ${GCS_BUCKET}). Required by 'firebase deploy"
echo "           --only storage' or it errors with 'Firebase Storage has not"
echo "           been set up on project'."
echo "       (b) On the same page, AFTER (a) finishes (the bucket dropdown"
echo "           only appears once a bucket exists), click the dropdown →"
echo "           '+ Add bucket' → 'Import existing Google Cloud Storage"
echo "           buckets' → select ${GCS_BUCKET} → confirm. Registers your"
echo "           project bucket so deploy-ui.sh can target it."
echo
echo "════════════════════════════════════════════════════════════════════════"
echo
read -r -p "Run ./deploy-ui.sh now? (y/N) " answer
answer=$(echo "$answer" | tr '[:upper:]' '[:lower:]')
if [ "$answer" = "y" ] || [ "$answer" = "yes" ]; then
  ./deploy-ui.sh
else
  echo "To deploy the UI later, run ./deploy-ui.sh. Deployment guide:"
  echo "  https://github.com/google-marketing-solutions/scene-machine#deployment"
fi
fi

