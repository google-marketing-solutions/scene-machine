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
"""Environment probe for the scene-machine skill (first tool call, Path C).

Prints one JSON object (default) or a text table (--text) that describes the
prerequisites of the Vertex AI path: the skill directory, Python, ffmpeg and
ffprobe, Pillow and google-genai importability, application default
credentials, the gcloud default project (a hint only, never used for billing),
the work directory and the fonts available for overlays.

Standard library only. Never imports Pillow or google-genai, never prints
secrets, never makes a network call, and always exits 0 so that an agent can
read the result even on a minimal machine.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Any

SUBPROCESS_TIMEOUT_SECONDS = 5

FONT_CANDIDATES = (
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:/Windows/Fonts/arialbd.ttf",
)


def find_skill_dir() -> Path:
  """Returns the directory that contains SKILL.md (resolved from __file__)."""
  here = Path(__file__).resolve().parent
  for candidate in (here, *here.parents):
    if (candidate / "SKILL.md").is_file():
      return candidate
  return here.parent


def tool_version(name: str) -> str | None:
  """Returns the first line of `<name> -version`, or None when not on PATH."""
  exe = shutil.which(name)
  if not exe:
    return None
  try:
    proc = subprocess.run(
      [exe, "-version"],
      capture_output=True,
      text=True,
      timeout=SUBPROCESS_TIMEOUT_SECONDS,
      check=False,
    )
  except (OSError, subprocess.SubprocessError):
    return None
  lines = (proc.stdout or proc.stderr or "").strip().splitlines()
  return lines[0].strip() if lines else f"{name} (version unknown)"


def module_importable(name: str) -> bool:
  """True when importlib can locate the module; never raises."""
  try:
    return importlib.util.find_spec(name) is not None
  except (ImportError, AttributeError, ValueError, TypeError):
    # Missing parent package, invalid name or a broken finder.
    return False


def adc_file_present() -> bool:
  """True when an application-default-credentials file exists."""
  env_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
  if env_path and Path(env_path).expanduser().is_file():
    return True
  candidates = []
  try:
    candidates.append(Path.home() / ".config" / "gcloud" / "application_default_credentials.json")
  except (RuntimeError, OSError):
    pass
  appdata = os.environ.get("APPDATA")
  if appdata:
    candidates.append(Path(appdata) / "gcloud" / "application_default_credentials.json")
  return any(p.is_file() for p in candidates)


def gcloud_default_project_hint() -> str:
  """Returns `gcloud config get-value project` or "" on any failure."""
  exe = shutil.which("gcloud")
  if not exe:
    return ""
  env = dict(os.environ, CLOUDSDK_CORE_DISABLE_PROMPTS="1")
  try:
    proc = subprocess.run(
      [exe, "config", "get-value", "project"],
      capture_output=True,
      text=True,
      timeout=SUBPROCESS_TIMEOUT_SECONDS,
      check=False,
      env=env,
    )
  except (OSError, subprocess.SubprocessError):
    return ""
  if proc.returncode != 0:
    return ""
  value = (proc.stdout or "").strip()
  if not value or value.startswith("("):  # "(unset)"
    return ""
  return value


def probe_workdir() -> tuple[str, bool]:
  """Resolves ${SCENE_MACHINE_WORKDIR:-./.scene_machine} and tests writes."""
  raw = os.environ.get("SCENE_MACHINE_WORKDIR") or "./.scene_machine"
  workdir = Path(raw).expanduser().resolve()
  try:
    workdir.mkdir(parents=True, exist_ok=True)
    marker = workdir / ".env_probe_write_test"
    marker.write_text("ok", encoding="utf-8")
    marker.unlink()
    writable = True
  except OSError:
    writable = False
  return str(workdir), writable


def next_step(info: dict[str, Any]) -> str:
  """One sentence telling the agent what to do next."""
  dry_run = f"python3 {info['skill_dir']}/scripts/generate_ad_spot_vertex.py --storyboard <path>"
  missing = []
  if not (info["ffmpeg"] and info["ffprobe"]):
    missing.append("ffmpeg and ffprobe from the OS package manager")
  pip_packages = []
  if not info["pillow"]:
    pip_packages.append("pillow")
  if not info["google_genai_importable"]:
    pip_packages.append("google-genai")
  if pip_packages:
    missing.append("pip install " + " ".join(pip_packages))
  if missing:
    return (
      "Install the missing prerequisites ("
      + "; ".join(missing)
      + "), then write the storyboard and run the dry-run: "
      + dry_run
      + "."
    )
  if not info["adc_file_present"]:
    return (
      "Write the storyboard and run the dry-run ("
      + dry_run
      + "); without application default credentials this environment is"
      " plan-only and no video can be rendered until"
      " `gcloud auth application-default login` has been run here."
    )
  return (
    "Write the storyboard and run the dry-run ("
    + dry_run
    + "); add `--execute --project <id>` only when the user asked for the"
    " video and named or configured a Google Cloud project."
  )


def collect() -> dict[str, Any]:
  """Gathers every probe value into one JSON-serialisable dict."""
  workdir, writable = probe_workdir()
  info: dict[str, Any] = {
    "skill_dir": str(find_skill_dir()),
    "python": platform.python_version(),
    "platform": platform.platform(),
    "ffmpeg": tool_version("ffmpeg"),
    "ffprobe": tool_version("ffprobe"),
    "pillow": module_importable("PIL"),
    "google_genai_importable": module_importable("google.genai"),
    "google_auth_importable": module_importable("google.auth"),
    "adc_file_present": adc_file_present(),
    "gcloud_on_path": shutil.which("gcloud") is not None,
    "gcloud_default_project_hint": gcloud_default_project_hint(),
    "workdir": workdir,
    "workdir_writable": writable,
    "mirror_dir": os.environ.get("SCENE_MACHINE_MIRROR_DIR") or None,
    "fonts_found": [p for p in FONT_CANDIDATES if Path(p).is_file()],
  }
  info["ready_for_execute"] = bool(
    info["ffmpeg"]
    and info["ffprobe"]
    and info["pillow"]
    and info["google_genai_importable"]
    and info["adc_file_present"]
  )
  info["next_step"] = next_step(info)
  return info


def format_text(info: dict[str, Any]) -> str:
  """Human-readable two-column table."""
  rows = []
  for key, value in info.items():
    if value is None:
      text = "null"
    elif isinstance(value, bool):
      text = "true" if value else "false"
    elif isinstance(value, list):
      text = ", ".join(str(v) for v in value) if value else "(none)"
    else:
      text = str(value)
    rows.append(f"{key:<28} {text}")
  return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(
    description="Print the scene-machine environment probe (exit code 0)."
  )
  mode = parser.add_mutually_exclusive_group()
  mode.add_argument("--json", action="store_true", help="JSON output (default).")
  mode.add_argument("--text", action="store_true", help="Human-readable table.")
  args = parser.parse_args(argv)
  try:
    info = collect()
  except (OSError, RuntimeError, ValueError, TypeError, KeyError) as exc:
    # The probe must never fail the caller: report and still exit 0.
    info = {
      "error": f"probe_failed: {type(exc).__name__}: {exc}",
      "skill_dir": str(Path(__file__).resolve().parent.parent),
      "ready_for_execute": False,
      "next_step": (
        "The probe hit an unexpected error; check ffmpeg, Pillow,"
        " google-genai and credentials manually, then run the dry-run."
      ),
    }
  if args.text:
    print(format_text(info))
  else:
    print(json.dumps(info, indent=2))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
