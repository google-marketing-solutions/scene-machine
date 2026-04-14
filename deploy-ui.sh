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

# 1) Check config
REQUIRED_VARS=(
  "PROJECT"
  "FIRESTORE_DB_UI"
  "GCS_BUCKET"
  "API_GATEWAY_REGION"
  "GEMINI_REGION"
  "GEMINI_MODEL"
  "VEO_REGION"
  "VEO_MODEL"
)
MISSING=0
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -qE "^(export )?${var}=[A-Za-z0-9._-]+" config.txt; then
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


# 2) Deploy UI (AppEngine)
export NG_CLI_ANALYTICS=ci
# For a local development environment, cloud deployment is not needed
if [[ "${1:-}" != "local" ]]; then
  (cd ui && npm install --legacy-peer-deps && npx ng build --configuration production) && (cd ui && gcloud app deploy --quiet --project $PROJECT)
  echo "Scene Machine is now available under the following address: https://$(gcloud app describe --format='value(defaultHostname)')"
fi
