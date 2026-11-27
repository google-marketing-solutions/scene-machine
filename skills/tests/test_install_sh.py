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
"""Tests for install.sh (TASKS.md section 7.8): copy by default, targets, --dry-run, --link."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import INSTALL_SH, ROOT, SKILL_DIR, shell_env

GLOBAL_TARGETS = {
  "claude": ".claude/skills/scene-machine",
  "antigravity": ".gemini/antigravity/skills/scene-machine",
  "codex": ".agents/skills/scene-machine",
  "gemini": ".gemini/skills/scene-machine",
  "cursor": ".cursor/skills/scene-machine",
  "windsurf": ".codeium/windsurf/skills/scene-machine",
  "copilot": ".copilot/skills/scene-machine",
  "agents": ".agents/skills/scene-machine",
}
PROJECT_TARGETS = {
  "claude": [".claude/skills/scene-machine"],
  "antigravity": [".agent/skills/scene-machine", ".agents/skills/scene-machine"],
  "codex": [".agents/skills/scene-machine"],
  "gemini": [".gemini/skills/scene-machine"],
  "cursor": [".cursor/skills/scene-machine"],
  "windsurf": [".windsurf/skills/scene-machine"],
  "copilot": [".github/skills/scene-machine"],
  "agents": [".agents/skills/scene-machine"],
}
DRY_RE = re.compile(r"^\[dry-run\] (copy|link) (\S+) -> (\S+)$")


def run_install(
  *args: str, home: Path, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
  full_env = shell_env(HOME=str(home))
  if env:
    full_env.update(env)
  return subprocess.run(
    ["bash", str(INSTALL_SH), *args],
    capture_output=True,
    text=True,
    check=False,
    env=full_env,
    cwd=str(ROOT),
    timeout=120,
  )


def dry_run_lines(stdout: str) -> list[tuple[str, str, str]]:
  out = []
  for line in stdout.splitlines():
    m = DRY_RE.match(line.strip())
    assert m, f"unexpected dry-run line: {line!r}"
    out.append((m.group(1), m.group(2), m.group(3)))
  return out


def test_dry_run_all_lists_every_global_target(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  proc = run_install("--dry-run", "--all", "--home", str(home), home=home)
  assert proc.returncode == 0, proc.stderr
  lines = dry_run_lines(proc.stdout)
  assert lines, proc.stdout
  dests = {d for _, _, d in lines}
  for name, rel in GLOBAL_TARGETS.items():
    assert str(home / rel) in dests, f"{name}: {home / rel} not planned; got {sorted(dests)}"
  assert all(mode == "copy" for mode, _, _ in lines)
  assert all(Path(src).resolve() == SKILL_DIR.resolve() for _, src, _ in lines)
  assert all(os.path.isabs(d) for _, _, d in lines)
  assert not any(home.iterdir()), "--dry-run must not create anything"


def test_dry_run_project_dir_targets(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  project = tmp_path / "proj"
  home.mkdir()
  project.mkdir()
  proc = run_install(
    "--dry-run", "--all", "--home", str(home), "--project-dir", str(project), home=home
  )
  assert proc.returncode == 0, proc.stderr
  dests = {d for _, _, d in dry_run_lines(proc.stdout)}
  for name, rels in PROJECT_TARGETS.items():
    for rel in rels:
      assert str(project / rel) in dests, f"{name}: {project / rel} missing from {sorted(dests)}"
  assert not any(project.iterdir()) and not any(home.iterdir())


def test_codex_home_is_honoured(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  codex_home = tmp_path / "codex_home"
  home.mkdir()
  proc = run_install(
    "--dry-run",
    "--target",
    "codex",
    "--home",
    str(home),
    home=home,
    env={"CODEX_HOME": str(codex_home)},
  )
  assert proc.returncode == 0, proc.stderr
  dests = {d for _, _, d in dry_run_lines(proc.stdout)}
  assert dests == {str(codex_home / "skills" / "scene-machine")}


def test_copy_install_claude_is_a_real_copy(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  proc = run_install("--target", "claude", "--home", str(home), home=home)
  assert proc.returncode == 0, proc.stderr
  dest = home / GLOBAL_TARGETS["claude"]
  assert re.search(rf"^installed {re.escape(str(dest))}$", proc.stdout, re.M), proc.stdout
  assert dest.is_dir() and not dest.is_symlink()
  assert (dest / "SKILL.md").is_file() and not (dest / "SKILL.md").is_symlink()
  assert (dest / "scripts").is_dir()
  assert {p.name for p in (dest / "scripts").iterdir()} >= {
    "assemble_ad_video.py",
    "generate_ad_spot_vertex.py",
  }
  assert (dest / "SKILL.md").read_bytes() == (SKILL_DIR / "SKILL.md").read_bytes()
  assert not list(dest.rglob("__pycache__")) and not list(dest.rglob("*.pyc"))


def test_rerun_is_idempotent_and_refuses_modified_copy_without_force(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  assert run_install("--target", "gemini", "--home", str(home), home=home).returncode == 0
  dest = home / GLOBAL_TARGETS["gemini"]
  again = run_install("--target", "gemini", "--home", str(home), home=home)
  assert again.returncode == 0, again.stderr
  assert str(dest) in again.stdout

  (dest / "SKILL.md").write_text("modified locally\n", encoding="utf-8")
  refused = run_install("--target", "gemini", "--home", str(home), home=home)
  assert refused.returncode == 1, (refused.stdout, refused.stderr)
  assert refused.stderr.strip(), "refusal must explain itself on stderr"
  assert (dest / "SKILL.md").read_text(encoding="utf-8") == "modified locally\n"

  forced = run_install("--target", "gemini", "--home", str(home), "--force", home=home)
  assert forced.returncode == 0, forced.stderr
  assert (dest / "SKILL.md").read_bytes() == (SKILL_DIR / "SKILL.md").read_bytes()


def test_link_creates_symlink(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  proc = run_install("--link", "--target", "cursor", "--home", str(home), home=home)
  assert proc.returncode == 0, proc.stderr
  dest = home / GLOBAL_TARGETS["cursor"]
  assert dest.is_symlink() and dest.resolve() == SKILL_DIR.resolve()
  assert (dest / "SKILL.md").is_file()


@pytest.mark.parametrize("target", ["../evil", "a/b", "/abs", "..", "nope", "CLAUDE"])
def test_invalid_targets_exit_2(tmp_path: Path, target: str) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  proc = run_install("--target", target, "--home", str(home), home=home)
  assert proc.returncode == 2, (proc.stdout, proc.stderr)
  assert proc.stderr.strip()
  assert not any(home.iterdir())


def test_no_target_is_usage_error(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  home.mkdir()
  proc = run_install("--home", str(home), home=home)
  assert proc.returncode == 2


def test_project_dir_install_antigravity_writes_both_dirs(tmp_path: Path) -> None:
  home = tmp_path / "install_home"
  project = tmp_path / "proj"
  home.mkdir()
  project.mkdir()
  proc = run_install(
    "--target", "antigravity", "--home", str(home), "--project-dir", str(project), home=home
  )
  assert proc.returncode == 0, proc.stderr
  for rel in PROJECT_TARGETS["antigravity"]:
    dest = project / rel
    assert (dest / "SKILL.md").is_file() and not dest.is_symlink(), rel
  shutil.rmtree(project)
