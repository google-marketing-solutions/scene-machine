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
"""Scene Machine media generator for Vertex AI - dry-run by default.

Flow: parse args -> model registry check -> explicit project check (--execute
only) -> load and validate the storyboard -> print the plan. In dry-run mode
(the default) the script stops there with ``{"status":"dry_run",...}`` and
never imports google-genai or google-auth. With ``--execute`` it generates
keyframes, clips, the voiceover and the music bed through the adapters in
``media_backend.py`` (per-shot failure isolation, retries, poll timeout and a
checkpoint in ``work/storyboard_resolved.json`` after every asset) and then
runs ``assemble_ad_video.py render`` as a streamed subprocess.

Exit codes: 0 ok / dry-run, 2 usage, 3 missing input, 4 dependency missing or
tool failed, 5 invalid storyboard, 6 output verification failed (assembler),
7 partial media generation failure (resumable), 1 unexpected internal error.
Errors are one JSON line on stderr: {"error": ..., "message": ..., "hint": ...}.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

VERSION = "2.1.0"
SCRIPT_DIR = Path(__file__).resolve().parent
REGISTRY_PATH = SCRIPT_DIR / "model_registry.json"
ASSEMBLER_PATH = SCRIPT_DIR / "assemble_ad_video.py"

KINDS = ("image", "video", "tts", "music")
DEFAULT_MODELS = {
  "image": "gemini-3.1-flash-image",
  "video": "veo-3.1-fast-generate-001",
  "tts": "gemini-2.5-flash-tts",
  "music": "lyria-002",
}
DEFAULT_UNIT_NOTES = {
  "image": "per image",
  "video": "per second of video",
  "tts": "per text token and second of output audio",
  "music": "per generated clip",
}
SELECTABLE_STATUSES = ("active", "preview")
ALLOWED_DURATIONS = (4, 6, 8)
ALLOWED_ASPECTS = ("16:9", "9:16")
SQUARE_HINT = (
  "1:1 is produced as a crop of the 9:16 render: set aspectRatio 9:16 and exportSquareCrop true"
)
MIN_SHOTS, MAX_SHOTS = 2, 6
VOICEOVER_MIN_WORDS, VOICEOVER_MAX_WORDS = 50, 65
LANGUAGE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
GCLOUD_TIMEOUT_SECONDS = 5.0

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_USAGE = 2
EXIT_MISSING_INPUT = 3
EXIT_DEPENDENCY = 4
EXIT_INVALID_STORYBOARD = 5
EXIT_VERIFICATION = 6
EXIT_PARTIAL = 7


# ---------------------------------------------------------------------------
# Structured errors and output helpers
# ---------------------------------------------------------------------------
class CliError(Exception):
  """A failure reported as one JSON line on stderr plus an exit code."""

  def __init__(self, exit_code: int, error: str, message: str, **extra: Any):
    super().__init__(message)
    self.exit_code = exit_code
    self.error = error
    self.message = message
    self.extra = {k: v for k, v in extra.items() if v is not None}


def invalid_storyboard(message: str, shot_index: Any = None, hint: str | None = None) -> CliError:
  return CliError(
    EXIT_INVALID_STORYBOARD, "invalid_storyboard", message, shotIndex=shot_index, hint=hint
  )


def one_line(text: Any, limit: int = 600) -> str:
  flat = " ".join(str(text).split())
  return flat if len(flat) <= limit else flat[: limit - 3] + "..."


def emit_json_line(payload: dict[str, Any], stream: Any = None) -> None:
  print(json.dumps(payload), file=stream or sys.stdout, flush=True)


def emit_error(error: str, message: str, **extra: Any) -> None:
  payload: dict[str, Any] = {"error": error, "message": message}
  payload.update({k: v for k, v in extra.items() if v is not None})
  emit_json_line(payload, sys.stderr)


def emit_warning(warning: str, message: str, **extra: Any) -> None:
  payload: dict[str, Any] = {"warning": warning, "message": message}
  payload.update({k: v for k, v in extra.items() if v is not None})
  emit_json_line(payload, sys.stderr)


def log(message: str) -> None:
  print(f"[scene-machine] {message}", file=sys.stderr, flush=True)


def debug_enabled() -> bool:
  return os.environ.get("SCENE_MACHINE_DEBUG", "").strip() == "1"


# ---------------------------------------------------------------------------
# Prerequisites (data only - no SDK import)
# ---------------------------------------------------------------------------
def tool_version(name: str) -> str | None:
  """First version line of `name -version`, the path if unparseable, None if absent."""
  exe = shutil.which(name)
  if not exe:
    return None
  try:
    proc = subprocess.run(
      [exe, "-version"], capture_output=True, text=True, timeout=10, check=False
    )
  except (OSError, subprocess.SubprocessError):
    return exe
  lines = (proc.stdout or proc.stderr or "").strip().splitlines()
  return lines[0].strip() if lines else exe


def module_importable(name: str) -> bool:
  """importlib.util.find_spec() guarded; honours sys.modules stubs (None -> False)."""
  if name in sys.modules:
    return sys.modules[name] is not None
  try:
    return importlib.util.find_spec(name) is not None
  except Exception:  # ValueError / ModuleNotFoundError for broken parents
    return False


def adc_file_present() -> bool:
  env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
  if env:
    return Path(env).expanduser().is_file()
  candidates = []
  config_dir = os.environ.get("CLOUDSDK_CONFIG", "").strip()
  if config_dir:
    candidates.append(Path(config_dir).expanduser())
  candidates.append(Path.home() / ".config" / "gcloud")
  appdata = os.environ.get("APPDATA", "").strip()
  if appdata:
    candidates.append(Path(appdata) / "gcloud")
  return any((d / "application_default_credentials.json").is_file() for d in candidates)


def gcloud_default_project_hint(timeout: float = GCLOUD_TIMEOUT_SECONDS) -> str:
  """`gcloud config get-value project` for display only; any failure -> ''."""
  exe = shutil.which("gcloud")
  if not exe:
    return ""
  try:
    proc = subprocess.run(
      [exe, "config", "get-value", "project"],
      capture_output=True,
      text=True,
      timeout=timeout,
      check=False,
    )
  except (OSError, subprocess.SubprocessError):
    return ""
  if proc.returncode != 0:
    return ""
  lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
  value = lines[-1] if lines else ""
  return "" if value.lower() in ("", "(unset)") else value


def collect_prerequisites(gcloud_hint: str | None = None) -> dict[str, Any]:
  return {
    "ffmpeg": tool_version("ffmpeg"),
    "ffprobe": tool_version("ffprobe"),
    "pillow": module_importable("PIL"),
    "google_genai_importable": module_importable("google.genai"),
    "adc_file_present": adc_file_present(),
    "gcloud_default_project_hint": (
      gcloud_hint if gcloud_hint is not None else gcloud_default_project_hint()
    ),
  }


def resolve_project(flag_value: str | None) -> tuple[str, str]:
  """--project -> 'flag'; GOOGLE_CLOUD_PROJECT -> 'env'; otherwise ('', 'none')."""
  if flag_value and flag_value.strip():
    return flag_value.strip(), "flag"
  env = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
  if env:
    return env, "env"
  return "", "none"


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------
def load_registry(path: Path = REGISTRY_PATH) -> dict[str, Any]:
  try:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
  except FileNotFoundError:
    raise CliError(
      EXIT_DEPENDENCY, "dependency_missing", f"model registry not found: {path}"
    ) from None
  except (OSError, ValueError) as exc:
    raise CliError(
      EXIT_DEPENDENCY, "dependency_missing", f"model registry unreadable: {path}: {exc}"
    ) from None
  if not isinstance(data, dict) or not isinstance(data.get("models"), list):
    raise CliError(EXIT_DEPENDENCY, "dependency_missing", f"model registry malformed: {path}")
  return data


def selectable_ids(registry: dict[str, Any], kind: str) -> list[str]:
  return [
    str(m.get("id"))
    for m in registry["models"]
    if m.get("kind") == kind and m.get("status") in SELECTABLE_STATUSES
  ]


def resolve_model(registry: dict[str, Any], kind: str, model_id: str) -> dict[str, Any]:
  """Returns the registry entry or raises a usage error (exit 2) listing allowed ids."""
  flag = f"--{kind}-model"
  allowed = selectable_ids(registry, kind)
  entry = next(
    (m for m in registry["models"] if m.get("id") == model_id and m.get("kind") == kind), None
  )
  if entry is None:
    other = next((m for m in registry["models"] if m.get("id") == model_id), None)
    detail = f" (it is registered as a {other.get('kind')} model)" if other else ""
    raise CliError(
      EXIT_USAGE,
      "usage",
      f"unknown {kind} model '{model_id}' for {flag}{detail}; allowed: {', '.join(allowed)}",
      flag=flag,
      allowed=allowed,
      hint="run --list-models to see the registry",
    )
  status = entry.get("status")
  if status == "retired":
    replacement = entry.get("replacement")
    since = f" since {entry['retired_on']}" if entry.get("retired_on") else ""
    use = f"; use '{replacement}'" if replacement else ""
    raise CliError(
      EXIT_USAGE,
      "usage",
      f"{kind} model '{model_id}' is retired{since}{use}; allowed: {', '.join(allowed)}",
      flag=flag,
      allowed=allowed,
      replacement=replacement,
      hint=f"pass {flag} {replacement}" if replacement else None,
    )
  if status not in SELECTABLE_STATUSES:
    raise CliError(
      EXIT_USAGE,
      "usage",
      f"{kind} model '{model_id}' has status '{status}' (api: {entry.get('api')}) and "
      f"cannot be selected; allowed: {', '.join(allowed)}",
      flag=flag,
      allowed=allowed,
      hint=entry.get("notes"),
    )
  return entry


def print_model_table(registry: dict[str, Any]) -> None:
  headers = ("id", "kind", "api", "status", "default", "locations", "last_verified", "replacement")
  rows = []
  for m in registry["models"]:
    rows.append(
      (
        str(m.get("id", "")),
        str(m.get("kind", "")),
        str(m.get("api", "")),
        str(m.get("status", "")),
        "yes" if m.get("default") else "",
        ",".join(m.get("locations") or []) or "-",
        str(m.get("last_verified") or "-"),
        str(m.get("replacement") or "-"),
      )
    )
  widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
  print(
    f"model_registry.json version {registry.get('version')} "
    f"(last_verified {registry.get('last_verified')}); selectable statuses: "
    + ", ".join(SELECTABLE_STATUSES)
  )
  print(" | ".join(h.ljust(w) for h, w in zip(headers, widths)).rstrip())
  print("-+-".join("-" * w for w in widths))
  for r in rows:
    print(" | ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip())


# ---------------------------------------------------------------------------
# Storyboard loading, validation and plan
# ---------------------------------------------------------------------------
def file_exists(value: Any) -> bool:
  return isinstance(value, str) and bool(value.strip()) and Path(value).expanduser().is_file()


def normalize_duration(value: Any) -> int | None:
  """4/6/8 as int or integral float -> int; anything else -> None."""
  if isinstance(value, bool):
    return None
  if isinstance(value, int):
    return value if value in ALLOWED_DURATIONS else None
  if isinstance(value, float) and value.is_integer():
    return int(value) if int(value) in ALLOWED_DURATIONS else None
  return None


def load_storyboard(path_text: str) -> dict[str, Any]:
  path = Path(path_text).expanduser()
  if not path.is_file():
    raise CliError(EXIT_MISSING_INPUT, "missing_input", f"storyboard not found: {path}")
  try:
    text = path.read_text(encoding="utf-8")
  except (OSError, UnicodeDecodeError) as exc:
    raise CliError(
      EXIT_INVALID_STORYBOARD, "invalid_storyboard", f"storyboard unreadable: {path}: {exc}"
    ) from None
  try:
    data = json.loads(text)
  except ValueError as exc:
    raise invalid_storyboard(f"storyboard is not valid JSON ({one_line(exc, 160)}): {path}")
  if not isinstance(data, dict):
    raise invalid_storyboard("storyboard must be a JSON object")
  return data


def audio_spec(storyboard: dict[str, Any]) -> dict[str, Any]:
  audio = storyboard.get("audioSpec")
  return audio if isinstance(audio, dict) else {}


def voiceover_script(audio: dict[str, Any]) -> str:
  script = audio.get("voiceoverScript")
  return script.strip() if isinstance(script, str) else ""


def music_prompt(audio: dict[str, Any]) -> str:
  prompt = audio.get("musicPrompt")
  return prompt.strip() if isinstance(prompt, str) else ""


def needs_image(shot: dict[str, Any]) -> bool:
  return not file_exists(shot.get("keyframeFile"))


def needs_video(shot: dict[str, Any]) -> bool:
  return not file_exists(shot.get("clipFile"))


def needs_tts(audio: dict[str, Any]) -> bool:
  return bool(voiceover_script(audio)) and not file_exists(audio.get("voiceoverFile"))


def needs_music(audio: dict[str, Any]) -> bool:
  return bool(music_prompt(audio)) and not file_exists(audio.get("musicFile"))


def validate_storyboard(
  storyboard: dict[str, Any], strict_copy: bool = True
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
  """Validates before any call; returns (validation summary, warnings) or raises exit 5."""
  shots = storyboard.get("shots")
  if not isinstance(shots, list) or not shots:
    raise invalid_storyboard(
      f"storyboard needs a non-empty shots array ({MIN_SHOTS}..{MAX_SHOTS} shots)"
    )
  if not MIN_SHOTS <= len(shots) <= MAX_SHOTS:
    raise invalid_storyboard(
      f"shots must contain {MIN_SHOTS}..{MAX_SHOTS} entries, got {len(shots)}"
    )
  aspect = storyboard.get("aspectRatio")
  if aspect == "1:1":
    raise invalid_storyboard(
      "aspectRatio 1:1 cannot be generated directly (Veo 3.1 renders 16:9 or 9:16)",
      hint=SQUARE_HINT,
    )
  if aspect not in ALLOWED_ASPECTS:
    raise invalid_storyboard(
      f"aspectRatio must be one of {', '.join(ALLOWED_ASPECTS)} (got {aspect!r})"
    )

  durations: list[int] = []
  seen: set[int] = set()
  for position, shot in enumerate(shots, start=1):
    if not isinstance(shot, dict):
      raise invalid_storyboard(f"shot #{position} must be an object")
    idx = shot.get("shotIndex")
    if isinstance(idx, bool) or not isinstance(idx, int) or idx < 1:
      raise invalid_storyboard(
        f"shot #{position}: shotIndex must be a positive integer (got {idx!r})"
      )
    if idx in seen:
      raise invalid_storyboard(f"shotIndex {idx} is used more than once", shot_index=idx)
    seen.add(idx)
    for key in ("visualPrompt", "motionPrompt"):
      value = shot.get(key)
      if not isinstance(value, str) or not value.strip():
        raise invalid_storyboard(f"shot {idx}: {key} must be a non-empty string", shot_index=idx)
    duration = normalize_duration(shot.get("durationSeconds"))
    if duration is None:
      raise invalid_storyboard(
        f"shot {idx}: durationSeconds must be 4, 6 or 8 (got {shot.get('durationSeconds')!r})",
        shot_index=idx,
        hint="Veo 3.1 renders 4, 6 or 8 second clips",
      )
    durations.append(duration)

  language = storyboard.get("language")
  if language is not None:
    if not isinstance(language, str) or not LANGUAGE_RE.match(language):
      raise invalid_storyboard(
        f"language must be a BCP-47 tag such as en-US or de-DE (got {language!r})"
      )

  audio_raw = storyboard.get("audioSpec")
  if audio_raw is not None and not isinstance(audio_raw, dict):
    raise invalid_storyboard("audioSpec must be an object")
  audio = audio_spec(storyboard)
  warnings: list[dict[str, Any]] = []

  script = voiceover_script(audio)
  voiceover_words = len(script.split()) if script else None
  if not script and audio.get("voiceoverFile") and not file_exists(audio.get("voiceoverFile")):
    raise CliError(
      EXIT_MISSING_INPUT,
      "missing_input",
      f"audioSpec.voiceoverFile not found and no voiceoverScript to regenerate it: "
      f"{audio.get('voiceoverFile')}",
    )
  if needs_tts(audio) and not VOICEOVER_MIN_WORDS <= voiceover_words <= VOICEOVER_MAX_WORDS:
    message = (
      f"voiceoverScript has {voiceover_words} words; a 30 s spot needs "
      f"{VOICEOVER_MIN_WORDS}-{VOICEOVER_MAX_WORDS} words"
    )
    if strict_copy:
      raise invalid_storyboard(
        message,
        hint="rewrite the script, or pass --no-strict-copy to downgrade this check to a warning",
      )
    warnings.append(
      {
        "warning": "voiceover_length",
        "message": message,
        "hint": "continuing because --no-strict-copy was given",
      }
    )

  prompt = music_prompt(audio)
  music_ascii = prompt.isascii() if prompt else None
  if not prompt and audio.get("musicFile") and not file_exists(audio.get("musicFile")):
    raise CliError(
      EXIT_MISSING_INPUT,
      "missing_input",
      f"audioSpec.musicFile not found and no musicPrompt to regenerate it: "
      f"{audio.get('musicFile')}",
    )
  if needs_music(audio) and not music_ascii:
    raise invalid_storyboard(
      "musicPrompt must be ASCII English: lyria-002 accepts en-US prompts only",
      hint="write audioSpec.musicPrompt in English without special characters",
    )

  validation = {
    "schema": "ok",
    "voiceover_words": voiceover_words,
    "language": language,
    "music_prompt_ascii": music_ascii,
    "durations": durations,
  }
  return validation, warnings


def _default_model_location(entry: dict[str, Any]) -> str:
  listed = list(entry.get("locations") or [])
  if entry.get("default_location"):
    return str(entry["default_location"])
  if "us-central1" in listed or not listed:
    return "us-central1"
  return str(listed[0])


def resolve_locations(
  args: argparse.Namespace, models: dict[str, dict[str, Any]]
) -> dict[str, str]:
  """Resolves per-kind locations, respecting an explicit --location override when given."""
  if args.location is None:
    return {
      "image": _default_model_location(models["image"]),
      "video": _default_model_location(models["video"]),
      "tts": _default_model_location(models["tts"]),
      "music": args.music_location,
    }
  locations = {"image": args.location, "video": args.location, "music": args.music_location}
  tts_entry = models["tts"]
  tts_locations = list(tts_entry.get("locations") or [])
  if args.location in tts_locations or not tts_locations:
    locations["tts"] = args.location
  else:
    locations["tts"] = _default_model_location(tts_entry)
  return locations


def location_warnings(
  models: dict[str, dict[str, Any]], locations: dict[str, str]
) -> list[dict[str, Any]]:
  warnings = []
  for kind in KINDS:
    listed = list(models[kind].get("locations") or [])
    if listed and locations[kind] not in listed:
      warnings.append(
        {
          "warning": "location_unverified",
          "message": (
            f"{models[kind]['id']} is not listed for location {locations[kind]} in "
            f"model_registry.json (listed: {', '.join(listed)})"
          ),
          "hint": "the call is attempted anyway; pass --location/--music-location to change it",
        }
      )
  return warnings


def build_plan(
  storyboard: dict[str, Any], models: dict[str, dict[str, Any]], locations: dict[str, str]
) -> list[dict[str, Any]]:
  shots = storyboard.get("shots") or []
  audio = audio_spec(storyboard)
  counts = {
    "image": sum(1 for s in shots if needs_image(s)),
    "video": sum(1 for s in shots if needs_video(s)),
    "tts": 1 if needs_tts(audio) else 0,
    "music": 1 if needs_music(audio) else 0,
  }
  plan = []
  for kind in KINDS:
    entry = models[kind]
    plan.append(
      {
        "kind": kind,
        "model": entry["id"],
        "location": locations[kind],
        "count": counts[kind],
        "unit_cost_note": entry.get("unit_cost_note") or DEFAULT_UNIT_NOTES[kind],
      }
    )
  return plan


def print_prerequisites(prereqs: dict[str, Any]) -> None:
  print("prerequisites:")
  for key, value in prereqs.items():
    print(f"  {key}: {json.dumps(value)}")


def print_project_line(project: str, source: str) -> None:
  print(f"project: {project or '-'} (source: {source})")


def print_plan(plan: list[dict[str, Any]], planned_calls: int) -> None:
  print("plan (one row per call kind):")
  print("kind | model | location | count | unit_cost_note")
  for row in plan:
    print(
      f"{row['kind']} | {row['model']} | {row['location']} | {row['count']} | "
      f"{row['unit_cost_note']}"
    )
  print(f"planned_calls: {planned_calls}")


def check_assembly_tools(prereqs: dict[str, Any]) -> None:
  """Fails (exit 4) before any paid call when the assembler could not run afterwards."""
  missing = [tool for tool in ("ffmpeg", "ffprobe") if not prereqs.get(tool)]
  if missing:
    raise CliError(
      EXIT_DEPENDENCY,
      "dependency_missing",
      f"{' and '.join(missing)} not found on PATH; required to assemble the video",
      hint="install ffmpeg (it ships ffprobe) or pass --skip-assemble",
    )
  if not prereqs.get("pillow"):
    raise CliError(
      EXIT_DEPENDENCY,
      "dependency_missing",
      "Pillow is required by assemble_ad_video.py for lower-thirds and the endcard",
      hint="pip install pillow or pass --skip-assemble",
    )


# ---------------------------------------------------------------------------
# Execution (paid calls) - only reached with --execute
# ---------------------------------------------------------------------------
def load_backend() -> Any:
  """Imports media_backend from this script's directory (lazy: SDK-free until used)."""
  try:
    import media_backend  # pylint: disable=g-import-not-at-top
  except ImportError:
    if str(SCRIPT_DIR) not in sys.path:
      sys.path.insert(0, str(SCRIPT_DIR))
    import media_backend  # pylint: disable=g-import-not-at-top
  return media_backend


