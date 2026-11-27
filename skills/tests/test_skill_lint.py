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
"""Tests for benchmarks/skill_lint.py: rule units on synthetic packages + the real tree.

skill-lint: allow-internal-patterns (this file writes deliberately bad fixtures)
"""

from __future__ import annotations

import datetime as dt
import json
import re
import zipfile
from pathlib import Path
from typing import Any

import pytest

import skill_lint
from conftest import BENCH_DIR, SKILL_DIR, run_py

HEADER = (
  '# Copyright 2026 Google LLC\n#\n# Licensed under the Apache License, Version 2.0 (the "License");\n'
  "# you may not use this file except in compliance with the License.\n"
)
GOOD_README = (
  "# demo\n\nThis is not an officially supported Google product.\n\n"
  "Cost: every --execute run makes paid Vertex AI calls; dry-run is the default.\n\n"
  "Supported on Linux and macOS; Windows is untested.\n\n"
  "Run `gcloud auth application-default set-quota-project <id>` once.\n"
)
GOOD_REGISTRY = {
  "version": "2026-11-20",
  "models": [
    {
      "id": "img-1",
      "kind": "image",
      "api": "generate_content_image",
      "status": "active",
      "default": True,
      "last_verified": "2026-11-20",
    },
    {
      "id": "img-0",
      "kind": "image",
      "api": "generate_images",
      "status": "retired",
      "replacement": "img-1",
    },
    {
      "id": "vid-1",
      "kind": "video",
      "api": "generate_videos",
      "status": "active",
      "default": True,
      "last_verified": "2026-11-20",
    },
  ],
}


def make_package(
  tmp_path: Path,
  name: str = "demo-skill",
  frontmatter: str | None = None,
  body: str = "",
  readme: str = GOOD_README,
  registry: dict[str, Any] | None = GOOD_REGISTRY,
  extra_files: dict[str, str] | None = None,
) -> tuple[Path, Path]:
  pkg = tmp_path / "pkg"
  skill = pkg / name
  (skill / "scripts").mkdir(parents=True)
  (skill / "references").mkdir()
  fm = (
    frontmatter
    if frontmatter is not None
    else (
      f"---\nname: {name}\ndescription: Use when asked for a demo. Produces a demo.\nlicense: Apache-2.0\n"
      'metadata:\n  version: "1.0.0"\n---\n'
    )
  )
  (skill / "SKILL.md").write_text(
    fm + "# Demo\n\nSee references/guide.md and scripts/tool.py.\n" + body, encoding="utf-8"
  )
  (skill / "references" / "guide.md").write_text("# guide\n", encoding="utf-8")
  (skill / "scripts" / "tool.py").write_text(HEADER + "print('hi')\n", encoding="utf-8")
  if registry is not None:
    (skill / "scripts" / "model_registry.json").write_text(json.dumps(registry), encoding="utf-8")
  if readme is not None:
    (pkg / "README.md").write_text(readme, encoding="utf-8")
  for rel, content in (extra_files or {}).items():
    target = pkg / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
  return pkg, skill


def run_lint(skill: Path, **kw: Any) -> skill_lint.Findings:
  kw.setdefault("run_dry_run", False)
  kw.setdefault("today", dt.date(2026, 11, 23))
  return skill_lint.lint(skill, **kw)


def codes(f: skill_lint.Findings, level: str) -> list[str]:
  return f.codes(level)


def messages(f: skill_lint.Findings, code: str) -> str:
  return "\n".join(msg for _, c, msg in f.items if c == code)


def test_minimal_good_package_passes(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path)
  f = run_lint(skill)
  assert f.fails == 0, [i for i in f.items if i[0] == "FAIL"]
  assert "PD-01" in codes(f, "SKIP")  # no generator in the synthetic skill
  assert {
    "FM-01",
    "FM-02",
    "FM-03",
    "FM-04",
    "FM-05",
    "SZ-01",
    "SZ-02",
    "TX-01",
    "TX-02",
    "TX-03",
    "TX-04",
    "PK-01",
    "PK-02",
    "PD-03",
    "PD-04",
  } <= set(codes(f, "PASS"))


def test_name_mismatch_and_bad_description_fail(tmp_path: Path) -> None:
  _, skill = make_package(
    tmp_path, frontmatter="---\nname: Other_Name\ndescription: ''\nmetadata:\n  version: 1\n---\n"
  )
  f = run_lint(skill)
  assert {"FM-02", "FM-03", "FM-05"} <= set(codes(f, "FAIL"))


def test_unknown_key_warns_and_compatibility_limit(tmp_path: Path) -> None:
  fm = "---\nname: demo-skill\ndescription: d\nfoo: bar\ncompatibility: " + "x" * 501 + "\n---\n"
  _, skill = make_package(tmp_path, frontmatter=fm)
  f = run_lint(skill)
  assert "FM-04" in codes(f, "WARN") and "FM-05" in codes(f, "FAIL")


def test_missing_frontmatter_fails(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, frontmatter="no frontmatter here\n")
  assert "FM-01" in codes(run_lint(skill), "FAIL")


