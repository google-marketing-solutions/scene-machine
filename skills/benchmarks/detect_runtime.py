#!/usr/bin/env python3
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
"""Deterministic runtime detection (SKILL.md Step 1 rules, TASKS.md section 7.7).

    media_tools  := any tool of kind image_gen AND any tool of kind video_gen
    shell        := any tool of kind shell (aliases: Bash, run_shell_command, shell,
                    exec_command, run_terminal_cmd, run_command, execute_command,
                    run_in_terminal, execute_bash, executeBash, runTerminalCommand,
                    code_execution)
    agent_xfer   := any tool of kind agent_transfer (transfer_to_agent) or a video
                    agent (videogen_agent, gen_video)

    if agent_xfer and not shell: path A
    elif shell and media_tools:  path B
    elif shell:                  path C
    else:                        NONE

``detect(tools)`` implements exactly that. ``resolve(fixture)`` additionally
applies the terminal-state rule of SKILL.md ("without network or ADC produce
the storyboard and the dry-run plan and say that no video was rendered"): a
shell path in a sandbox whose ``filesystem.has_network`` is false resolves to
``NONE`` because nothing beyond the plan can be produced there.

CLI: ``detect_runtime.py <fixture.json> [more.json ...]`` prints one letter per
fixture (the resolved path). ``--capability`` prints the raw ``detect`` result.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

SHELL_ALIASES = frozenset(
  {
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
)
AGENT_TRANSFER_NAMES = frozenset({"transfer_to_agent"})
VIDEO_AGENT_NAMES = frozenset({"videogen_agent", "gen_video"})
PATHS = ("A", "B", "C", "NONE")


def _names_and_kinds(tools: Iterable[dict[str, Any]]) -> tuple[set[str], set[str]]:
  names: set[str] = set()
  kinds: set[str] = set()
  for tool in tools or []:
    if not isinstance(tool, dict):
      continue
    name = tool.get("name")
    kind = tool.get("kind")
    if isinstance(name, str):
      names.add(name)
    if isinstance(kind, str):
      kinds.add(kind)
  return names, kinds


def has_shell(tools: Iterable[dict[str, Any]]) -> bool:
  names, kinds = _names_and_kinds(tools)
  return "shell" in kinds or bool(names & SHELL_ALIASES)


def has_media_tools(tools: Iterable[dict[str, Any]]) -> bool:
  _, kinds = _names_and_kinds(tools)
  return "image_gen" in kinds and "video_gen" in kinds


def has_agent_transfer(tools: Iterable[dict[str, Any]]) -> bool:
  names, kinds = _names_and_kinds(tools)
  return "agent_transfer" in kinds or bool(names & (AGENT_TRANSFER_NAMES | VIDEO_AGENT_NAMES))


def detect(tools: list[dict[str, Any]]) -> str:
  """Returns "A", "B", "C" or "NONE" from the tool manifest alone (section 7.7)."""
  shell = has_shell(tools)
  if has_agent_transfer(tools) and not shell:
    return "A"
  if shell and has_media_tools(tools):
    return "B"
  if shell:
    return "C"
  return "NONE"


def signals(tools: list[dict[str, Any]], filesystem: dict[str, Any] | None = None) -> list[str]:
  """Human-readable detection signals (used by the fixtures and the LLM rubric)."""
  fs = filesystem or {}
  out = [
    "shell-tool-present" if has_shell(tools) else "shell-tool-absent",
    "media-tools-present" if has_media_tools(tools) else "media-tools-absent",
    "agent-transfer-present" if has_agent_transfer(tools) else "agent-transfer-absent",
  ]
  if fs.get("has_network") is False:
    out.append("network-absent")
  if fs.get("has_gcloud_adc") is False:
    out.append("adc-absent")
  return out


def resolve(fixture: dict[str, Any]) -> str:
  """Capability path plus the plan-only terminal state for offline sandboxes."""
  path = detect(fixture.get("tools") or [])
  fs = fixture.get("filesystem") or {}
  if path in ("B", "C") and fs.get("has_network") is False:
    return "NONE"
  return path


def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(
    description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
  )
  ap.add_argument("fixtures", nargs="+", help="runtime fixture JSON file(s)")
  ap.add_argument(
    "--capability",
    action="store_true",
    help="print detect(tools) without the offline terminal-state rule",
  )
  ap.add_argument("--verbose", action="store_true", help="print id, path and signals")
  args = ap.parse_args(argv)
  rc = 0
  for raw in args.fixtures:
    path = Path(raw)
    try:
      fixture = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
      print(f"{path}: cannot read fixture: {exc}", file=sys.stderr)
      rc = 2
      continue
    letter = detect(fixture.get("tools") or []) if args.capability else resolve(fixture)
    if args.verbose:
      sig = ",".join(signals(fixture.get("tools") or [], fixture.get("filesystem")))
      print(f"{fixture.get('id', path.stem)} {letter} {sig}")
    else:
      print(letter)
  return rc


if __name__ == "__main__":
  sys.exit(main())
