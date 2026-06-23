#!/usr/bin/env bash
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
# scripts/dev-setup.sh — render ui/src/env.ts and ui/definitions/config.json
# for LOCAL UI DEVELOPMENT.
#
# It uses the SAME envsubst-on-the-templates mechanism deploy.sh uses, so the
# local files match how production renders them — only the values differ:
#   controlPlaneMode = 'none'  (no sign-in gate, no IAP front door)
#   data plane        = 'mediated' (unchanged; the backend still brokers data)
#
# Both output files are gitignored (ui/.gitignore: src/env*.ts; root
# .gitignore: ui/definitions/config.json), so this never produces a commit.
# Re-run any time; it overwrites in place.
#
# This is a DEV-ONLY convenience. It deliberately writes controlPlaneMode:'none',
# which removes the sign-in gate — fine on localhost, never for a deployed app.
# deploy.sh refuses to ship a 'none' env.ts, so a dev render cannot reach prod.
# ---------------------------------------------------------------------------
set -euo pipefail

command -v envsubst >/dev/null 2>&1 || {
  echo "ERROR: envsubst not found." >&2
  echo "  macOS:        brew install gettext && brew link --force gettext" >&2
  echo "  Debian/Ubuntu: apt-get install gettext" >&2
  exit 1
}

# Repo root = parent of this scripts/ dir, regardless of the caller's cwd (so it
# works both as ./scripts/dev-setup.sh and as the ui/ npm "dev:setup" script).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- dev values --------------------------------------------------------------
# PROJECT only labels the local build in 'none' mode; override with SM_DEV_PROJECT.
export PROJECT="${SM_DEV_PROJECT:-scene-machine-local-dev}"
# Firestore DB id the local Flask app talks to. Must match the FIRESTORE_DB_UI
# you pass to Flask. Override with SM_DEV_FIRESTORE_DB.
export FIRESTORE_DB_UI="${SM_DEV_FIRESTORE_DB:-scene-machine-ui}"
export FIRESTORE_DB="${FIRESTORE_DB_UI}"          # config.template.json field
export GCS_BUCKET="${SM_DEV_GCS_BUCKET:-${PROJECT}-scene-machine}"
# The backend pins these cloud params from config.json into every supplyNode
# workflow, so they must render locally too. REGION mirrors deploy's default;
# TASKS_QUEUE_PREFIX is a harmless placeholder — it is unused under LOCAL_WORKER,
# which runs actions in-process rather than scheduling Cloud Tasks.
export REGION="${SM_DEV_REGION:-us-central1}"
export TASKS_QUEUE_PREFIX="${SM_DEV_TASKS_QUEUE_PREFIX:-scene-machine-}"

# No API key in local 'none' mode.
export API_KEY="none"

# The whole point of local dev: the 'none' control-plane arm.
export UI_CONTROL_PLANE_MODE="none"

# --- render (same mechanism as deploy.sh / deploy/libs.sh generate_config) ---
envsubst < "$ROOT/ui/src/env.template.txt"             > "$ROOT/ui/src/env.ts"
envsubst < "$ROOT/ui/definitions/config.template.json" > "$ROOT/ui/definitions/config.json"

echo "Rendered for LOCAL DEV (controlPlaneMode=none, mediated data plane):"
echo "  $ROOT/ui/src/env.ts"
echo "  $ROOT/ui/definitions/config.json"
echo "  PROJECT=$PROJECT  FIRESTORE_DB_UI=$FIRESTORE_DB_UI"
echo
echo "Next: start the local backend and the Angular dev server (see DEVELOPING.md):"
echo "  Terminal 1:  ROLE=app AUTH_MODE=none LOCAL_WORKER=1 FIRESTORE_DB_UI=$FIRESTORE_DB_UI PORT=8080 python3 orch.py"
echo "  Terminal 2:  cd ui && npm run dev"
