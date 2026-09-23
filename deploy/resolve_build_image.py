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


def build_id(project: str, region: str, log: str) -> str:
  output = pathlib.Path(log).read_text(encoding="utf-8", errors="replace")
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
    raise ValueError("expected exactly one Cloud Build ID for this project and region")
  return matches[0]


def digest(image: str, receipt: dict) -> str:
  if not isinstance(receipt, dict):
    raise ValueError("Cloud Build receipt must be an object")
  if receipt.get("status") != "SUCCESS":
    raise ValueError("Cloud Build is not successful")
  results = receipt.get("results")
  if not isinstance(results, dict) or not isinstance(results.get("images"), list):
    raise ValueError("Cloud Build receipt has no image results")
  images = results["images"]
  if any(not isinstance(entry, dict) for entry in images):
    raise ValueError("Cloud Build receipt contains an invalid image result")
  matches = [entry.get("digest", "") for entry in images if entry.get("name") == image]
  if len(matches) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", matches[0]):
    raise ValueError("expected exactly one valid digest for the requested image")
  return matches[0]


def main() -> int:
  try:
    if len(sys.argv) == 5 and sys.argv[1] == "build-id":
      print(build_id(sys.argv[2], sys.argv[3], sys.argv[4]))
    elif len(sys.argv) == 3 and sys.argv[1] == "digest":
      print(digest(sys.argv[2], json.load(sys.stdin)))
    else:
      raise ValueError("usage: resolve_build_image.py build-id PROJECT REGION LOG | digest IMAGE")
  except (OSError, ValueError, KeyError, TypeError) as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    return 1
  return 0


if __name__ == "__main__":
  sys.exit(main())
