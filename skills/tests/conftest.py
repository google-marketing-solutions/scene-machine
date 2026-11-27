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
"""Shared fixtures for the hermetic scene-machine test suite.

Guarantees for every test:
  * ``google``, ``google.genai``, ``google.genai.types``, ``google.auth*`` are
    replaced in ``sys.modules`` by the fake in ``fake_genai.py`` and
    ``urllib.request.urlopen`` is patched - no real client, no credentials.
  * ``socket.create_connection`` / ``socket.socket.connect`` raise.
  * PATH only contains ffmpeg/ffprobe (no gcloud), HOME is a temp dir, and the
    SCENE_MACHINE_* / GOOGLE_* variables are cleared.
  * No ``__pycache__`` is left behind (bytecode writing is disabled and caches
    created by subprocesses are removed at session end).
All media is synthetic (FFmpeg lavfi) and built once per session.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import importlib.util  # noqa: E402
import inspect  # noqa: E402
import itertools  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parent
SKILL_DIR = ROOT / "scene-machine"
SCRIPTS_DIR = SKILL_DIR / "scripts"
BENCH_DIR = ROOT / "benchmarks"
ASSEMBLER = SCRIPTS_DIR / "assemble_ad_video.py"
GENERATOR = SCRIPTS_DIR / "generate_ad_spot_vertex.py"
MEDIA_BACKEND = SCRIPTS_DIR / "media_backend.py"
REGISTRY = SCRIPTS_DIR / "model_registry.json"
ENV_PROBE = SCRIPTS_DIR / "env_probe.py"
INSTALL_SH = ROOT / "install.sh"
ORIGINAL_PATH = os.environ.get("PATH", "/usr/bin:/bin")
SYSTEM_PYTHON = "/usr/bin/python3"

for extra in (str(TESTS_DIR), str(BENCH_DIR)):
  if extra not in sys.path:
    sys.path.insert(0, extra)

import fake_genai  # noqa: E402
import lavfi_media  # noqa: E402
import storyboards  # noqa: E402


def require_file(rel: str) -> Path:
  """Returns ROOT/rel; a missing package file is a packaging error, not a skip."""
  path = ROOT / rel
  assert path.exists(), f"package file missing: {rel}"
  return path


# ---------------------------------------------------------------------------
# pytest hooks
# ---------------------------------------------------------------------------
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
  expr = config.getoption("-m") or ""
  if "determinism" in expr:
    return
  skip = pytest.mark.skip(reason="opt-in: run with -m determinism")
  for item in items:
    if "determinism" in item.keywords:
      item.add_marker(skip)


def _remove_bytecode_caches() -> None:
  for base in (TESTS_DIR, BENCH_DIR, SKILL_DIR):
    if not base.exists():
      continue
    for cache in base.rglob("__pycache__"):
      shutil.rmtree(cache, ignore_errors=True)


def pytest_sessionstart(session: pytest.Session) -> None:
  # pytest's assertion rewriter may have cached this conftest before the line
  # above disabled bytecode writing; drop it so PK-01 never sees a stray .pyc.
  _remove_bytecode_caches()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
  _remove_bytecode_caches()


# ---------------------------------------------------------------------------
# Session-scoped media and storyboards
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
  return lavfi_media.build_media(tmp_path_factory.mktemp("media"))


@pytest.fixture(scope="session")
def storyboard_dir(media_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
  out = tmp_path_factory.mktemp("storyboards")
  storyboards.write_variants(media_dir, out)
  return out


@pytest.fixture(scope="session")
def fake_media_bytes() -> dict[str, Any]:
  return {
    "png": lavfi_media.png_bytes(),
    "jpeg": lavfi_media.jpeg_bytes(),
    "pcm": lavfi_media.pcm_bytes(),
    "wav": lavfi_media.wav_bytes(),
    "mp4": lavfi_media.mp4_bytes,
  }


@pytest.fixture(scope="session")
def tool_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
  """A PATH directory that only exposes ffmpeg and ffprobe (never gcloud)."""
  shim = tmp_path_factory.mktemp("bin")
  for tool in ("ffmpeg", "ffprobe"):
    real = shutil.which(tool, path=ORIGINAL_PATH)
    if real is None:
      pytest.skip(f"{tool} is required for the test suite")
    os.symlink(real, shim / tool)
  return shim


@pytest.fixture(scope="session")
def empty_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
  return tmp_path_factory.mktemp("empty_bin")


# ---------------------------------------------------------------------------
# Hermetic guard (autouse)
# ---------------------------------------------------------------------------
@pytest.fixture
def fake_sdk(
  monkeypatch: pytest.MonkeyPatch, fake_media_bytes: dict[str, Any]
) -> fake_genai.Recorder:
  rec = fake_genai.Recorder(dict(fake_media_bytes))
  fake_genai.install(monkeypatch, rec)
  monkeypatch.delitem(sys.modules, "media_backend", raising=False)
  return rec


@pytest.fixture(autouse=True)
def hermetic(
  monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tool_path: Path, fake_sdk: fake_genai.Recorder
) -> fake_genai.Recorder:
  def _deny(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("network access is disabled in the scene-machine test suite")

  monkeypatch.setattr(socket, "create_connection", _deny)
  monkeypatch.setattr(socket.socket, "connect", _deny)
  monkeypatch.setattr(socket.socket, "connect_ex", _deny)
  home = tmp_path / "home"
  home.mkdir(exist_ok=True)
  monkeypatch.setenv("HOME", str(home))
  monkeypatch.setenv("PATH", str(tool_path))
  monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
  for var in (
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CORE_PROJECT",
    "SCENE_MACHINE_WORKDIR",
    "SCENE_MACHINE_MIRROR_DIR",
    "SCENE_MACHINE_DEBUG",
    "CODEX_HOME",
  ):
    monkeypatch.delenv(var, raising=False)
  monkeypatch.chdir(tmp_path)
  return fake_sdk


# ---------------------------------------------------------------------------
# Helpers shared by the test modules
# ---------------------------------------------------------------------------
def shell_env(**overrides: str) -> dict[str, str]:
  """Environment for subprocesses that need a full shell (bash, zip...)."""
  env = dict(os.environ)
  env["PATH"] = ORIGINAL_PATH
  env["PYTHONDONTWRITEBYTECODE"] = "1"
  env.update(overrides)
  return env


def run_py(
  script: Path,
  args: list[str],
  env: dict[str, str] | None = None,
  cwd: Path | None = None,
  timeout: float = 240.0,
  python: str | None = None,
  block_sdk: bool = False,
) -> subprocess.CompletedProcess[str]:
  """Runs a package script in a subprocess (optionally with google.genai blocked)."""
  base_env = dict(os.environ)
  base_env["PYTHONDONTWRITEBYTECODE"] = "1"
  if env:
    base_env.update(env)
  exe = python or sys.executable
  if block_sdk:
    bootstrap = (
      "import sys, runpy; sys.modules['google'] = None; sys.modules['google.genai'] = None; "
      "sys.modules['google.auth'] = None; "
      f"sys.argv = [{str(script)!r}] + sys.argv[1:]; "
      f"runpy.run_path({str(script)!r}, run_name='__main__')"
    )
    cmd = [exe, "-c", bootstrap, *args]
  else:
    cmd = [exe, str(script), *args]
  return subprocess.run(
    cmd,
    capture_output=True,
    text=True,
    check=False,
    env=base_env,
    cwd=str(cwd) if cwd else None,
    timeout=timeout,
  )


_module_counter = itertools.count()


def load_script(path: Path) -> Any:
  """Imports a script file as a fresh module (scripts dir on sys.path for siblings)."""
  if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
  sys.modules.pop("media_backend", None)
  name = f"sm_{path.stem}_{next(_module_counter)}"
  spec = importlib.util.spec_from_file_location(name, path)
  assert spec and spec.loader
  mod = importlib.util.module_from_spec(spec)
  sys.modules[name] = mod
  spec.loader.exec_module(mod)
  return mod


def call_main(mod: Any, argv: list[str]) -> int:
  """Calls mod.main() with argv, normalising SystemExit and None to an int code."""
  params = inspect.signature(mod.main).parameters
  old_argv = sys.argv
  sys.argv = [str(getattr(mod, "__file__", "script.py")), *argv]
  try:
    try:
      rc = mod.main(list(argv)) if params else mod.main()
    except SystemExit as exc:
      rc = exc.code
  finally:
    sys.argv = old_argv
  if rc is None or rc is True:
    return 0
  if isinstance(rc, int):
    return rc
  return 1


def json_lines(text: str) -> list[dict[str, Any]]:
  out: list[dict[str, Any]] = []
  for line in (text or "").splitlines():
    line = line.strip()
    if not line.startswith("{"):
      continue
    try:
      value = json.loads(line)
    except ValueError:
      continue
    if isinstance(value, dict):
      out.append(value)
  return out


def last_json_line(text: str) -> dict[str, Any]:
  """Parses the LAST non-empty stdout line as a JSON object."""
  lines = [ln for ln in (text or "").splitlines() if ln.strip()]
  assert lines, "no output to parse"
  try:
    value = json.loads(lines[-1])
  except ValueError as exc:
    raise AssertionError(f"last line is not JSON: {lines[-1][:200]!r}") from exc
  assert isinstance(value, dict), value
  return value


def parse_summary(stdout: str) -> dict[str, Any]:
  """Assembler summary: a one-line JSON (2.1) or an indented JSON document (2.0)."""
  text = (stdout or "").strip()
  try:
    value = json.loads(text)
    if isinstance(value, dict):
      return value
  except ValueError:
    pass
  objs = json_lines(text)
  if objs:
    return objs[-1]
  start = text.rfind("\n{")
  if start >= 0:
    return json.loads(text[start + 1 :])
  raise AssertionError(f"no JSON summary in stdout: {text[-300:]!r}")


def find_error(stderr: str) -> dict[str, Any]:
  errors = [o for o in json_lines(stderr) if "error" in o]
  assert errors, f"no JSON error object on stderr: {stderr[-500:]!r}"
  return errors[-1]


def find_warnings(stderr: str, code: str | None = None) -> list[dict[str, Any]]:
  warnings = [o for o in json_lines(stderr) if "warning" in o]
  return [w for w in warnings if code is None or w.get("warning") == code]
