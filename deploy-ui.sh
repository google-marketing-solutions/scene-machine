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

set -eu
echo "Deploying Scene Machine's user interface..."

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

gcloud config set project $PROJECT
gcloud auth application-default set-quota-project $PROJECT

API_UID=$(gcloud services api-keys list --filter="displayName='Scene Machine API Key'" --format="value(uid)" --project=$PROJECT)
export API_KEY=$(gcloud services api-keys get-key-string $API_UID --project=$PROJECT --format="value(keyString)")
export API_GATEWAY_HOST=$(gcloud api-gateway gateways describe scenemachine-api-gateway --project=$PROJECT --location=$API_GATEWAY_REGION --format="value(defaultHostname)")
export FIREBASE_API_KEY=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"apiKey":' | awk -F '"' '{print $4}')
export FIREBASE_AUTH_DOMAIN=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"authDomain":' | awk -F '"' '{print $4}')

envsubst < ./ui/src/env.template.txt > ./ui/src/env.ts

echo "Enabling Identity Toolkit API (needed for Auth config)"
gcloud services enable identitytoolkit.googleapis.com --project=$PROJECT

echo "Checking if bucket ${GCS_BUCKET} is linked to Firebase Storage..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  "https://firebasestorage.googleapis.com/v1beta/projects/${PROJECT}/buckets/${GCS_BUCKET}")
# If it returned status != 200, we assume it's not linked
if [ "$HTTP_STATUS" != "200" ]; then
  echo "============================================================"
  echo "MANUAL STEP REQUIRED: Bucket ${GCS_BUCKET} is not linked to Firebase Storage."
  echo "To continue deployment, please import it in the Firebase Console:"
  echo "1. Go to https://console.firebase.google.com/project/${PROJECT}/storage"
  echo "2. Click 'Get started' or click on the 'bucket name dropdown > + Add bucket'."
  echo "3. Select 'Import existing Google Cloud Storage buckets'."
  echo "4. Select ${GCS_BUCKET} and confirm."
  echo "After doing this run '$0' again"
  echo "============================================================"
  exit 1
fi

echo "Deploying rules for UI Firestore DB"
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

echo "Adding default Scene Machine configurations to Firestore"
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

echo "Granting Storage Admin role to App Engine default service account..."
gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:${PROJECT}@appspot.gserviceaccount.com" \
    --role="roles/storage.admin" \
    --condition=None \
    --quiet

echo "Granting Artifact Registry Writer role to App Engine default service account..."
gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:${PROJECT}@appspot.gserviceaccount.com" \
    --role="roles/artifactregistry.writer" \
    --condition=None \
    --quiet

echo "Checking if OAuth consent screen is configured..."
# Attempt to list brands. If empty or failures, we assume not configured or API disabled.
BRANDS=$(gcloud iap oauth-brands list --project=$PROJECT --format="value(name)" 2>/dev/null)
if [[ -z "$BRANDS" ]]; then
  echo "============================================================"
  echo "MANUAL STEP REQUIRED: OAuth consent screen is not configured for project ${PROJECT}."
  echo "To continue deployment, please configure the OAuth consent screen at:"
  echo "https://console.cloud.google.com/apis/credentials/consent?project=${PROJECT}"
  echo "After doing this run '$0' again"
  echo "============================================================"
  exit 1
fi

echo "Checking if Google sign-in provider is enabled..."
CONFIG=$(curl -s -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs/google.com")

if [[ "$CONFIG" == *'"enabled": true'* ]]; then
  echo "Google sign-in provider is enabled."
else
  echo "============================================================"
  echo "MANUAL STEP REQUIRED: Google sign-in provider is not enabled."
  echo "Please enable it in the Firebase Console at:"
  echo "https://console.firebase.google.com/project/${PROJECT}/authentication/providers"
  echo "After doing this run '$0' again"
  echo "============================================================"
  exit 1
fi

# For a local development environment, cloud deployment is not needed
if [[ "${1:-}" != "local" ]]; then
  export NG_CLI_ANALYTICS=ci
  echo "Deploying UI (AppEngine)"
  (
    cd ui \
      && npm install --legacy-peer-deps \
      && npx ng build --configuration production
  ) \
    && (
      cd ui \
        && gcloud app deploy --quiet --project "${PROJECT}"
    )
  echo "Done"
fi

echo "Configuring Firebase authorized domains..."
curl -X PATCH "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT}/config?updateMask=authorizedDomains" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT}" \
  -o /dev/null \
  -d "{\"authorizedDomains\": [\"localhost\", \"$(gcloud app describe --format='value(defaultHostname)')\"]}"

echo
echo "Scene Machine UI is deployed, now you can open:"
echo "https://$(gcloud app describe --format='value(defaultHostname)')"
echo
