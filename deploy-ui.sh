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
# Console output convention: lines beginning with "[>]" mark the start of a
# major deployment phase. If something fails, copy the "[>]" prefix (or the
# full prefix + echo message) from the terminal and Ctrl+F in this file to jump
# straight to the matching section in the script.
# ---------------------------------------------------------------------------

# Wrapper for `gcloud projects add-iam-policy-binding` that (a) suppresses the
# verbose updated-policy YAML on success, and (b) retries with exponential
# backoff on concurrent-modification etag conflicts. Mirrors the helper in
# deploy.sh — keep the two definitions in sync.
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

set -eu
echo "Scene Machine UI deploy — running pre-flight checks first..."

# Check config
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
  if ! grep -qE "^(export )?${var}=[A-Za-z0-9._\$-]+" config.txt; then
    echo "ERROR: $var is missing, empty, or has invalid characters in config.txt"
    MISSING=$((MISSING + 1))
  fi
done
if [ $MISSING -gt 0 ]; then
  echo "Validation failed. Please fix config.txt and try again."
  exit 1
fi
source ./config.txt

echo
echo "[>] Starting Scene Machine UI deployment..."

gcloud config set project $PROJECT
gcloud auth application-default set-quota-project $PROJECT

API_UID=$(gcloud services api-keys list --filter="displayName='Scene Machine API Key'" --format="value(uid)" --project=$PROJECT)
export API_KEY=$(gcloud services api-keys get-key-string $API_UID --project=$PROJECT --format="value(keyString)")
export API_GATEWAY_HOST=$(gcloud api-gateway gateways describe scenemachine-api-gateway --project=$PROJECT --location=$API_GATEWAY_REGION --format="value(defaultHostname)")
export FIREBASE_API_KEY=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"apiKey":' | awk -F '"' '{print $4}')
export FIREBASE_AUTH_DOMAIN=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"authDomain":' | awk -F '"' '{print $4}')
if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  export UI_HOST="${CUSTOM_DOMAIN}"
  echo "✓ Using custom domain: ${UI_HOST}"
else
  export UI_HOST=$(gcloud app describe --project=$PROJECT --format="value(defaultHostname)")
fi

envsubst < ./ui/definitions/config.template.json > ./ui/definitions/config.json
envsubst < ./ui/src/env.template.txt > ./ui/src/env.ts

echo
echo "[>] Enabling Identity Toolkit API (needed for Auth config)..."
gcloud services enable identitytoolkit.googleapis.com --project=$PROJECT

# --- Bucket linked to Firebase Storage: poll until satisfied ----------------
# Replaces the original exit-1-and-rerun pattern. Loops every 15s until the
# bucket is linked, so the user can complete the console steps and the script
# picks up automatically.
#
# TWO sequential manual steps in the Firebase console are required:
#   (a) "Get Started" wizard — creates the project's *default* Firebase
#       Storage bucket (typically <project>.firebasestorage.app). Required
#       by `firebase deploy --only storage` further below; without it that
#       command fails with "Firebase Storage has not been set up on project".
#   (b) "Import existing GCS buckets" — registers ${GCS_BUCKET} (the bucket
#       deploy.sh created earlier) with Firebase Storage so it can be the
#       deploy target. The polling check below specifically verifies (b).
echo
echo "[>] Checking if bucket ${GCS_BUCKET} is linked to Firebase Storage..."
BUCKET_WAIT_ATTEMPTS=0
BUCKET_WAIT_MAX=120   # 120 × 15s = 30 min total
# Source of truth: Firebase Storage REST API. The `firebase` CLI has no
# per-bucket linkage query, so we hit the REST endpoint directly and treat
# HTTP 200 as "linked", anything else as "not yet".
while true; do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    -H "x-goog-user-project: ${PROJECT}" \
    "https://firebasestorage.googleapis.com/v1beta/projects/${PROJECT}/buckets/${GCS_BUCKET}")
  if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ Bucket ${GCS_BUCKET} is linked to Firebase Storage."
    break
  fi
  BUCKET_WAIT_ATTEMPTS=$((BUCKET_WAIT_ATTEMPTS + 1))
  if [ $BUCKET_WAIT_ATTEMPTS -ge $BUCKET_WAIT_MAX ]; then
    echo "ERROR: bucket ${GCS_BUCKET} still not linked after 30 minutes — aborting."
    echo "Complete the two manual steps above, then re-run $0."
    exit 1
  fi
  echo "============================================================"
  echo "WAITING: bucket ${GCS_BUCKET} is not yet linked to Firebase Storage."
  echo "Two sequential steps in the Firebase Console are required:"
  echo "  Open: https://console.firebase.google.com/project/${PROJECT}/storage"
  echo
  echo "  Step 1 — Initialize Firebase Storage (only needed once per project):"
  echo "    Click 'Get started' and walk through the wizard."
  echo "    This creates a default <project>.firebasestorage.app bucket."
  echo "    Production mode is fine."
  echo
  echo "  Step 2 — Register ${GCS_BUCKET} with Firebase Storage:"
  echo "    On the same page (after Step 1 — the bucket dropdown only"
  echo "    appears once a bucket exists), click the dropdown →"
  echo "    '+ Add bucket' → 'Import existing Google Cloud Storage"
  echo "    buckets' → select ${GCS_BUCKET} → confirm."
  echo
  echo "Re-checking in 15 seconds (attempt ${BUCKET_WAIT_ATTEMPTS}/${BUCKET_WAIT_MAX}; Ctrl-C to abort)..."
  echo "============================================================"
  sleep 15
