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
"""Deterministic storyboard checks (run before any LLM-judged storyboard eval).

For every storyboard JSON given on the command line:
  schema       validates against the JSON schema embedded in
               scene-machine/references/youtube_abcd_and_schema.md (first fenced json
               block containing "$schema" or "properties"); falls back to a built-in
               minimal schema when the document or the block is absent
  words        audioSpec.voiceoverScript has 50-65 words
  durations    every shots[].durationSeconds is 4, 6 or 8 and the total matches
  aspect       aspectRatio is 16:9 or 9:16
  motion       every motionPrompt carries the three bracketed clauses
               [VISUAL ANCHOR LOCK] ... [CAMERA TRAJECTORY] ... [LIGHTING & MICRO-PHYSICS]
  copy         no slogans/URLs/CTA text inside visualPrompt
  music        audioSpec.musicPrompt is ASCII (lyria-002 accepts en-US prompts)
  emoji        no emoji anywhere in the storyboard

Prints ``OK <file>`` or ``FAIL <file>: <check>: <reason>`` lines; exit 1 on any failure.
Usage: storyboard_checks.py [--schema-doc PATH | --builtin-schema] <storyboard.json> [...]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

try:
  import jsonschema
except ImportError:  # pragma: no cover - jsonschema is pinned in requirements-dev.txt
  jsonschema = None

HERE = Path(__file__).resolve().parent
DEFAULT_SCHEMA_DOC = HERE.parent / "scene-machine" / "references" / "youtube_abcd_and_schema.md"
ALLOWED_DURATIONS = (4, 6, 8)
MOTION_RE = re.compile(
  r"\[VISUAL ANCHOR LOCK\].+\[CAMERA TRAJECTORY\].+\[LIGHTING\s*&\s*MICRO-PHYSICS\].+", re.I | re.S
)
COPY_PATTERNS = [
  (re.compile(r"https?://|www\.", re.I), "URL"),
  (re.compile(r"\b[\w-]+\.(?:com|de|net|org|io|co|shop|example|app)\b", re.I), "domain"),
  (
    re.compile(
      r"\b(?:SHOP NOW|BUY NOW|LEARN MORE|ORDER NOW|SIGN UP|JETZT KAUFEN|MEHR ERFAHREN|"
      r"DISCOVER MORE|GET YOURS|CLICK HERE)\b",
      re.I,
    ),
    "call-to-action text",
  ),
  (re.compile(r"[\"\u201c][^\"\u201d]{3,}[\"\u201d]"), "quoted slogan"),
]
BUILTIN_SCHEMA: dict[str, Any] = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["brandName", "aspectRatio", "shots"],
  "properties": {
    "brandName": {"type": "string", "minLength": 1},
    "aspectRatio": {"type": "string", "enum": ["16:9", "9:16"]},
    "language": {"type": "string"},
    "shots": {
      "type": "array",
      "minItems": 2,
      "maxItems": 6,
      "items": {
        "type": "object",
        "required": ["shotIndex", "durationSeconds", "visualPrompt", "motionPrompt"],
        "properties": {
          "shotIndex": {"type": "integer", "minimum": 1},
          "durationSeconds": {"type": "number", "enum": [4, 6, 8]},
          "visualPrompt": {"type": "string", "minLength": 1},
          "motionPrompt": {"type": "string", "minLength": 1},
        },
      },
    },
  },
}


def extract_schema(doc: Path) -> dict[str, Any] | None:
  """First fenced ```json block of the reference that looks like a JSON schema."""
  if not doc.is_file():
    return None
  text = doc.read_text(encoding="utf-8", errors="replace")
  for block in re.findall(r"```json\s*\n(.*?)```", text, re.S):
    if "$schema" in block or '"properties"' in block:
      try:
        data = json.loads(block)
      except ValueError:
        continue
      if isinstance(data, dict) and "properties" in data:
        return data
  return None


def is_emoji(ch: str) -> bool:
  cp = ord(ch)
  if 0x1F000 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF:
    return True
  return unicodedata.category(ch) == "So" and not (0x2500 <= cp <= 0x257F)


def check_storyboard(sb: Any, schema: dict[str, Any]) -> list[tuple[str, str]]:
  """Returns a list of (check, reason) failures; empty means the storyboard passes."""
  problems: list[tuple[str, str]] = []
  if not isinstance(sb, dict):
    return [("schema", "storyboard is not a JSON object")]
  if jsonschema is not None:
    validator_cls = jsonschema.validators.validator_for(schema)
    validator = validator_cls(schema)
    for err in sorted(validator.iter_errors(sb), key=lambda e: list(e.absolute_path)):
      path = "/".join(str(p) for p in err.absolute_path) or "<root>"
      problems.append(("schema", f"{path}: {err.message}"))
  else:
    problems.append(("schema", "jsonschema not installed; schema check skipped"))

  audio = sb.get("audioSpec") or {}
  script = str(audio.get("voiceoverScript") or "")
  words = len(script.split())
  if script and not 50 <= words <= 65:
    problems.append(("words", f"voiceoverScript has {words} words (50-65 required)"))
  music = audio.get("musicPrompt")
  if isinstance(music, str) and not music.isascii():
    problems.append(("music", "musicPrompt is not ASCII (lyria-002 accepts en-US prompts)"))

  aspect = sb.get("aspectRatio")
  if aspect not in ("16:9", "9:16"):
    problems.append(("aspect", f"aspectRatio {aspect!r} is not 16:9 or 9:16"))

  total = 0.0
  for i, shot in enumerate(sb.get("shots") or [], start=1):
    if not isinstance(shot, dict):
      problems.append(("schema", f"shots[{i - 1}] is not an object"))
      continue
    idx = shot.get("shotIndex", i)
    dur = shot.get("durationSeconds")
    if (
      isinstance(dur, bool)
      or not isinstance(dur, (int, float))
      or float(dur) not in ALLOWED_DURATIONS
    ):
      problems.append(
        ("durations", f"shot {idx}: durationSeconds {dur!r} not in {list(ALLOWED_DURATIONS)}")
      )
    else:
      total += float(dur)
    motion = str(shot.get("motionPrompt") or "")
    if not MOTION_RE.search(motion):
      problems.append(("motion", f"shot {idx}: motionPrompt lacks the three bracketed clauses"))
    visual = str(shot.get("visualPrompt") or "")
    for pattern, label in COPY_PATTERNS:
      m = pattern.search(visual)
      if m:
        problems.append(("copy", f"shot {idx}: visualPrompt contains {label} {m.group(0)!r}"))
        break
  declared = sb.get("totalDurationSeconds")
  if (
    isinstance(declared, (int, float))
    and not isinstance(declared, bool)
    and total
    and abs(float(declared) - total) > 0.01
  ):
    problems.append(("durations", f"totalDurationSeconds {declared} != sum of shots {total:g}"))

  blob = json.dumps(sb, ensure_ascii=False)
  bad = sorted({f"U+{ord(ch):04X}" for ch in blob if is_emoji(ch)})
  if bad:
    problems.append(("emoji", f"emoji code points present: {', '.join(bad[:5])}"))
  return problems


def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(description="Deterministic storyboard checks.")
  ap.add_argument("files", nargs="+")
  ap.add_argument(
    "--schema-doc",
    default=str(DEFAULT_SCHEMA_DOC),
    help="markdown file whose first json-schema block is used (default: the skill reference)",
  )
  ap.add_argument(
    "--builtin-schema", action="store_true", help="ignore the reference and use the built-in schema"
  )
  args = ap.parse_args(argv)
  schema = None if args.builtin_schema else extract_schema(Path(args.schema_doc))
  source = "builtin" if schema is None else Path(args.schema_doc).name
  if schema is None:
    schema = BUILTIN_SCHEMA
  print(f"schema: {source}")
  rc = 0
  for raw in args.files:
    path = Path(raw)
    try:
      sb = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
      print(f"FAIL {path}: json: {exc}")
      rc = 1
      continue
    problems = check_storyboard(sb, schema)
    if problems:
      rc = 1
      for check, reason in problems:
        print(f"FAIL {path}: {check}: {reason}")
    else:
      print(f"OK {path}")
  return rc


if __name__ == "__main__":
  sys.exit(main())
