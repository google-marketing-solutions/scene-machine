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
"""Table-driven runtime-detection eval (BENCHMARK_DESIGN part iv).

Every fixture under benchmarks/runtime_fixtures/ must validate against
fixture.schema.json, resolve to its ``expected_path`` with the deterministic
rules of TASKS.md section 7.7 (benchmarks/detect_runtime.py), and the alias
table in scene-machine/references/runtimes.md must list every alias the rules
know about (so SKILL.md, the reference and the code cannot drift apart).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import jsonschema
import pytest

import detect_runtime
from benchmarks.skill_lint import INTERNAL_PATTERNS
from conftest import BENCH_DIR, ROOT, SKILL_DIR, require_file, run_py

FIXTURE_DIR = BENCH_DIR / "runtime_fixtures"
SCHEMA_PATH = FIXTURE_DIR / "fixture.schema.json"
RUNTIMES_MD = SKILL_DIR / "references" / "runtimes.md"
EXPECTED_IDS = {
  "rt-claude-code",
  "rt-antigravity-ide",
  "rt-antigravity-managed-agent",
  "rt-codex-cli",
  "rt-codex-cloud-no-network",
  "rt-gemini-cli",
  "rt-cursor",
  "rt-windsurf",
  "rt-copilot-vscode",
  "rt-copilot-coding-agent",
  "rt-cline",
  "rt-roo",
  "rt-kiro",
  "rt-openhands",
  "rt-gemini-enterprise-webchat",
}
UNVERIFIED_EXPECTED = {
  "rt-antigravity-ide",
  "rt-antigravity-managed-agent",
  "rt-cursor",
  "rt-copilot-vscode",
  "rt-cline",
  "rt-roo",
  "rt-kiro",
  "rt-gemini-enterprise-webchat",
}


def fixture_paths() -> list[Path]:
  return sorted(p for p in FIXTURE_DIR.glob("rt-*.json"))


def load(path: Path) -> dict:
  return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def schema() -> dict:
  return load(SCHEMA_PATH)


def test_fifteen_fixtures_present() -> None:
  ids = {load(p)["id"] for p in fixture_paths()}
  assert ids == EXPECTED_IDS, sorted(ids ^ EXPECTED_IDS)
  assert len(fixture_paths()) == 15


@pytest.mark.parametrize("path", fixture_paths(), ids=lambda p: p.stem)
def test_fixture_validates_against_schema(path: Path, schema: dict) -> None:
  fixture = load(path)
  jsonschema.validate(fixture, schema, cls=jsonschema.Draft202012Validator)
  assert fixture["id"] == path.stem
  assert fixture["notes"].strip()
  assert fixture["expected_first_action"].strip()


@pytest.mark.parametrize("path", fixture_paths(), ids=lambda p: p.stem)
def test_expected_path_matches_rules(path: Path) -> None:
  fixture = load(path)
  assert detect_runtime.resolve(fixture) == fixture["expected_path"], fixture["id"]
  capability = fixture.get("expected_capability_path", fixture["expected_path"])
  assert detect_runtime.detect(fixture["tools"]) == capability, fixture["id"]
  if fixture["expected_path"] == "NONE" and capability != "NONE":
    assert fixture["filesystem"].get("has_network") is False
    assert "network-absent" in fixture["expected_detection_signals"]


@pytest.mark.parametrize("path", fixture_paths(), ids=lambda p: p.stem)
def test_detection_signals_are_consistent(path: Path) -> None:
  fixture = load(path)
  computed = set(detect_runtime.signals(fixture["tools"], fixture.get("filesystem")))
  declared = set(fixture["expected_detection_signals"])
  assert declared == computed, (
    f"{fixture['id']}: declared {sorted(declared)} computed {sorted(computed)}"
  )


@pytest.mark.parametrize("path", fixture_paths(), ids=lambda p: p.stem)
def test_unverified_flags_and_no_internal_refs(path: Path) -> None:
  fixture = load(path)
  text = json.dumps(fixture)
  if fixture["id"] in UNVERIFIED_EXPECTED:
    assert "UNVERIFIED" in text, f"{fixture['id']} must carry its UNVERIFIED flags in notes"
  for pat, label in INTERNAL_PATTERNS:
    assert not pat.search(text), f"{fixture['id']}: internal reference {label} ({pat.pattern!r})"


def test_rules_verbatim_section_7_7() -> None:
  shell = [{"name": "Bash", "kind": "shell"}]
  media = [{"name": "image_tool", "kind": "image_gen"}, {"name": "video_tool", "kind": "video_gen"}]
  xfer = [{"name": "transfer_to_agent", "kind": "agent_transfer"}]
  assert detect_runtime.detect(xfer) == "A"
  assert detect_runtime.detect(xfer + shell) == "C", "shell wins over agent transfer"
  assert detect_runtime.detect(shell + media) == "B"
  assert detect_runtime.detect(shell + media[:1]) == "C", "image_gen alone is not media_tools"
  assert detect_runtime.detect(shell) == "C"
  assert detect_runtime.detect([]) == "NONE"
  assert detect_runtime.detect([{"name": "Read", "kind": "file_read"}]) == "NONE"
  assert detect_runtime.detect([{"name": "videogen_agent", "kind": "other"}]) == "A"
  assert detect_runtime.detect([{"name": "gen_video", "kind": "other"}]) == "A"


@pytest.mark.parametrize("alias", sorted(detect_runtime.SHELL_ALIASES))
def test_every_alias_counts_as_shell(alias: str) -> None:
  assert detect_runtime.detect([{"name": alias, "kind": "other"}]) == "C"


def test_alias_table_matches_section_7_7() -> None:
  assert detect_runtime.SHELL_ALIASES == {
    "Bash",
    "run_shell_command",
    "shell",
    "exec_command",
    "run_terminal_cmd",
    "run_command",
    "execute_command",
    "run_in_terminal",
    "execute_bash",
    "executeBash",
    "runTerminalCommand",
    "code_execution",
  }
  assert detect_runtime.VIDEO_AGENT_NAMES == {"videogen_agent", "gen_video"}


def test_cli_prints_letter_for_claude_code() -> None:
  proc = run_py(BENCH_DIR / "detect_runtime.py", [str(FIXTURE_DIR / "rt-claude-code.json")])
  assert proc.returncode == 0, proc.stderr
  assert proc.stdout.strip() == "C"
  proc = run_py(
    BENCH_DIR / "detect_runtime.py", [str(FIXTURE_DIR / "rt-gemini-enterprise-webchat.json")]
  )
  assert proc.stdout.strip() == "A"
  proc = run_py(
    BENCH_DIR / "detect_runtime.py", [str(FIXTURE_DIR / "rt-codex-cloud-no-network.json")]
  )
  assert proc.stdout.strip() == "NONE"
  proc = run_py(
    BENCH_DIR / "detect_runtime.py",
    ["--capability", str(FIXTURE_DIR / "rt-codex-cloud-no-network.json")],
  )
  assert proc.stdout.strip() == "C"


def test_cli_rejects_unreadable_fixture(tmp_path: Path) -> None:
  proc = subprocess.run(
    [sys.executable, str(BENCH_DIR / "detect_runtime.py"), str(tmp_path / "missing.json")],
    capture_output=True,
    text=True,
    check=False,
  )
  assert proc.returncode == 2 and "cannot read" in proc.stderr


def test_runtimes_reference_lists_every_alias() -> None:
  require_file(str(RUNTIMES_MD.relative_to(ROOT)))
  text = RUNTIMES_MD.read_text(encoding="utf-8")
  missing = [a for a in sorted(detect_runtime.SHELL_ALIASES) if a not in text]
  assert not missing, f"references/runtimes.md lacks shell aliases: {missing}"
  for name in ("transfer_to_agent", "videogen_agent", "gen_video"):
    assert name in text, name
  for env_name in (
    "Claude Code",
    "Antigravity",
    "Codex",
    "Gemini CLI",
    "Cursor",
    "Windsurf",
    "Copilot",
  ):
    assert env_name in text, env_name


def test_skill_md_describes_capability_detection() -> None:
  skill_md = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
  assert "references/runtimes.md" in skill_md
  assert "<SKILL_DIR>" in skill_md