class AssetFailure(Exception):
  """Wraps an adapter exception with the asset kind and shot index."""

  def __init__(self, kind: str, shot_index: int | None, exc: BaseException):
    super().__init__(str(exc))
    self.kind = kind
    self.shot_index = shot_index
    self.exc = exc


class GenerationRun:
  """Shared state of one --execute run: counters, failures and the checkpoint file."""

  def __init__(
    self,
    args: argparse.Namespace,
    storyboard: dict[str, Any],
    models: dict[str, dict[str, Any]],
    locations: dict[str, str],
    project: str,
    work_dir: Path,
    backend: Any,
  ):
    self.args = args
    self.storyboard = storyboard
    self.models = models
    self.locations = locations
    self.project = project
    self.work_dir = work_dir
    self.backend = backend
    self.resolved_path = work_dir / "storyboard_resolved.json"
    self.lock = threading.Lock()
    self.calls_made = {kind: 0 for kind in KINDS}
    self.failed: list[dict[str, Any]] = []

  def count(self, kind: str) -> None:
    with self.lock:
      self.calls_made[kind] += 1

  def set_asset(self, target: dict[str, Any], key: str, value: str) -> None:
    """Records a finished asset and rewrites the checkpoint atomically."""
    with self.lock:
      target[key] = value
      self._write_checkpoint_locked()

  def checkpoint(self) -> None:
    with self.lock:
      self._write_checkpoint_locked()

  def _write_checkpoint_locked(self) -> None:
    data = dict(self.storyboard)
    if self.failed:
      data["failedShots"] = list(self.failed)
    else:
      data.pop("failedShots", None)
    tmp = self.resolved_path.with_name(self.resolved_path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(self.resolved_path)

  def record_failure(self, kind: str, shot_index: int | None, exc: BaseException) -> None:
    text = one_line(exc) or exc.__class__.__name__
    with self.lock:
      self.failed.append({"shotIndex": shot_index, "kind": kind, "error": text})
    who = f"shot {shot_index}" if shot_index is not None else kind
    log(f"{who}: {kind} failed: {text}")
    if debug_enabled():
      traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)

  def retry_logger(self, kind: str, shot_index: int | None) -> Any:
    who = f"shot {shot_index}" if shot_index is not None else kind

    def _on_retry(attempt: int, delay: float, exc: BaseException) -> None:
      log(f"{who}: {kind} attempt {attempt} failed ({one_line(exc, 200)}); retry in {delay:g} s")

    return _on_retry

  def call(self, kind: str, shot_index: int | None, fn: Any) -> Any:
    """Counts every attempt and retries transient errors."""

    def _attempt() -> Any:
      self.count(kind)
      return fn()

    return self.backend.with_retry(_attempt, on_retry=self.retry_logger(kind, shot_index))


