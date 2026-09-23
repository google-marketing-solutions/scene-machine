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

"""Resolve the immutable image produced by this deployment's Cloud Build.

The build still pushes :latest for the next build's layer cache. Cloud Run gets
the digest from the successful build receipt, so a later :latest push cannot
change which image the worker and app use within this deployment.
"""

import json
import pathlib
import re
import sys
from typing import Any


def build_id(project: str, region: str, log: str) -> str:
  """Read the sole build ID emitted for this project and region."""
  output = pathlib.Path(log).read_text(encoding="utf-8", errors="replace")
  # gcloud 568.0.0 emits this status line. It is not a documented output API,
  # so reject missing or ambiguous lines instead of deploying a mutable tag.
  pattern = re.compile(
      r"^Created \[https://cloudbuild\.googleapis\.com/v1/projects/"
      + re.escape(project)
      + r"/locations/"
      + re.escape(region)
      + r"/builds/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]\.\s*$",
      re.MULTILINE,
  )
  matches = pattern.findall(output)
  if len(matches) != 1:
    raise ValueError(
        "expected exactly one 'Created [https://cloudbuild.googleapis.com/"
        f"v1/projects/{project}/locations/{region}/builds/BUILD_ID].' line "
        "(verified with gcloud 568.0.0). This build was not promoted, "
        "and background infrastructure setup may be incomplete. "
        "Recommended recovery: verify gcloud output and rerun this "
        "idempotent script after updating gcloud or its parser. Manual "
        "recovery requires first verifying/completing every infrastructure "
        "step before the Cloud Run phase in deploy.sh; use only the exact "
        "build ID in this run's unique Cloud Console log URL, and confirm "
        "SUCCESS plus the matching image digest with 'gcloud builds "
        f"describe BUILD_ID --project={project} --region={region} "
        "--format=json'. Then follow all worker, app, invoker, seed and "
        "CORS steps in deploy.sh in order, using the image name without "
        "':latest' plus '@sha256:DIGEST'. If any step cannot be verified, "
        "stop and rerun. Never deploy :latest or guess a build from a list."
    )
  return matches[0]


def digest(image: str, receipt: dict[str, Any]) -> str:
  """Return the exact tagged image digest from a successful build."""
  if not isinstance(receipt, dict):
    raise ValueError("Cloud Build receipt must be an object")
  if receipt.get("status") != "SUCCESS":
    raise ValueError("Cloud Build is not successful")
  results = receipt.get("results")
  if not isinstance(results, dict) or not isinstance(
      results.get("images"), list
  ):
    raise ValueError("Cloud Build receipt has no image results")
  images = results["images"]
  if any(not isinstance(entry, dict) for entry in images):
    raise ValueError("Cloud Build receipt contains an invalid image result")
  matches = [
      entry.get("digest", "") for entry in images if entry.get("name") == image
  ]
  if len(matches) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", matches[0]):
    raise ValueError(
        "expected exactly one valid digest for the requested image"
    )
  return matches[0]


def main() -> int:
  """Resolve one build ID or image digest, failing closed on bad input."""
  try:
    if len(sys.argv) == 5 and sys.argv[1] == "build-id":
      print(build_id(sys.argv[2], sys.argv[3], sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "digest":
      print(digest(sys.argv[2], json.load(sys.stdin)))
    else:
      raise ValueError(
          "usage: resolve_build_image.py build-id PROJECT REGION LOG | digest"
          " IMAGE"
      )
  except (OSError, ValueError, KeyError, TypeError) as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    return 1
  return 0


if __name__ == "__main__":
  sys.exit(main())
