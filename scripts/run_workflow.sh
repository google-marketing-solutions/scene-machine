#!/bin/bash
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

# A script to easily run local workflows via cli.py utilizing envsubst.

set -e

main() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <workflow_json_file>" >&2
    exit 1
  fi

  local workflow_file="$1"
  if [[ ! -f "${workflow_file}" ]]; then
    echo "Error: file '${workflow_file}' not found." >&2
    exit 1
  fi

  # Source the environment variables
  if [[ ! -f "config.txt" ]]; then
    echo "Error: config.txt not found." >&2
    exit 1
  fi
  source "config.txt"

  # Export the cloud project to let Firestore Client discover it
  export GOOGLE_CLOUD_PROJECT="${PROJECT}"

  # Add Homebrew path for envsubst on Mac
  if [[ "$(uname)" == "Darwin" ]]; then
    export PATH="/opt/homebrew/bin:${PATH}"
  fi

  # Execute the remix-engine locally
  python3 cli.py --e <(envsubst < "${workflow_file}")
}


main "$@"
