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

"""Keep clean test installs aligned with the runtime dependency lock."""

from pathlib import Path
import re


def test_dev_lock_includes_every_runtime_pin() -> None:
  root = Path(__file__).resolve().parents[1]
  pin_pattern = r'^([\w.-]+)(?:\[[^\]]+\])?==([^\s;]+)'
  runtime = set(
      re.findall(
          pin_pattern,
          (root / 'requirements.txt').read_text(encoding='utf-8'),
          re.MULTILINE,
      )
  )
  development = set(
      re.findall(
          pin_pattern,
          (root / 'requirements-dev.txt').read_text(encoding='utf-8'),
          re.MULTILINE,
      )
  )

  assert runtime
  assert runtime <= development, (
      'Regenerate requirements-dev.txt after changing runtime dependencies: '
      f'{sorted(runtime - development)}'
  )