def run_shot(run: GenerationRun, shot: dict[str, Any]) -> None:
  """Keyframe (if needed) then clip (if needed) for one shot; raises AssetFailure."""
  idx = int(shot["shotIndex"])
  aspect = str(run.storyboard["aspectRatio"])
  backend = run.backend
  keyframe = Path(shot["keyframeFile"]) if file_exists(shot.get("keyframeFile")) else None
  if keyframe is None:
    entry = run.models["image"]
    try:
      client = backend.make_client(run.project, run.locations["image"])
      keyframe = run.call(
        "image",
        idx,
        lambda: backend.generate_image(
          client, entry["api"], entry["id"], shot["visualPrompt"], aspect, run.work_dir, idx
        ),
      )
    except Exception as exc:
      raise AssetFailure("image", idx, exc) from exc
    run.set_asset(shot, "keyframeFile", str(Path(keyframe).resolve()))
    log(f"shot {idx}: keyframe -> {keyframe}")
  if needs_video(shot):
    entry = run.models["video"]
    duration = normalize_duration(shot.get("durationSeconds")) or 6
    try:
      client = backend.make_client(run.project, run.locations["video"])
      clip = run.call(
        "video",
        idx,
        lambda: backend.generate_video(
          client,
          entry["api"],
          entry["id"],
          shot["motionPrompt"],
          keyframe,
          aspect,
          duration,
          run.work_dir,
          idx,
          veo_audio=bool(run.args.veo_audio),
          resolution=run.args.veo_resolution,
          poll_interval=float(run.args.poll_interval),
          poll_timeout=float(run.args.poll_timeout),
        ),
      )
    except Exception as exc:
      raise AssetFailure("video", idx, exc) from exc
    run.set_asset(shot, "clipFile", str(Path(clip).resolve()))
    log(f"shot {idx}: clip -> {clip}")


