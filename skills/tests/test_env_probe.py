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
"""Contract test for scene-machine/scripts/env_probe.py (one JSON object, exit 0)."""

from __future__ import annotations

from pathlib import Path

import pytest

from conftest import ENV_PROBE, SKILL_DIR, SYSTEM_PYTHON, parse_summary, run_py

KEYS = {
  "skill_dir",
  "python",
  "platform",
  "ffmpeg",
  "ffprobe",
  "pillow",
  "google_genai_importable",
  "google_auth_importable",
  "adc_file_present",
  "gcloud_on_path",
  "gcloud_default_project_hint",
  "workdir",
  "workdir_writable",
  "mirror_dir",
  "fonts_found",
  "ready_for_execute",
  "next_step",
}


def test_env_probe_json(tmp_path: Path) -> None:
  proc = run_py(
    ENV_PROBE, ["--json"], env={"SCENE_MACHINE_WORKDIR": str(tmp_path / "wd")}, block_sdk=True
  )
  assert proc.returncode == 0, proc.stderr
  data = parse_summary(proc.stdout)
  assert KEYS <= set(data), sorted(KEYS - set(data))
  assert Path(data["skill_dir"]).resolve() == SKILL_DIR.resolve()
  assert data["google_genai_importable"] is False and data["ready_for_execute"] is False
  assert data["gcloud_on_path"] is False and data["gcloud_default_project_hint"] in ("", None)
  assert data["adc_file_present"] is False
  assert isinstance(data["next_step"], str) and data["next_step"]
  assert "Bearer " not in proc.stdout


def test_env_probe_text_and_default_mode(tmp_path: Path) -> None:
  proc = run_py(
    ENV_PROBE, ["--text"], env={"SCENE_MACHINE_WORKDIR": str(tmp_path / "wd")}, block_sdk=True
  )
  assert proc.returncode == 0, proc.stderr
  assert "ffmpeg" in proc.stdout, proc.stdout
  assert "next_step" in proc.stdout or "next step" in proc.stdout.lower(), proc.stdout
  proc = run_py(ENV_PROBE, [], env={"SCENE_MACHINE_WORKDIR": str(tmp_path / "wd")}, block_sdk=True)
  assert proc.returncode == 0
  parse_summary(proc.stdout)


def test_env_probe_with_system_python(tmp_path: Path) -> None:
  if not Path(SYSTEM_PYTHON).is_file():
    pytest.skip("no system python")
  proc = run_py(
    ENV_PROBE, ["--json"], env={"SCENE_MACHINE_WORKDIR": str(tmp_path / "wd")}, python=SYSTEM_PYTHON
  )
  assert proc.returncode == 0, proc.stderr
  data = parse_summary(proc.stdout)
  assert KEYS <= set(data)
