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
"""Tests for benchmarks/storyboard_checks.py and the shipped example storyboards."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import storyboard_checks
import storyboards
from conftest import BENCH_DIR, SKILL_DIR, run_py

SCHEMA_DOC = SKILL_DIR / "references" / "youtube_abcd_and_schema.md"
EXAMPLES = sorted((SKILL_DIR / "assets" / "examples").glob("*.json"))


def checks(sb: dict) -> set[str]:
  return {
    check for check, _ in storyboard_checks.check_storyboard(sb, storyboard_checks.BUILTIN_SCHEMA)
  }


def test_valid_generator_storyboard_passes() -> None:
  assert (
    storyboard_checks.check_storyboard(
      storyboards.generator_storyboard(), storyboard_checks.BUILTIN_SCHEMA
    )
    == []
  )


def test_word_count_rule() -> None:
  assert "words" in checks(storyboards.generator_storyboard(voiceover_words=20))
  assert "words" in checks(storyboards.generator_storyboard(voiceover_words=70))
  assert "words" not in checks(storyboards.generator_storyboard(voiceover_words=50))
  assert "words" not in checks(storyboards.generator_storyboard(voiceover_words=65))


def test_duration_aspect_music_rules() -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["shots"][0]["durationSeconds"] = 5
  assert "durations" in checks(sb)
  sb = storyboards.generator_storyboard(n=2)
  sb["totalDurationSeconds"] = 30
  assert "durations" in checks(sb)
  assert "aspect" in checks(storyboards.generator_storyboard(aspect="1:1"))
  assert "music" in checks(storyboards.generator_storyboard(music_prompt="Fr\u00f6hliche Musik"))


def test_motion_prompt_needs_three_clauses() -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["shots"][1]["motionPrompt"] = "[VISUAL ANCHOR LOCK] x. [CAMERA TRAJECTORY] y."
  assert "motion" in checks(sb)
  sb["shots"][1]["motionPrompt"] = (
    "[VISUAL ANCHOR LOCK] x. [CAMERA TRAJECTORY] y. [LIGHTING & MICRO-PHYSICS] z."
  )
  assert "motion" not in checks(sb)


@pytest.mark.parametrize(
  "visual",
  [
    "Bottle on slate with the text SHOP NOW on screen",
    "Visit nordicglow.example today",
    'Banner reading "Reveal Your Natural Radiance" above the product',
    "see https://example.com",
  ],
)
def test_copy_in_visual_prompt_is_flagged(visual: str) -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["shots"][0]["visualPrompt"] = visual
  assert "copy" in checks(sb), visual


def test_clean_visual_prompt_with_hex_codes_is_fine() -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["shots"][0]["visualPrompt"] = (
    "Cinematic macro photography on dark slate (#0F172A) with ice-blue (#38BDF8) rim light, shallow depth "
    "of field. Clean commercial cinema frame with no overlaid UI text, buttons, subtitles, or watermarks."
  )
  assert "copy" not in checks(sb)


def test_emoji_flagged() -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["campaignTitle"] = "Launch \U0001f680"
  assert "emoji" in checks(sb)


def test_schema_extraction_from_reference(tmp_path: Path) -> None:
  doc = tmp_path / "ref.md"
  doc.write_text(
    'intro\n```json\n{"not": "a schema"}\n```\n```json\n'
    + json.dumps(storyboard_checks.BUILTIN_SCHEMA)
    + "\n```\n",
    encoding="utf-8",
  )
  schema = storyboard_checks.extract_schema(doc)
  assert schema and "properties" in schema
  assert storyboard_checks.extract_schema(tmp_path / "missing.md") is None


def test_cli_exit_codes(tmp_path: Path) -> None:
  good = storyboards.write_json(tmp_path / "good.json", storyboards.generator_storyboard())
  bad = storyboards.write_json(
    tmp_path / "bad.json", storyboards.generator_storyboard(voiceover_words=10)
  )
  proc = run_py(BENCH_DIR / "storyboard_checks.py", ["--builtin-schema", str(good)])
  assert proc.returncode == 0 and proc.stdout.strip().endswith(f"OK {good}"), proc.stdout
  proc = run_py(BENCH_DIR / "storyboard_checks.py", ["--builtin-schema", str(good), str(bad)])
  assert proc.returncode == 1 and "FAIL" in proc.stdout and "words" in proc.stdout
  (tmp_path / "broken.json").write_text("{", encoding="utf-8")
  proc = run_py(
    BENCH_DIR / "storyboard_checks.py", ["--builtin-schema", str(tmp_path / "broken.json")]
  )
  assert proc.returncode == 1 and "json" in proc.stdout


def test_reference_schema_is_v2_1() -> None:
  schema = storyboard_checks.extract_schema(SCHEMA_DOC)
  assert schema, "reference must embed the storyboard JSON schema"
  shots = schema["properties"]["shots"]
  assert shots.get("maxItems") == 6 and shots.get("minItems") == 2
  assert shots["items"]["properties"]["durationSeconds"].get("enum") == [4, 6, 8]
  assert schema["properties"]["aspectRatio"]["enum"] == ["16:9", "9:16"]


@pytest.mark.parametrize("example", EXAMPLES, ids=lambda p: p.name)
def test_shipped_examples_pass_checks(example: Path) -> None:
  proc = run_py(BENCH_DIR / "storyboard_checks.py", [str(example)])
  assert proc.returncode == 0, proc.stdout
  assert "schema: youtube_abcd_and_schema.md" in proc.stdout