def run_tts(run: GenerationRun, audio: dict[str, Any]) -> None:
  entry = run.models["tts"]
  backend = run.backend
  out_wav = run.work_dir / "voiceover.wav"
  language = run.storyboard.get("language")
  try:
    client = backend.make_client(run.project, run.locations["tts"])
    path = run.call(
      "tts",
      None,
      lambda: backend.generate_tts(
        client,
        entry["api"],
        entry["id"],
        voiceover_script(audio),
        run.args.voice,
        out_wav,
        language_code=language if isinstance(language, str) and language else None,
      ),
    )
  except Exception as exc:
    raise AssetFailure("tts", None, exc) from exc
  run.set_asset(audio, "voiceoverFile", str(Path(path).resolve()))
  log(f"voiceover -> {path}")


def run_music(run: GenerationRun, audio: dict[str, Any]) -> None:
  entry = run.models["music"]
  backend = run.backend
  out_wav = run.work_dir / "music_bed.wav"
  try:
    path = run.call(
      "music",
      None,
      lambda: backend.generate_music(
        entry["api"],
        run.project,
        run.locations["music"],
        entry["id"],
        music_prompt(audio),
        out_wav,
      ),
    )
  except Exception as exc:
    raise AssetFailure("music", None, exc) from exc
  run.set_asset(audio, "musicFile", str(Path(path).resolve()))
  log(f"music bed -> {path}")