def test_skill_md_too_long_fails(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, body="line\n" * 600)
  assert "SZ-01" in codes(run_lint(skill), "FAIL")
  assert "SZ-01" in codes(run_lint(skill, max_lines=1000), "PASS")


def test_emoji_fails(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, body="Great \U0001f600 job\n")
  f = run_lint(skill)
  assert "TX-01" in codes(f, "FAIL") and "U+1F600" in messages(f, "TX-01")


@pytest.mark.parametrize(
  "snippet",
  [
    "path /Users/alice/work",
    "path /home/bob/repo",
    "path /usr/local/org/home/dev/file",
    "host host.corp.example.com",
    "https://wiki.internal.example.com/docs",
    "service app.intranet",
    "portal corp.example.com",
  ],
)
def test_internal_references_fail(tmp_path: Path, snippet: str) -> None:
  _, skill = make_package(tmp_path, body=snippet + "\n")
  f = run_lint(skill)
  assert "TX-02" in codes(f, "FAIL"), snippet


def test_custom_internal_terms_fail(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, body="see internal-codename-42 for details\n")
  assert "TX-02" not in codes(run_lint(skill), "FAIL")
  f = run_lint(skill, internal_terms=("internal-codename-42",))
  assert "TX-02" in codes(f, "FAIL") and "internal-codename-42" in messages(f, "TX-02")
  proc = run_py(
    BENCH_DIR / "skill_lint.py",
    [
      str(skill),
      "--no-dry-run-check",
      "--today",
      "2026-11-23",
      "--internal-terms",
      "internal-codename-42",
    ],
  )
  assert proc.returncode == 1
  assert "FAIL TX-02:" in proc.stdout


@pytest.mark.parametrize(
  "snippet",
  [
    "gemini-omni-1.2-flash is the successor",
    "gemini-3-pro-image and lyria-3-clip-preview are public",
    "veo-3.1-fast-generate-001 with generate_audio off",
    "/usr/bin/python3",
    "TODO(owner): revisit later",
    "acmecorp.example",
    "https://example.com/internal/docs",
    "https://corporate.example.com/about",
  ],
)
def test_public_ids_and_lookalikes_are_not_flagged(tmp_path: Path, snippet: str) -> None:
  _, skill = make_package(tmp_path, body=snippet + "\n")
  f = run_lint(skill)
  assert "TX-02" not in codes(f, "FAIL"), (snippet, messages(f, "TX-02"))


def test_exempt_marker_skips_internal_scan(tmp_path: Path) -> None:
  _, skill = make_package(
    tmp_path,
    extra_files={
      "tests/test_x.py": HEADER
      + "# skill-lint: allow-internal-patterns\nX = 'wiki.internal.example.com'\n"
    },
  )
  f = run_lint(skill)
  assert "TX-02" not in codes(f, "FAIL")
  assert "exempt" in messages(f, "TX-02")


def test_brand_terms_warn(tmp_path: Path) -> None:
  _, skill = make_package(
    tmp_path, body="Example brand: example-brand coffee at example-brand.example\n"
  )
  f = run_lint(skill, brand_terms=("example-brand",))
  assert "TX-04" in codes(f, "WARN") and "TX-04" not in codes(f, "FAIL")
  f2 = run_lint(skill, brand_terms=("acmecorp",))
  assert "TX-04" in codes(f2, "PASS")
  f3 = run_lint(skill)
  assert "TX-04" in codes(f3, "PASS")


def test_unresolved_reference_fails(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, body="Also read references/missing.md\n")
  f = run_lint(skill)
  assert "TX-03" in codes(f, "FAIL") and "references/missing.md" in messages(f, "TX-03")


def test_pycache_and_media_fail(tmp_path: Path) -> None:
  pkg, skill = make_package(tmp_path)
  (skill / "scripts" / "__pycache__").mkdir()
  (skill / "scripts" / "__pycache__" / "tool.cpython-313.pyc").write_bytes(b"\x00")
  (pkg / "tests").mkdir()
  (pkg / "tests" / "clip.mp4").write_bytes(b"\x00\x00")
  f = run_lint(skill)
  msgs = messages(f, "PK-01")
  assert "PK-01" in codes(f, "FAIL") and "__pycache__" in msgs and "clip.mp4" in msgs


def test_missing_header_fails(tmp_path: Path) -> None:
  pkg, skill = make_package(
    tmp_path, extra_files={"install.sh": "#!/bin/sh\necho hi\n", "benchmarks/x.py": "print(1)\n"}
  )
  f = run_lint(skill)
  msgs = messages(f, "PK-02")
  assert "PK-02" in codes(f, "FAIL") and "install.sh" in msgs and "benchmarks/x.py" in msgs


