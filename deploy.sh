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

# Generate ui/definitions/config.json for backend and frontend
generate_config() {
  envsubst < ui/definitions/config.template.json > ui/definitions/config.json
}

set -eu
echo "Deploying Scene Machine... (Total runtime estimate: ≈17 minutes)"

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
  if ! grep -qE "^(export )?${var}=[A-Za-z0-9._\$-]+" ./config.txt; then
    echo "ERROR: $var is missing, empty, or has invalid characters in config.txt"
    MISSING=$((MISSING + 1))
  fi
done
if [ $MISSING -gt 0 ]; then
  echo "Validation failed. Please fix config.txt and try again."
  exit 1
fi
source ./config.txt

# 1) Enable services
gcloud config set project $PROJECT
gcloud auth application-default set-quota-project $PROJECT
gcloud services enable aiplatform.googleapis.com apigateway.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com cloudtasks.googleapis.com firestore.googleapis.com run.googleapis.com servicecontrol.googleapis.com iap.googleapis.com --project=$PROJECT

# 2) Create databases
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

if gcloud services list --enabled --project=$PROJECT --filter="name:firebase.googleapis.com" | grep -q "firebase.googleapis.com"; then
  echo "Firebase is already enabled for the project."
else
  echo "Enabling Firebase..."
  gcloud services enable firebase.googleapis.com --project=$PROJECT
  firebase projects:addfirebase $PROJECT
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

echo "Deploying rules for Backend Firestore DB..."
firebase deploy --config firebase/firebase.json --only firestore --project $PROJECT

rm firebase/firebase.json
rm firebase/.firebaserc

export FIREBASE_API_KEY=$(firebase --non-interactive --project $PROJECT apps:sdkconfig WEB | grep '"apiKey":' | awk -F '"' '{print $4}')

if ! gcloud app describe --project=$PROJECT &> /dev/null; then
  echo "App Engine app doesn't exist. Creating it (Estimated time: ≈3 minutes)..."
  gcloud app create --region $APP_ENGINE_REGION --project $PROJECT
else
  echo "App Engine app already exists. Skipping."
fi

export UI_HOST=$(gcloud app describe --project=$PROJECT --format="value(defaultHostname)")

# Identify service account and assign required permissions BEFORE deployment
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format="value(projectNumber)")
SERVICE_ACCOUNT="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" &> /dev/null; then
  echo "Service account does not exist: ${SERVICE_ACCOUNT}"
fi

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
for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${SERVICE_ACCOUNT}" --role="$ROLE" --condition=None
done

# 3) Deploy backend (Cloud Run)
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

echo "Deploying backend to Cloud Run (Estimated time: ~7 minutes)..."
gcloud run deploy "$BACKEND_SERVICE_NAME" --source . --image $REGION-docker.pkg.dev/$PROJECT/$ARTIFACT_REPO/$BACKEND_SERVICE_NAME:latest --region $REGION --project $PROJECT --cpu=8 --memory=16G --timeout=1800 --no-allow-unauthenticated
export CLOUD_RUN_URL=$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region=$REGION --project=$PROJECT --format='value(status.url)')

# Ensure queues
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

# Apply IAM bindings (these are safe to run multiple times, though they will output "no change")
CLOUD_TASKS_ACCOUNT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${CLOUD_TASKS_ACCOUNT}" --role="roles/cloudtasks.serviceAgent" --condition=None
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT}" --member="serviceAccount:${CLOUD_TASKS_ACCOUNT}" --role="roles/iam.serviceAccountTokenCreator"

echo "Provisioning API Gateway and routing infrastructure (Estimated time: ≈6 minutes)..."
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

gcloud services enable $API_MANAGED_SERVICE_HOST --project=$PROJECT

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
  echo "ERROR: Failed to retrieve API Key UID."
  exit 1
fi
export API_GATEWAY_HOST=$(gcloud api-gateway gateways describe scenemachine-api-gateway --project=$PROJECT --location=$API_GATEWAY_REGION --format="value(defaultHostname)")

# Write config.json again, now with all values needed for UI
generate_config

# 5) Set permissions and create user role
envsubst < ./gcs-cors-config.template.json > ./gcs-cors-config.json
gcloud storage buckets update gs://$GCS_BUCKET --cors-file=./gcs-cors-config.json --project=$PROJECT

if ! gcloud iam roles describe RemixEngineUser --project=$PROJECT &> /dev/null; then
  echo "RemixEngineUser role doesn't exist. Creating it..."
  gcloud iam roles create RemixEngineUser --project=$PROJECT --file=./user-role.yaml
else
  echo "RemixEngineUser role already exists. Skipping."
fi

# 6) Upload example files
gcloud storage cp workflow_examples/input/* gs://${GCS_BUCKET}/examples/

read -p "Do you want to deploy the UI? (y/N) " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  ./deploy-ui.sh
else
  echo "To deploy the UI later, follow the instructions in README.md or run ./deploy-ui.sh"
fi