def run_assembler(resolved: Path, out_dir: Path) -> int:
  """Streams assemble_ad_video.py render (capture_output=False); returns its exit code."""
  if not ASSEMBLER_PATH.is_file():
    raise CliError(EXIT_DEPENDENCY, "dependency_missing", f"assembler not found: {ASSEMBLER_PATH}")
  cmd = [
    sys.executable,
    str(ASSEMBLER_PATH),
    "render",
    "--storyboard",
    str(resolved),
    "--output-dir",
    str(out_dir),
  ]
  log("assembling: " + " ".join(cmd))
  sys.stdout.flush()
  sys.stderr.flush()
  proc = subprocess.run(cmd, check=False)
  return int(proc.returncode)


def execute(
  args: argparse.Namespace,
  storyboard: dict[str, Any],
  models: dict[str, dict[str, Any]],
  locations: dict[str, str],
  project: str,
  project_source: str,
) -> int:
  backend = load_backend()
  backend.import_sdk()  # DependencyMissing -> exit 4 before any client or work dir
  if needs_music(audio_spec(storyboard)) and not module_importable("google.auth"):
    raise CliError(
      EXIT_DEPENDENCY,
      "dependency_missing",
      "google-auth is required for the Lyria music bed (predict_rest adapter)",
      hint="pip install -r requirements.txt",
    )
  backend.reset_clients()
  out_dir = Path(args.output_dir).expanduser()
  work_dir = out_dir / "work"
  work_dir.mkdir(parents=True, exist_ok=True)
  storyboard.pop("failedShots", None)
  audio = storyboard.setdefault("audioSpec", {})
  shots = storyboard["shots"]
  run = GenerationRun(args, storyboard, models, locations, project, work_dir, backend)
  run.checkpoint()

  tasks: list[tuple[Any, str, int | None]] = []
  with ThreadPoolExecutor(max_workers=max(1, int(args.max_workers))) as pool:
    if needs_tts(audio):
      tasks.append((pool.submit(run_tts, run, audio), "tts", None))
    if needs_music(audio):
      tasks.append((pool.submit(run_music, run, audio), "music", None))
    for shot in shots:
      tasks.append((pool.submit(run_shot, run, shot), "shot", int(shot["shotIndex"])))
    for future, kind, shot_index in tasks:
      try:
        future.result()
      except AssetFailure as failure:
        run.record_failure(failure.kind, failure.shot_index, failure.exc)
      except Exception as exc:  # defensive: adapter bugs must not abort other shots
        run.record_failure(kind, shot_index, exc)
  run.checkpoint()

  summary: dict[str, Any] = {
    "project": project,
    "project_source": project_source,
    "calls_made": dict(run.calls_made),
  }
  if run.failed:
    emit_error(
      "partial_failure",
      f"{len(run.failed)} asset(s) failed; finished assets are kept under {work_dir}",
      hint=f"fix the cause, then re-run with --storyboard {run.resolved_path} to resume",
    )
    emit_json_line(
      {
        "status": "partial",
        "rendered": False,
        "failed_shots": list(run.failed),
        **summary,
        "resolved_storyboard": str(run.resolved_path),
      }
    )
    return EXIT_PARTIAL

  if args.skip_assemble:
    emit_json_line(
      {
        "status": "ok",
        "rendered": False,
        **summary,
        "output_dir": str(out_dir),
        "resolved_storyboard": str(run.resolved_path),
      }
    )
    return EXIT_OK

  rc = run_assembler(run.resolved_path, out_dir)
  if rc != 0:
    emit_error(
      "assembler_failed",
      f"assemble_ad_video.py exited with code {rc}; see its output above",
      exit_code=rc,
      resolved_storyboard=str(run.resolved_path),
    )
    return rc
  emit_json_line(
    {
      "status": "ok",
      "rendered": True,
      **summary,
      "output_dir": str(out_dir),
      "resolved_storyboard": str(run.resolved_path),
    }
  )
  return EXIT_OK


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
  workdir = os.environ.get("SCENE_MACHINE_WORKDIR", "").strip() or "./.scene_machine"
  default_output = os.path.join(workdir, "output")
  parser = argparse.ArgumentParser(
    prog="generate_ad_spot_vertex.py",
    description=(
      "Generate Scene Machine ad assets on Vertex AI and assemble the MP4. "
      "Dry-run by default: validates the storyboard and prints the call plan "
      "without importing an SDK or billing anything; --execute performs the calls."
    ),
    epilog=(
      "Exit codes: 0 ok/dry-run, 2 usage, 3 missing input, 4 dependency missing, "
      "5 invalid storyboard, 6 verification failed, 7 partial generation failure "
      "(resumable: re-run with --storyboard <output-dir>/work/storyboard_resolved.json)."
    ),
  )
  parser.add_argument(
    "--storyboard", help="Path to storyboard.json (required unless --list-models)."
  )
  mode = parser.add_mutually_exclusive_group()
  mode.add_argument(
    "--dry-run",
    action="store_true",
    default=True,
    help="Validate and print the plan without any API call (default).",
  )
  mode.add_argument(
    "--execute",
    action="store_true",
    help="Perform the paid generation calls; needs --project or GOOGLE_CLOUD_PROJECT.",
  )
  parser.add_argument(
    "--project",
    default="",
    help=(
      "Google Cloud project with Vertex AI enabled. Falls back to GOOGLE_CLOUD_PROJECT; "
      "the gcloud default project is shown as a hint only and never billed implicitly."
    ),
  )
  parser.add_argument(
    "--location",
    default=None,
    help=(
      "Vertex AI location override for image and video models (and TTS when supported); "
      "defaults to each model's default_location in model_registry.json."
    ),
  )
  parser.add_argument(
    "--music-location",
    default="global",
    help="Location for the Lyria :predict endpoint (global or a region such as us-central1).",
  )
  parser.add_argument("--image-model", default=DEFAULT_MODELS["image"], help="Image model id.")
  parser.add_argument("--video-model", default=DEFAULT_MODELS["video"], help="Video model id.")
  parser.add_argument("--tts-model", default=DEFAULT_MODELS["tts"], help="TTS model id.")
  parser.add_argument("--music-model", default=DEFAULT_MODELS["music"], help="Music model id.")
  parser.add_argument(
    "--voice", default="Kore", help="Prebuilt Gemini TTS voice (Kore, Puck, ...)."
  )
  parser.add_argument(
    "--veo-audio",
    action="store_true",
    help="Let Veo generate native audio (billed at the with-audio rate; off by default).",
  )
  parser.add_argument(
    "--veo-resolution",
    default=None,
    help="Optional Veo resolution passthrough (for example 720p or 1080p).",
  )
  parser.add_argument(
    "--max-workers", type=int, default=3, help="Parallel shots/assets (default 3)."
  )
  parser.add_argument(
    "--poll-interval", type=float, default=10.0, help="Veo polling interval in seconds."
  )
  parser.add_argument(
    "--poll-timeout", type=float, default=900.0, help="Per-clip Veo deadline in seconds."
  )
  parser.add_argument(
    "--list-models", action="store_true", help="Print the model registry table and exit."
  )
  parser.add_argument(
    "--no-strict-copy",
    action="store_true",
    help="Downgrade the 50-65 word voiceover check to a warning.",
  )
  parser.add_argument(
    "--output-dir",
    default=default_output,
    help="Output root (default ${SCENE_MACHINE_WORKDIR:-./.scene_machine}/output).",
  )
  parser.add_argument(
    "--skip-assemble",
    action="store_true",
    help="Generate assets only; do not run assemble_ad_video.py.",
  )
  parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
  return parser