done

echo
echo "[>] Deploying rules for UI Firestore DB and Storage..."
(
  cd firebase
  export CURRENT_FIRESTORE_DB=$FIRESTORE_DB_UI
  envsubst < ./firebase.template.json > ./firebase.json
  envsubst < ./.firebaserc.template > ./.firebaserc
  firebase target:apply storage bucket_target $GCS_BUCKET --project $PROJECT

  echo "Deploying rules for UI Firestore DB..."
  firebase deploy --config ./firebase.json --only firestore --project $PROJECT

  echo "Deploying Storage rules..."
  firebase deploy --config ./firebase.json --only storage:bucket_target --project $PROJECT
)

rm firebase/firebase.json
rm firebase/.firebaserc

echo
echo "[>] Adding default Scene Machine configurations to Firestore..."
curl -X PATCH \
"https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/config/global" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "Content-Type: application/json" \
  -o /dev/null \
  -d @<(envsubst < ./firestore_config_ui.template.json)

for template in creative_templates/*.json; do
  template_name=$(basename "$template" .json)

  curl -X PATCH \
  "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/creativeTemplates/${template_name}" \
    -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    -H "Content-Type: application/json" \
    -o /dev/null \
    -d @"$template"
done

echo
echo "[>] Granting Storage Admin role to App Engine default service account..."
add_iam_binding $PROJECT \
    --member="serviceAccount:${PROJECT}@appspot.gserviceaccount.com" \
    --role="roles/storage.admin" \
    --condition=None

echo
echo "[>] Granting Artifact Registry Writer role to App Engine default service account..."
add_iam_binding $PROJECT \
    --member="serviceAccount:${PROJECT}@appspot.gserviceaccount.com" \
    --role="roles/artifactregistry.writer" \
    --condition=None

# --- OAuth consent screen: manual gate ---------------------------------------
# `gcloud iap oauth-brands list` (the original verification) was permanently
# shut down on 2026-03-19 and required project-in-org regardless, so we cannot
# directly verify the consent screen via API on standalone projects.
#
# Fast-skip on re-run: probe the Identity Toolkit Admin REST API for the
# Google IdP config. If it returns 200, the IdP record exists — and that
# record cannot be created without a configured OAuth consent screen, so
# 200 implies consent is done. 404 leaves us uncertain; fall back to the
# blocking Press-Enter prompt below.
echo
echo "[>] Checking if OAuth consent screen is already configured..."
IDP_HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs/google.com")
if [ "$IDP_HTTP_STATUS" = "200" ]; then
  echo "✓ OAuth consent screen already configured (Google IdP record exists)."
else
  echo "============================================================"
  echo "MANUAL STEP REQUIRED: OAuth consent screen must be configured."
  echo "  https://console.cloud.google.com/auth/branding?project=${PROJECT}"
  echo
  echo "First time on this project: click 'Get started' and walk through"
  echo "the setup dialog. User Type is set under 'Audience' — pick"
  echo "'Internal' if you have a Workspace org; otherwise 'External' and"
  echo "add yourself as a test user."
  echo
  echo "If you've configured it before and don't see 'Get started', the"
  echo "screen is already initialized — just confirm below to proceed."
  echo "============================================================"
  if [ ! -t 0 ]; then
    echo "ERROR: stdin is not a TTY — cannot prompt for OAuth-consent confirmation."
    echo "Configure the consent screen at the URL above, then re-run $0 interactively."
    exit 1
  fi
  read -r -p "Press Enter once the OAuth consent screen is configured (Ctrl-C to abort)... "
fi

# --- Google sign-in provider enabled: poll until satisfied ------------------
# Replaces the original exit-1-and-rerun pattern. Loops every 15s until the
# provider is enabled.
echo
echo "[>] Checking if Google sign-in provider is enabled..."
SIGNIN_WAIT_ATTEMPTS=0
SIGNIN_WAIT_MAX=120   # 120 × 15s = 30 min total
# Source of truth: Identity Toolkit Admin REST API. The `firebase auth:` CLI
# has no IdP enable-state query, so we read the IdP config directly and look
# for `"enabled": true` in the JSON body.
while true; do
  CONFIG=$(curl -s -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    -H "x-goog-user-project: ${PROJECT}" \
    "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs/google.com")
  if [[ "$CONFIG" == *'"enabled": true'* ]]; then
    echo "✓ Google sign-in provider is enabled."
    break
  fi
  SIGNIN_WAIT_ATTEMPTS=$((SIGNIN_WAIT_ATTEMPTS + 1))
  if [ $SIGNIN_WAIT_ATTEMPTS -ge $SIGNIN_WAIT_MAX ]; then
    echo "ERROR: Google sign-in provider still not enabled after 30 minutes — aborting."
    echo "Enable it in the Firebase Console, then re-run $0:"
    echo "  https://console.firebase.google.com/project/${PROJECT}/authentication/providers"
    exit 1
  fi
  echo "============================================================"
  echo "WAITING: Google sign-in provider is not yet enabled."
  echo "Please enable it in the Firebase Console (script will keep checking):"
  echo "  https://console.firebase.google.com/project/${PROJECT}/authentication/providers"
  echo "  If the providers list isn't visible yet, click 'Get started' on the"
  echo "  Authentication page first to reach it."
  echo "  Then: 'Add new provider' → choose 'Google' → enable → save."
  echo "Re-checking in 15 seconds (attempt ${SIGNIN_WAIT_ATTEMPTS}/${SIGNIN_WAIT_MAX}; Ctrl-C to abort)..."
  echo "============================================================"
  sleep 15
done

# For a local development environment, cloud deployment is not needed
if [[ "${1:-}" != "local" ]]; then
  export NG_CLI_ANALYTICS=ci
  echo
  echo "[>] Deploying UI to App Engine (Estimated time: ≈5 minutes)..."
  (
    cd ui \
      && npm ci --legacy-peer-deps \
      && npx ng build --configuration production
  ) \
    && (
      cd ui \
        && gcloud app deploy --quiet --project "${PROJECT}"
    )
fi

echo
echo "[>] Configuring Firebase authorized domains..."
curl -X PATCH "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT}/config?updateMask=authorizedDomains" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT}" \
  -o /dev/null \
  -d "{\"authorizedDomains\": [\"localhost\", \"$(gcloud app describe --format='value(defaultHostname)')\"]}"

# --- Final summary: success banner + remaining manual steps ----------------
if [[ "${1:-}" == "local" ]]; then
  APP_URL="http://localhost:4200/"
else
  APP_URL="https://$(gcloud app describe --project=$PROJECT --format='value(defaultHostname)')"
fi
IAP_ENABLED=$(gcloud app describe --project=$PROJECT --format="value(iap.enabled)" 2>/dev/null || echo "")

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  ✓  SCENE MACHINE UI DEPLOYED"
echo "════════════════════════════════════════════════════════════════════════"
echo
echo "  ──────────────────────────────────────────────────────────────────"
echo "   OPEN YOUR APP:"
echo
echo "       ►  ${APP_URL}"
echo
echo "  ──────────────────────────────────────────────────────────────────"
echo
echo "  Highly recommended manual steps before users can sign in."
echo "  Skipping either step will leave the app publicly inaccessible or"
echo "  unprotected — do not deploy to real users without completing both."
echo

step=1
if [[ ! "${IAP_ENABLED:-}" =~ [tT]rue ]]; then
  echo "    ${step}. Enable Identity-Aware Proxy (highly recommended — gates"
  echo "       the app behind Google sign-in)."
  echo "       https://console.cloud.google.com/security/iap?project=${PROJECT}&serviceId=default"
  echo "       Turn IAP ON for 'App Engine app', then click the ⋮ (three-dot"
  echo "       menu, far right of the row) → 'Settings' → 'Custom OAuth' →"
  echo "       'Auto-generate credentials'."
  echo "       (No need to download the credentials.)"
  echo
  step=$((step + 1))
fi
echo "    ${step}. Grant the 'Scene Machine User' role to each user (highly"
echo "       recommended — without it, signed-in users hit a 403). Fastest:"
echo "       gcloud projects add-iam-policy-binding ${PROJECT} \\"
echo "         --member=\"user:YOUR_EMAIL@example.com\" \\"
echo "         --role=\"projects/${PROJECT}/roles/SceneMachineUser\""
echo "       Or via the IAM console:"
echo "       https://console.cloud.google.com/iam-admin/iam?project=${PROJECT}"
echo
echo "════════════════════════════════════════════════════════════════════════"
echo
