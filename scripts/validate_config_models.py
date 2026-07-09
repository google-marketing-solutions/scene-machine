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

"""Fails the deploy if a configured model/region is not in the allowlist.

deploy.sh runs this after sourcing config.txt and before building the image, so
a model/region typo or an un-allowlisted choice fails loudly at deploy time
instead of only at runtime against Vertex. Exits non-zero on any problem.
"""

import os
import sys
from collections.abc import Mapping

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from util.model_allowlist import load_allowlist  # noqa: E402

# (model env var, region env var, expected family, human label)
_CHECKS = (
    ('GEMINI_MODEL', 'GEMINI_REGION', 'gemini', 'Gemini text'),
    ('IMAGE_MODEL', 'IMAGE_MODEL_REGION', 'image', 'Image'),
    ('VEO_MODEL', 'VEO_REGION', 'veo', 'Veo'),
)


def collect_errors(env: Mapping[str, str], models: dict) -> list[str]:
  """Returns a list of human-readable problems ([] if the config is valid)."""
  errors = []
  for model_var, region_var, family, label in _CHECKS:
    model = env.get(model_var)
    if not model:
      continue  # not configured here
    entry = models.get(model)
    if entry is None:
      errors.append(
          f'{label}: {model_var}={model!r} is not in the allowlist '
          '(ui/definitions/models.json).')
      continue
    if entry.get('family') != family:
      errors.append(
          f'{label}: {model_var}={model!r} is a {entry.get("family")!r} model, '
          f'not {family!r}.')
    region = env.get(region_var)
    locations = entry.get('locations', [])
    if not region:
      # The model is configured but its region is not. A region is required to
      # reach the model, so an empty one is a broken config, not a skip.
      errors.append(
          f'{label}: {model_var}={model!r} is set but {region_var} is empty; '
          'a region is required.')
    elif region not in locations:
      errors.append(
          f'{label}: {region_var}={region!r} is not allowed for {model} '
          f'(allowed: {", ".join(locations) or "none"}).')
  return errors


def main() -> None:
  errors = collect_errors(os.environ, load_allowlist()['models'])
  if errors:
    sys.stderr.write('Model/region config check FAILED:\n')
    for error in errors:
      sys.stderr.write(f'  - {error}\n')
    sys.stderr.write(
        'Fix config.txt, or add the model/region to '
        'ui/definitions/models.json and rebuild.\n')
    sys.exit(1)
  print('✓ Configured models/regions match the allowlist.')


if __name__ == '__main__':
  main()