def test_zip_rules(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path)
  good = tmp_path / "good.zip"
  with zipfile.ZipFile(good, "w") as zf:
    zf.writestr("SKILL.md", "---\nname: demo-skill\n---\n")
    zf.writestr("scripts/tool.py", "print(1)\n")
  assert "PK-03" in codes(run_lint(skill, zip_path=good), "PASS")
  nested = tmp_path / "nested.zip"
  with zipfile.ZipFile(nested, "w") as zf:
    zf.writestr("demo-skill/SKILL.md", "x")
    zf.writestr("demo-skill/scripts/__pycache__/t.pyc", "x")
  f = run_lint(skill, zip_path=nested)
  assert "PK-03" in codes(f, "FAIL") and "archive root" in messages(f, "PK-03")
  f = run_lint(skill, zip_path=tmp_path / "absent.zip")
  assert "PK-03" in codes(f, "FAIL") and "does not exist" in messages(f, "PK-03")
  assert "PK-03" in codes(run_lint(skill), "SKIP")


def test_readme_rules(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, readme="# demo\nnothing here\n")
  f = run_lint(skill)
  msgs = messages(f, "PD-03")
  assert "PD-03" in codes(f, "FAIL")
  for label in ("disclaimer", "cost", "platform", "quota-project"):
    assert label in msgs, label
  _, skill2 = make_package(tmp_path / "b", readme=None)
  assert "PD-03" in codes(run_lint(skill2), "FAIL")


def test_registry_rules(tmp_path: Path) -> None:
  retired_default = json.loads(json.dumps(GOOD_REGISTRY))
  retired_default["models"][0]["status"] = "retired"
  _, skill = make_package(tmp_path / "a", registry=retired_default)
  f = run_lint(skill)
  assert "PD-04" in codes(f, "FAIL") and "retired default" in messages(f, "PD-04")

  no_api = json.loads(json.dumps(GOOD_REGISTRY))
  del no_api["models"][2]["api"]
  del no_api["models"][2]["last_verified"]
  _, skill = make_package(tmp_path / "b", registry=no_api)
  msgs = messages(run_lint(skill), "PD-04")
  assert "lacks api" in msgs and "lacks last_verified" in msgs

  _, skill = make_package(tmp_path / "c", registry=GOOD_REGISTRY)
  f = run_lint(skill, today=dt.date(2027, 6, 1))
  assert "PD-04" in codes(f, "WARN") and "PD-04" not in codes(f, "FAIL")

  _, skill = make_package(tmp_path / "d", registry=None)
  assert "PD-04" in codes(run_lint(skill), "FAIL")


def test_project_id_detection(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path)
  gen = skill / "scripts" / "generate_ad_spot_vertex.py"
  gen.write_text(
    HEADER + "P = 'projects/my-real-project-123/locations'\nX = '--dry-run --execute'\n",
    encoding="utf-8",
  )
  f = run_lint(skill)
  assert "PD-02" in codes(f, "FAIL")


def test_cli_output_format_and_exit(tmp_path: Path) -> None:
  _, skill = make_package(tmp_path, body="see https://wiki.internal.example.com/leak\n")
  proc = run_py(
    BENCH_DIR / "skill_lint.py", [str(skill), "--no-dry-run-check", "--today", "2026-11-23"]
  )
  assert proc.returncode == 1
  lines = proc.stdout.strip().splitlines()
  assert all(
    re.match(r"^(PASS|FAIL|WARN|SKIP) [A-Z]{2}-\d{2}: .+$|^SUMMARY fails=\d+ warns=\d+$", ln)
    for ln in lines
  ), lines
  assert lines[-1].startswith("SUMMARY fails=")
  assert any(ln.startswith("FAIL TX-02") for ln in lines)


# ---------------------------------------------------------------------------
# the real tree
# ---------------------------------------------------------------------------
def test_real_tree_prints_rule_lines() -> None:
  """Every rule of the 23-rule catalogue reports on the shipped tree, without tracebacks."""
  proc = run_py(BENCH_DIR / "skill_lint.py", [str(SKILL_DIR)])
  seen = {
    ln.split()[1].rstrip(":")
    for ln in proc.stdout.splitlines()
    if ln.split(" ", 1)[0] in {"PASS", "FAIL", "WARN", "SKIP"}
  }
  expected = {
    "FM-01",
    "FM-02",
    "FM-03",
    "FM-04",
    "FM-05",
    "SZ-01",
    "SZ-02",
    "TX-01",
    "TX-02",
    "TX-03",
    "TX-04",
    "PK-01",
    "PK-02",
    "PK-03",
    "PD-01",
    "PD-02",
    "PD-03",
    "PD-04",
  }
  for code in sorted(expected):
    assert code in seen, code
  assert "Traceback" not in proc.stderr


def test_real_tree_passes_lint() -> None:
  proc = run_py(BENCH_DIR / "skill_lint.py", [str(SKILL_DIR)])
  fails = [ln for ln in proc.stdout.splitlines() if ln.startswith("FAIL")]
  assert proc.returncode == 0 and not fails, "\n".join(fails)


def test_skill_md_has_no_v2_0_0_hazards() -> None:
  text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
  assert "/workspace/" not in text
  assert "allowed-tools" not in text.split("---")[1]
  assert text.isascii(), "SKILL.md must use ASCII punctuation"
  assert len(text.splitlines()) <= 200
