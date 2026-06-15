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
