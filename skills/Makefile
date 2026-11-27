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
#
# Local equivalents of the CI jobs in ci/skill-ci.yml. Run from this
# directory with the pinned requirements installed (requirements-dev.txt).
#
#   make lint          ruff + skill conformance lint (builds the zip first)
#   make format        ruff format --check
#   make test          hermetic pytest suite (no network, no credentials)
#   make bench         render benchmarks, prints benchmarks/results/latest.json
#   make zip           dist/scene-machine.zip with SKILL.md at the archive root
#   make compile       byte-compile the scripts, then drop __pycache__
#   make install TOOL=claude   ./install.sh --target claude (see install.sh --help)
#   make clean         remove dist/, .pytest-tmp/ and __pycache__ directories
#
# Overridable: PYTHON (default python3), BASETEMP (pytest --basetemp,
# default ./.pytest-tmp), TOOL (install target).

PYTHON ?= python3
export PYTHONDONTWRITEBYTECODE = 1
BASETEMP ?= ./.pytest-tmp
SKILL = scene-machine
TOOL ?=

.PHONY: lint format test bench zip compile install clean

lint: zip
	$(PYTHON) -m ruff check --no-cache $(SKILL)/scripts tests benchmarks && $(PYTHON) benchmarks/skill_lint.py $(SKILL) --zip dist/$(SKILL).zip

format:
	$(PYTHON) -m ruff format --no-cache --check $(SKILL)/scripts tests benchmarks

test:
	$(PYTHON) -m pytest -q --basetemp="$(BASETEMP)" -p no:cacheprovider tests

bench:
	$(PYTHON) -m pytest -q -m bench --basetemp="$(BASETEMP)" -p no:cacheprovider benchmarks && cat benchmarks/results/latest.json

zip:
	rm -rf dist && mkdir -p dist && (cd $(SKILL) && zip -qr ../dist/$(SKILL).zip SKILL.md scripts references assets -x "*.pyc" "*__pycache__*" "*.DS_Store")

compile:
	$(PYTHON) -m py_compile $(SKILL)/scripts/*.py
	$(PYTHON) -c "import pathlib, shutil; [shutil.rmtree(p) for p in pathlib.Path('.').rglob('__pycache__') if p.is_dir() and '.venv' not in p.parts]"

install:
	@test -n "$(TOOL)" || { echo "usage: make install TOOL=<claude|antigravity|codex|gemini|cursor|windsurf|copilot|agents|all>" >&2; exit 2; }
	./install.sh --target $(TOOL)

clean:
	rm -rf dist .pytest-tmp
	$(PYTHON) -c "import pathlib, shutil; [shutil.rmtree(p) for p in pathlib.Path('.').rglob('__pycache__') if p.is_dir() and '.venv' not in p.parts]"
