# Plan: Unified Agent-Friendly and Targeted Deployments

This document outlines the design and implementation plan to combine the Scene Machine backend and frontend deployments into a single unified script (`deploy.sh`), supporting both targeted deployments (backend-only, UI-only, or full stack) and agent-friendly (non-interactive) executions.

---

## 1. Objectives & Benefits
* **Consolidation**: Merge `./deploy.sh` and `./deploy-ui.sh` into a single, clean `./deploy.sh` entry point.
* **Eliminate Duplication**: Remove duplicate code for helper functions (e.g. `add_iam_binding`), tool verification, pre-flight configuration validation, and active project setting.
* **API Enablement Optimization**: Query currently enabled Google Cloud APIs at the start of the script, compute the diff, and only enable missing APIs. This avoids redundant calls to `gcloud services enable` for already enabled services, significantly speeding up subsequent runs.
* **Targeted Deployments**: Introduce flags to deploy only the backend (`--backend-only`), only the UI (`--ui-only`), or the full stack (default).
* **Agent & Human Synergy**: Support a `-y` / `--yes` flag to bypass terminal confirmation prompts, while keeping live status polling loops active. This allows automated agents (like Jetski, Claude, or Antigravity) to orchestrate the deployment while instructing the user to perform any required manual console setup in parallel.

---

## 2. Combined CLI Command Interface

The unified `./deploy.sh` will support the following argument structure:

```bash
Usage: ./deploy.sh [OPTIONS]

Options:
  -y, --yes, --non-interactive   Bypass interactive target confirmation prompts.
  --backend-only, --be-only      Deploy only the backend services (Cloud Run, Gateway, queues, DBs).
  --ui-only                      Deploy only the App Engine UI (builds and deploys Angular app).
  local                          Deploy UI for local development environment (passed through to App Engine bypass).
```

### Argument Parsing Logic:
```bash
AUTO_CONFIRM=false
DEPLOY_BACKEND=true
DEPLOY_UI=true
DEPLOY_MODE=""

# Temporary tracking to see if targeted flags are used
TARGET_BACKEND_ONLY=false
TARGET_UI_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive)
      AUTO_CONFIRM=true
      shift
      ;;
    --backend-only|--be-only)
      TARGET_BACKEND_ONLY=true
      shift
      ;;
    --ui-only)
      TARGET_UI_ONLY=true
      shift
      ;;
    local)
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

# If targeted flags are used, override the defaults
if [ "$TARGET_BACKEND_ONLY" = "true" ] || [ "$TARGET_UI_ONLY" = "true" ]; then
  DEPLOY_BACKEND=false
  DEPLOY_UI=false
  [ "$TARGET_BACKEND_ONLY" = "true" ] && DEPLOY_BACKEND=true
  [ "$TARGET_UI_ONLY" = "true" ] && DEPLOY_UI=true
fi
```

---

## 3. Execution Flows & Dependency Management

A unified script handles the dependencies between backend outputs (e.g. API Gateway Host, API Key) and frontend inputs.

```mermaid
graph TD
    Start[Start ./deploy.sh] --> ParseArgs[Parse CLI Arguments]
    ParseArgs --> PreFlight[Run Combined Pre-Flight Checks]
    
    subgraph Backend Steps
        PreFlight --> CheckAPIs[Check Enabled GCP APIs]
        CheckAPIs -- Diff Missing APIs --> EnableAPIs[Enable Missing APIs]
        CheckAPIs -- No Diff --> DB_Bucket[Setup GCS & Firestore]
        EnableAPIs --> DB_Bucket
        DB_Bucket --> ServiceAccount[Grant SA IAM Roles]
        ServiceAccount --> CloudRun[Build & Deploy Cloud Run]
        CloudRun --> Tasks[Setup Cloud Tasks Queues]
        Tasks --> APIGateway[Provision API Gateway]
        APIGateway --> APIKey[Create/Retrieve API Key]
    end
    
    subgraph UI Steps
        APIKey --> CheckOAuth[Verify OAuth Consent Screen]
        CheckOAuth --> CheckSignIn[Verify Google Sign-In Enablement]
        CheckSignIn --> CheckLinkage[Verify GCS Link to Firebase Storage]
        CheckLinkage --> BuildUI[Compile & Build Angular App]
        BuildUI --> DeployAppEngine[Deploy UI to App Engine]
    end

    Start -- --ui-only --> UI_Start[Fetch API Key/Gateway from GCP]
    UI_Start --> CheckOAuth
```

### A. Pre-flight Checks (Combined)
* Verify required tools: `gcloud`, `firebase`, `node`, `npm`, `envsubst`.
* Validate `config.txt` containing all required variables.
* Confirm target GCP project (interactive or auto-confirmed via `--yes`).

### B. Optimized API Enablement (Backend Step)
Instead of enabling all APIs blindly on every run, the script will:
1. List all currently enabled APIs: `gcloud services list --enabled --project=$PROJECT --format="value(config.name)"`.
2. Compare the list with the required APIs:
   * `aiplatform.googleapis.com`
   * `apigateway.googleapis.com`
   * `artifactregistry.googleapis.com`
   * `cloudbuild.googleapis.com`
   * `cloudtasks.googleapis.com`
   * `compute.googleapis.com`
   * `firestore.googleapis.com`
   * `run.googleapis.com`
   * `servicecontrol.googleapis.com`
   * `iap.googleapis.com`
3. If any required APIs are missing, enable *only* those APIs.
4. If none are missing, skip the call entirely, saving ~20-30 seconds of deployment time.

### C. Backend Deployment Execution (`DEPLOY_BACKEND = true`)
Runs GCS bucket, Firestore DB, Firebase project activation, App Engine app validation, service account role bindings, Cloud Run build & deploy, Cloud Tasks, API Gateway setup, and API Key generation.

### D. UI Deployment Execution (`DEPLOY_UI = true`)
1. **Dependency Resolution**:
   * If `DEPLOY_BACKEND` was run in the same execution, the API Key and API Gateway Host variables are already present in the env.
   * If running with `--ui-only`, the script will query GCP first to retrieve the active `API_KEY` and `API_GATEWAY_HOST` (using `gcloud services api-keys` and `gcloud api-gateway` commands), ensuring self-contained execution.
2. **Firebase Manual Setup Gates (Agent-Friendly Polling)**:
   * **OAuth Consent Screen**: Verify Google IdP config. If missing:
     * In interactive mode: Prompts user to "Press Enter" once configured.
     * In non-interactive mode (`--yes`): Warns the user but bypasses the prompt to avoid blocking.
   * **Google Sign-In Provider**: Verify enablement. If missing, print instruction link and poll/check every 15 seconds.
   * **Firebase Storage Bucket Linkage**: Verify `${GCS_BUCKET}` linkage. If missing, print instruction link and poll/check every 15 seconds.
3. **App Engine UI Deploy**: Compile, build, and deploy the Angular application.

---

## 4. Pressure Testing Assumptions

* **Are the `--backend-only` and `--ui-only` flags mutually exclusive?**
  * *Assumption*: No, they can be run together (equivalent to default behavior). If neither is specified, both are set to true.
* **Can the UI deployment be run stand-alone?**
  * *Assumption*: Yes, provided the backend is already deployed on GCP. The `--ui-only` flow will query GCP to fetch the existing API Key and API Gateway host. If the backend is missing, the query will fail gracefully and the script will exit.
* **How does API listing handle authentication failure?**
  * *Assumption*: If `gcloud services list` fails (e.g. token expired), the script should fall back to the safe, standard behavior of trying to enable the APIs directly (letting gcloud authenticate and prompt the user if needed).