def run(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
  registry = load_registry()
  if args.list_models:
    print_model_table(registry)
    return EXIT_OK
  if not args.storyboard:
    parser.error("--storyboard is required (or use --list-models)")
  if args.max_workers < 1:
    parser.error("--max-workers must be >= 1")
  if args.poll_interval <= 0:
    parser.error("--poll-interval must be > 0")
  if args.poll_timeout <= 0:
    parser.error("--poll-timeout must be > 0")

  models = {kind: resolve_model(registry, kind, getattr(args, f"{kind}_model")) for kind in KINDS}
  project, project_source = resolve_project(args.project)
  if args.execute and project_source == "none":
    hint = gcloud_default_project_hint()
    parser.error(
      "--execute needs an explicit project: pass --project <id> or set GOOGLE_CLOUD_PROJECT "
      f"(gcloud default project hint: {hint or 'none'}; the hint is never used for billing)"
    )

  storyboard = load_storyboard(args.storyboard)
  validation, warnings = validate_storyboard(storyboard, strict_copy=not args.no_strict_copy)
  for warning in warnings:
    emit_warning(**warning)
  locations = resolve_locations(args, models)
  for warning in location_warnings(models, locations):
    emit_warning(**warning)
  plan = build_plan(storyboard, models, locations)
  planned_calls = sum(int(row["count"]) for row in plan)

  if not args.execute:
    prereqs = collect_prerequisites()
    print(f"scene-machine generator {VERSION}: dry run (no API call, nothing billed)")
    print_prerequisites(prereqs)
    print_project_line(project, project_source)
    print_plan(plan, planned_calls)
    emit_json_line(
      {
        "status": "dry_run",
        "rendered": False,
        "planned_calls": planned_calls,
        "project": project,
        "project_source": project_source,
        "prerequisites": prereqs,
        "validation": validation,
        "plan": plan,
      }
    )
    return EXIT_OK

  print(f"scene-machine generator {VERSION}: execute ({planned_calls} planned calls)")
  print_project_line(project, project_source)
  print_plan(plan, planned_calls)
  if not args.skip_assemble:
    prereqs = collect_prerequisites(gcloud_hint="")
    check_assembly_tools(prereqs)
  return execute(args, storyboard, models, locations, project, project_source)


def classify_exception(exc: BaseException) -> tuple[int, str, str | None]:
  if exc.__class__.__name__ == "DependencyMissing":
    return EXIT_DEPENDENCY, "dependency_missing", getattr(exc, "hint", None)
  if isinstance(exc, ImportError):
    return EXIT_DEPENDENCY, "dependency_missing", "pip install -r requirements.txt"
  if isinstance(exc, FileNotFoundError):
    return EXIT_MISSING_INPUT, "missing_input", None
  if isinstance(exc, OSError):
    return EXIT_DEPENDENCY, "io_failed", None
  return EXIT_INTERNAL, "internal", "set SCENE_MACHINE_DEBUG=1 for a traceback"


def main(argv: list[str] | None = None) -> int:
  parser = build_parser()
  args = parser.parse_args(argv)
  try:
    return run(args, parser)
  except CliError as exc:
    emit_error(exc.error, exc.message, **exc.extra)
    return exc.exit_code
  except KeyboardInterrupt:
    emit_error("interrupted", "interrupted by user")
    return 130
  except Exception as exc:  # last resort: never a bare traceback without SCENE_MACHINE_DEBUG
    if debug_enabled():
      traceback.print_exc()
    code, error, hint = classify_exception(exc)
    emit_error(error, one_line(exc) or exc.__class__.__name__, hint=hint)
    return code


if __name__ == "__main__":
  sys.exit(main())
