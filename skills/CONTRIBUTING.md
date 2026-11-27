# Contributing to the scene-machine skill

This directory is the `skills/` tree of
[google-marketing-solutions/scene-machine](https://github.com/google-marketing-solutions/scene-machine).
The repository-level [CONTRIBUTING.md](../CONTRIBUTING.md) applies in full,
including the Contributor License Agreement (CLA) and the code review process
through GitHub pull requests. Read it first; this file only adds the rules that
are specific to the skill package.

## Before you open a pull request

1. Create a virtual environment and install the pinned dependencies:
   `python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt`.
2. Run `make lint test` before a PR. `make lint` runs ruff and the skill
   conformance lint against the source tree and the zip artifact; `make test`
   runs the hermetic pytest suite. `make bench` and `make zip` are recommended
   as well; CI (`.github/workflows/skill-ci.yml`) runs all four.
3. Keep the Apache-2.0 header on every `.py`, `.sh` and workflow file and the
   two-space indentation of the shipped scripts (`ruff.toml` encodes it).
4. Add an entry to `CHANGELOG.md` and bump `metadata.version` in
   `scene-machine/SKILL.md` when the behaviour of the skill changes.

## Scope: tests must stay hermetic

The test and benchmark suites run in CI without secrets and without a Google
Cloud project. Any new test must therefore use:

- no network (the test configuration stubs `google.genai`, `google.auth` and
  `urllib.request.urlopen` and fails on socket connections);
- no credentials and no real project ids;
- synthetic media only (FFmpeg `lavfi` sources); never commit media binaries,
  `__pycache__` directories or `.pyc` files.

Anything that genuinely needs a project (live model availability, real cost,
Gemini Enterprise upload behaviour) belongs in the manual test plan in
`README.md`, not in `tests/`.

## Model registry re-verification policy

`scene-machine/scripts/model_registry.json` is the single source of model ids,
API families and locations.

- Re-verify every `active` and `preview` entry against the public Vertex AI
  model pages before each release and update `last_verified` (the lint fails
  when the date is older than 180 days).
- Never ship a retired model as a default. When a model is shut down, set its
  `status` to `retired`, add `replacement`, and move the `default` flag to the
  replacement. Retired ids stay in the registry so the generator can name the
  replacement in its error message.
- A new model family (for example the Veo successor recorded with `api: tbd`)
  needs an adapter in `media_backend.py` keyed by the `api` field, plus tests
  with the documented response shape.

## Content rules

- No real brand names in examples or prose; the fictional NordicGlow brand is
  the only example brand.
- No internal links, hostnames or ticket ids; the conformance lint rejects them.
- ASCII punctuation, no emojis; SKILL.md stays below 200 lines.
