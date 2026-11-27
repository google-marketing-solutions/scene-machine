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
"""Fixtures for the benchmarks (``python -m pytest -m bench benchmarks``).

Reuses the lavfi media builder and storyboard generator from ``tests/``. Tests
marked ``bench`` are skipped unless ``-m bench`` is given, so an accidental
``pytest benchmarks`` stays fast.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import os  # noqa: E402
import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

BENCH_DIR = Path(__file__).resolve().parent
ROOT = BENCH_DIR.parent
TESTS_DIR = ROOT / "tests"
ORIGINAL_PATH = os.environ.get("PATH", "/usr/bin:/bin")
for extra in (str(TESTS_DIR), str(BENCH_DIR)):
  if extra not in sys.path:
    sys.path.insert(0, extra)

import lavfi_media  # noqa: E402
import storyboards  # noqa: E402


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
  expr = config.getoption("-m") or ""
  if "bench" in expr:
    return
  skip = pytest.mark.skip(reason="benchmark: run with -m bench")
  for item in items:
    if "bench" in item.keywords:
      item.add_marker(skip)


def _remove_bytecode_caches() -> None:
  for base in (TESTS_DIR, BENCH_DIR, ROOT / "scene-machine"):
    if base.exists():
      for cache in base.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)


def pytest_sessionstart(session: pytest.Session) -> None:
  _remove_bytecode_caches()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
  _remove_bytecode_caches()


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
  return lavfi_media.build_media(tmp_path_factory.mktemp("media"))


@pytest.fixture(scope="session")
def storyboard_dir(media_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
  out = tmp_path_factory.mktemp("storyboards")
  storyboards.write_variants(media_dir, out)
  return out


@pytest.fixture(scope="session")
def tool_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
  shim = tmp_path_factory.mktemp("bin")
  for tool in ("ffmpeg", "ffprobe"):
    real = shutil.which(tool, path=ORIGINAL_PATH)
    if real is None:
      pytest.skip(f"{tool} is required for the benchmarks")
    os.symlink(real, shim / tool)
  return shim


@pytest.fixture(autouse=True)
def bench_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tool_path: Path) -> None:
  home = tmp_path / "home"
  home.mkdir(exist_ok=True)
  monkeypatch.setenv("HOME", str(home))
  monkeypatch.setenv("PATH", str(tool_path))
  monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
  for var in (
    "SCENE_MACHINE_WORKDIR",
    "SCENE_MACHINE_MIRROR_DIR",
    "SCENE_MACHINE_DEBUG",
    "GOOGLE_CLOUD_PROJECT",
  ):
    monkeypatch.delenv(var, raising=False)
  monkeypatch.chdir(tmp_path)
