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
"""Static conformance lint for the scene-machine Agent Skills package.

Prints one ``PASS|FAIL|WARN|SKIP <CODE>: <message>`` line per finding and a
``SUMMARY fails=N warns=M`` line; exits 1 when anything FAILed.

  FM-01  frontmatter parses as YAML with a closing ``---``
  FM-02  name matches ^[a-z0-9]+(-[a-z0-9]+)*$, <= 64 chars, equals the directory
  FM-03  description non-empty, <= 1024 chars
  FM-04  only known top-level keys (name, description, license, allowed-tools,
         compatibility, metadata) - WARN otherwise
  FM-05  metadata values are strings; compatibility <= 500 chars
  SZ-01  SKILL.md <= 500 lines (WARN above the 35 000-byte internal soft limit)
  SZ-02  body <= 5000 words (WARN)
  TX-01  no emoji code points in any text file (box drawing allowed)
  TX-02  no internal references: local workstation home paths (/Users/...,
         /home/..., /usr/local/<org>/home/...), private/corporate hostnames
         (*.corp.*, *.internal.*, *.intranet, *.localdomain, corp.*), or
         custom --internal-terms. Public model ids are never flagged. Files
         containing the marker ``skill-lint: allow-internal-patterns`` (this
         lint and its tests) are exempt.
  TX-03  every references/, scripts/, assets/ path mentioned in SKILL.md resolves
  TX-04  no configured third-party brand terms (--brand-terms) in the package - WARN
  PK-01  no __pycache__, .pyc, .DS_Store, venvs or media binaries in the package
  PK-02  Apache-2.0 header in every .py and .sh (skill dir, tests/, benchmarks/, install.sh)
  PK-03  with --zip: the archive exists, has SKILL.md at the root, scripts/, no junk, < 10 MB
  PD-01  generator offers --dry-run/--execute, dry-run is the default and a dry-run
         subprocess with google.genai blocked exits 0 and prints the dry_run JSON
  PD-02  no hard-coded GCP project ids in the scripts
  PD-03  README contains the OSS disclaimer, a cost note, the platform statement
         and the ADC quota-project note
  PD-04  model_registry.json: no retired default, api + last_verified on every
         active/preview/default entry, last_verified < 180 days old (WARN beyond)

Usage: skill_lint.py <skill_dir> [--zip FILE] [--package-root DIR] [--today YYYY-MM-DD]
                     [--brand-terms a,b] [--internal-terms a,b] [--max-lines N] [--no-dry-run-check]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from typing import Iterable

import yaml

# skill-lint: allow-internal-patterns (this file defines the patterns it searches for)

KNOWN_KEYS = {"name", "description", "license", "allowed-tools", "compatibility", "metadata"}
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
EXEMPT_MARKER = "skill-lint: allow-internal-patterns"
INTERNAL_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
  (
    re.compile(r"(?:/Users|/home|/usr/local/[A-Za-z0-9_-]+/home)/[A-Za-z0-9._-]+"),
    "local workstation home path",
  ),
  (
    re.compile(
      r"(?i)\b(?:[a-z0-9-]+\.(?:corp|internal|intranet|localdomain)(?:\.[a-z]{2,})?"
      r"|corp\.[a-z0-9-]+\.[a-z]{2,})\b"
    ),
    "private/corporate hostname",
  ),
)
DEFAULT_BRAND_TERMS: tuple[str, ...] = ()
BINARY_EXT = {
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".wav",
  ".mp3",
  ".aac",
  ".m4a",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".zip",
  ".tar",
  ".gz",
}
TEXT_EXT = {
  ".md",
  ".py",
  ".json",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".cfg",
  ".ini",
  ".sh",
  ".txtpb",
}
TEXT_NAMES = {"Makefile", "NOTICE", "LICENSE", "CONTRIBUTING", ".gitignore"}
SKIP_DIRS = {
  "dist",
  ".git",
  ".pytest-tmp",
  ".pytest_cache",
  ".ruff_cache",
  ".scene_machine",
  ".venv",
  "venv",
}
README_RULES = [
  (re.compile(r"This is not an officially supported Google product\."), "OSS disclaimer sentence"),
  (re.compile(r"(?i)\bcost\b"), "cost note"),
  (re.compile(r"Linux and macOS"), "platform statement"),
  (re.compile(r"set-quota-project"), "ADC quota-project note"),
]
PROJECT_ID_RE = re.compile(
  r"project\s*=\s*[\"'][a-z][a-z0-9-]{4,}[\"']|projects/[a-z][a-z0-9-]{4,}/"
)
HEADER_TOKENS = ("Licensed under the Apache License, Version 2.0", "Copyright")
REGISTRY_MAX_AGE_DAYS = 180
ZIP_MAX_BYTES = 10 * 1024 * 1024

FALLBACK_STORYBOARD = {
  "brandName": "NordicGlow",
  "language": "en-US",
  "aspectRatio": "16:9",
  "totalDurationSeconds": 30,
  "brandPalette": {
    "backgroundHex": "#0F172A",
    "primaryAccentHex": "#38BDF8",
    "secondaryAccentHex": "#F59E0B",
    "textLightHex": "#F8FAFC",
  },
  "endcardSpec": {
    "enabled": True,
    "headline": "Reveal Your Natural Radiance",
    "ctaText": "Discover More",
    "ctaUrl": "nordicglow.example",
  },
  "audioSpec": {
    "voiceoverScript": (
      "Cold mornings leave skin feeling tired and tight. Meet NordicGlow Radiant Renewal Serum, "
      "made with wild Arctic cloudberries and pure hyaluronic acid. One drop delivers deep, lasting "
      "hydration and restores a luminous, balanced glow in twenty-four hours. Dermatologically tested, "
      "fragrance free, and gentle enough for every morning. Reveal your natural radiance today with "
      "NordicGlow."
    ),
    "musicPrompt": "Modern Scandinavian ambient pop commercial soundtrack, warm synth arpeggios, instrumental.",
  },
  "shots": [
    {
      "shotIndex": i,
      "abcdStage": stage,
      "durationSeconds": 6,
      "visualPrompt": f"Scene {i}: clean commercial cinema frame with no overlaid UI text.",
      "motionPrompt": "[VISUAL ANCHOR LOCK] product stays fixed. [CAMERA TRAJECTORY] Slow Dolly Push-In. "
      "[LIGHTING & MICRO-PHYSICS] warm light drifts gently.",
      "typoOverlay": {"headline": f"Headline {i}", "subtext": "Subtext"},
    }
    for i, stage in enumerate(["Attract", "Brand", "Connect", "Proof", "Direct"], start=1)
  ],
}


class Findings:
  def __init__(self) -> None:
    self.items: list[tuple[str, str, str]] = []

  def add(self, level: str, code: str, msg: str) -> None:
    self.items.append((level, code, msg))

  def fail(self, code: str, msg: str) -> None:
    self.add("FAIL", code, msg)

  def warn(self, code: str, msg: str) -> None:
    self.add("WARN", code, msg)

  def ok(self, code: str, msg: str) -> None:
    self.add("PASS", code, msg)

  def skip(self, code: str, msg: str) -> None:
    self.add("SKIP", code, msg)

  @property
  def fails(self) -> int:
    return sum(1 for lvl, _, _ in self.items if lvl == "FAIL")

  @property
  def warns(self) -> int:
    return sum(1 for lvl, _, _ in self.items if lvl == "WARN")

  def codes(self, level: str) -> list[str]:
    return sorted({code for lvl, code, _ in self.items if lvl == level})


def is_emoji(ch: str) -> bool:
  cp = ord(ch)
  if (
    0x1F000 <= cp <= 0x1FAFF
    or 0x2600 <= cp <= 0x27BF
    or cp in (0x2705, 0x274C, 0x2B50, 0x203C, 0x2049)
  ):
    return True
  return unicodedata.category(ch) == "So" and not (0x2500 <= cp <= 0x257F)


def iter_files(root: Path) -> Iterable[Path]:
  for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
    for name in sorted(filenames):
      yield Path(dirpath) / name


def is_text(path: Path) -> bool:
  return path.suffix.lower() in TEXT_EXT or path.name in TEXT_NAMES


def rel(path: Path, root: Path) -> str:
  try:
    return str(path.relative_to(root))
  except ValueError:
    return str(path)


# ---------------------------------------------------------------------------
# rule groups
# ---------------------------------------------------------------------------
def lint_frontmatter(f: Findings, root: Path, max_lines: int) -> str | None:
  skill_md = root / "SKILL.md"
  if not skill_md.is_file():
    f.fail("FM-01", f"{skill_md} missing")
    return None
  text = skill_md.read_text(encoding="utf-8")
  m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
  if not m:
    f.fail("FM-01", "frontmatter block not found or not closed")
    return text
  try:
    fm = yaml.safe_load(m.group(1)) or {}
  except yaml.YAMLError as exc:
    f.fail("FM-01", f"frontmatter YAML error: {exc}")
    return text
  if not isinstance(fm, dict):
    f.fail("FM-01", "frontmatter is not a mapping")
    return text
  f.ok("FM-01", "frontmatter parses")

  name = str(fm.get("name", "") or "")
  if NAME_RE.match(name) and len(name) <= 64 and name == root.name:
    f.ok("FM-02", f"name '{name}' valid and equals the directory")
  elif not NAME_RE.match(name) or len(name) > 64:
    f.fail("FM-02", f"name '{name}' invalid (kebab-case, <= 64 chars)")
  else:
    f.fail("FM-02", f"name '{name}' != directory '{root.name}'")

  desc = str(fm.get("description", "") or "")
  if desc.strip() and len(desc) <= 1024:
    f.ok("FM-03", f"description {len(desc)} chars")
  else:
    f.fail("FM-03", f"description empty or > 1024 chars ({len(desc)})")

  unknown = sorted(set(fm) - KNOWN_KEYS)
  if unknown:
    f.warn("FM-04", f"unknown frontmatter keys {unknown} (ignored by most runtimes)")
  else:
    f.ok("FM-04", "only known frontmatter keys")

  meta = fm.get("metadata") or {}
  bad_meta = (
    [k for k, v in meta.items() if not isinstance(v, str)]
    if isinstance(meta, dict)
    else ["metadata"]
  )
  compat = fm.get("compatibility")
  if bad_meta:
    f.fail("FM-05", f"metadata values must be strings: {bad_meta}")
  elif compat is not None and len(str(compat)) > 500:
    f.fail("FM-05", f"compatibility is {len(str(compat))} chars (max 500)")
  else:
    f.ok(
      "FM-05", "metadata values are strings" + ("; compatibility <= 500 chars" if compat else "")
    )

  nlines = len(text.splitlines())
  nbytes = len(text.encode("utf-8"))
  if nlines > max_lines:
    f.fail("SZ-01", f"SKILL.md has {nlines} lines (> {max_lines})")
  elif nbytes > 35000:
    f.warn("SZ-01", f"SKILL.md {nlines} lines, {nbytes} bytes (> 35000-byte internal soft limit)")
  else:
    f.ok("SZ-01", f"SKILL.md {nlines} lines, {nbytes} bytes")
  words = len(text[m.end() :].split())
  if words <= 5000:
    f.ok("SZ-02", f"body {words} words")
  else:
    f.warn("SZ-02", f"body {words} words (> 5000)")
  return text


def lint_text_files(
  f: Findings, package_root: Path, brand_terms: tuple[str, ...], internal_terms: tuple[str, ...]
) -> None:
  emoji_hits: list[str] = []
  internal_hits: list[str] = []
  brand_hits: list[str] = []
  exempt: list[str] = []
  scanned = 0
  for path in iter_files(package_root):
    if not is_text(path):
      continue
    scanned += 1
    try:
      text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
      continue
    r = rel(path, package_root)
    is_exempt = EXEMPT_MARKER in text
    if is_exempt:
      exempt.append(r)
    for ln, line in enumerate(text.splitlines(), 1):
      if any(is_emoji(ch) for ch in line):
        cps = ",".join(f"U+{ord(ch):04X}" for ch in line if is_emoji(ch))
        emoji_hits.append(f"{r}:{ln} {cps}")
      if is_exempt:
        continue
      low = line.lower()
      for term in brand_terms:
        if term and term.lower() in low:
          brand_hits.append(f"{r}:{ln} '{term}'")
      for pattern, label in INTERNAL_PATTERNS:
        if pattern.search(line):
          internal_hits.append(f"{r}:{ln} {label}: {line.strip()[:100]}")
      for term in internal_terms:
        if term and term in line:
          internal_hits.append(f"{r}:{ln} internal term '{term}'")
  if emoji_hits:
    for hit in emoji_hits[:20]:
      f.fail("TX-01", f"emoji in {hit}")
  else:
    f.ok("TX-01", f"no emoji in {scanned} text files")
  if internal_hits:
    for hit in internal_hits[:40]:
      f.fail("TX-02", hit)
  else:
    note = f" ({len(exempt)} file(s) exempt by marker: {', '.join(exempt)})" if exempt else ""
    f.ok("TX-02", f"no internal references in {scanned} text files{note}")
  if brand_hits:
    for hit in brand_hits[:20]:
      f.warn("TX-04", f"third-party brand in {hit}")
  elif brand_terms:
    f.ok("TX-04", f"no third-party brand terms ({', '.join(brand_terms)})")
  else:
    f.ok("TX-04", "no configured brand terms found")


def lint_references(f: Findings, root: Path, skill_text: str | None) -> None:
  if skill_text is None:
    return
  refs = sorted(set(re.findall(r"(?<![\w/])(?:references|scripts|assets)/[\w./-]+", skill_text)))
  refs = [r.rstrip(".,;:)") for r in refs]
  if not refs:
    f.warn("TX-03", "SKILL.md mentions no references/, scripts/ or assets/ path")
  for r in refs:
    if (root / r).exists():
      f.ok("TX-03", f"{r} resolves")
    else:
      f.fail("TX-03", f"{r} mentioned in SKILL.md does not resolve under {root.name}/")


def lint_package_hygiene(f: Findings, root: Path, package_root: Path) -> None:
  stray: list[str] = []
  binaries: list[str] = []
  for path in iter_files(package_root):
    r = rel(path, package_root)
    parts = set(path.relative_to(package_root).parts)
    if "__pycache__" in parts or path.suffix in {".pyc", ".pyo"} or path.name == ".DS_Store":
      stray.append(r)
    elif parts & {"venv", ".venv", "site-packages"}:
      stray.append(r)
    elif path.suffix.lower() in BINARY_EXT:
      binaries.append(r)
  for r in stray[:20]:
    f.fail("PK-01", f"stray artifact {r}")
  if not stray:
    f.ok("PK-01", f"no __pycache__, .pyc, .DS_Store or venv under {package_root.name}/")
  for r in binaries[:20]:
    f.fail("PK-01", f"binary/media file {r} must not ship")
  if not binaries:
    f.ok("PK-01", f"no media binaries under {package_root.name}/")

  header_dirs = [root, package_root / "tests", package_root / "benchmarks"]
  candidates: list[Path] = []
  for base in header_dirs:
    if base.is_dir():
      candidates.extend(p for p in iter_files(base) if p.suffix in {".py", ".sh"})
  for extra in (package_root / "install.sh",):
    if extra.is_file():
      candidates.append(extra)
  missing_header = []
  for path in sorted(set(candidates)):
    head = path.read_text(encoding="utf-8", errors="replace")[:1500]
    if not all(tok in head for tok in HEADER_TOKENS):
      missing_header.append(rel(path, package_root))
  for r in missing_header:
    f.fail("PK-02", f"{r} lacks the Apache-2.0 header")
  if not missing_header:
    f.ok("PK-02", f"Apache-2.0 header present in {len(set(candidates))} .py/.sh files")


def lint_zip(f: Findings, zip_path: Path | None) -> None:
  if zip_path is None:
    f.skip("PK-03", "zip layout not checked (pass --zip dist/scene-machine.zip)")
    return
  if not zip_path.is_file():
    f.fail("PK-03", f"{zip_path} does not exist (run make zip first)")
    return
  size = zip_path.stat().st_size
  try:
    with zipfile.ZipFile(zip_path) as zf:
      names = zf.namelist()
  except zipfile.BadZipFile as exc:
    f.fail("PK-03", f"{zip_path} is not a zip file: {exc}")
    return
  problems = []
  if "SKILL.md" not in names:
    problems.append(f"SKILL.md not at the archive root (entries: {names[:5]})")
  if not any(n.startswith("scripts/") and n.endswith(".py") for n in names):
    problems.append("no scripts/*.py in the archive")
  junk = [
    n
    for n in names
    if "__pycache__" in n
    or n.endswith(".pyc")
    or ".DS_Store" in n
    or Path(n).suffix.lower() in BINARY_EXT - {".zip"}
  ]
  if junk:
    problems.append(f"junk entries {junk[:5]}")
  if size >= ZIP_MAX_BYTES:
    problems.append(f"archive is {size} bytes (>= 10 MB)")
  for p in problems:
    f.fail("PK-03", p)
  if not problems:
    f.ok("PK-03", f"{zip_path.name}: SKILL.md at root, {len(names)} entries, {size} bytes")


def lint_generator(f: Findings, root: Path, run_dry_run: bool) -> None:
  gen = root / "scripts" / "generate_ad_spot_vertex.py"
  if not gen.is_file():
    f.skip("PD-01", "scripts/generate_ad_spot_vertex.py not present")
    f.skip("PD-02", "no generator script to scan")
    return
  src = gen.read_text(encoding="utf-8", errors="replace")
  if "--dry-run" not in src or "--execute" not in src:
    f.fail("PD-01", "generator source does not define both --dry-run and --execute")
    return
  f.ok("PD-01", "generator defines --dry-run and --execute")
  scripts_src = "\n".join(
    p.read_text(encoding="utf-8", errors="replace") for p in sorted((root / "scripts").glob("*.py"))
  )
  hard = PROJECT_ID_RE.findall(scripts_src)
  if hard:
    f.fail("PD-02", f"hard-coded project id(s): {sorted(set(hard))[:5]}")
  else:
    f.ok("PD-02", "no hard-coded project ids in scripts/")
  if not run_dry_run:
    f.skip("PD-01", "dry-run subprocess check disabled (--no-dry-run-check)")
    return
  example = root / "assets" / "examples" / "storyboard_5x6.json"
  with tempfile.TemporaryDirectory(prefix="skill_lint_") as tmp:
    tmp_dir = Path(tmp)
    if not example.is_file():
      example = tmp_dir / "storyboard.json"
      example.write_text(json.dumps(FALLBACK_STORYBOARD, indent=2), encoding="utf-8")
    bootstrap = (
      "import sys, runpy; sys.modules['google'] = None; sys.modules['google.genai'] = None; "
      "sys.modules['google.auth'] = None; "
      f"sys.argv = [{str(gen)!r}] + sys.argv[1:]; runpy.run_path({str(gen)!r}, run_name='__main__')"
    )
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["SCENE_MACHINE_WORKDIR"] = str(tmp_dir / "wd")
    env.pop("GOOGLE_CLOUD_PROJECT", None)
    try:
      helper = subprocess.run(
        [sys.executable, "-c", bootstrap, "--help"],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
        check=False,
      )
      proc = subprocess.run(
        [
          sys.executable,
          "-c",
          bootstrap,
          "--storyboard",
          str(example),
          "--output-dir",
          str(tmp_dir / "out"),
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
      )
    except subprocess.TimeoutExpired:
      f.fail("PD-01", "dry-run subprocess timed out")
      return
  if helper.returncode != 0 or "--dry-run" not in helper.stdout or "--execute" not in helper.stdout:
    f.fail(
      "PD-01",
      f"--help without google-genai failed (exit {helper.returncode}) or lacks --dry-run/--execute",
    )
    return
  last = [ln for ln in proc.stdout.splitlines() if ln.strip()]
  payload = None
  if last:
    try:
      payload = json.loads(last[-1])
    except ValueError:
      payload = None
  if proc.returncode != 0 or not isinstance(payload, dict) or payload.get("status") != "dry_run":
    tail = (proc.stderr.strip().splitlines() or [""])[-1][:160]
    f.fail(
      "PD-01", f"default run is not a dry-run without google-genai (exit {proc.returncode}): {tail}"
    )
  elif payload.get("rendered") is not False or "primary_video" in payload:
    f.fail("PD-01", "dry-run JSON must say rendered=false and carry no primary_video")
  else:
    f.ok(
      "PD-01",
      f"default mode is dry-run without google-genai (planned_calls={payload.get('planned_calls')})",
    )


def lint_readme(f: Findings, package_root: Path) -> None:
  readme = package_root / "README.md"
  if not readme.is_file():
    f.fail("PD-03", f"{readme} missing")
    return
  text = readme.read_text(encoding="utf-8", errors="replace")
  missing = [label for pattern, label in README_RULES if not pattern.search(text)]
  for label in missing:
    f.fail("PD-03", f"README.md lacks the {label}")
  if not missing:
    f.ok("PD-03", "README has the disclaimer, cost note, platform statement and quota-project note")


def lint_registry(f: Findings, root: Path, today: dt.date) -> None:
  reg_path = root / "scripts" / "model_registry.json"
  if not reg_path.is_file():
    f.fail("PD-04", "scripts/model_registry.json missing")
    return
  try:
    registry = json.loads(reg_path.read_text(encoding="utf-8"))
    models = registry["models"]
  except (ValueError, KeyError, TypeError) as exc:
    f.fail("PD-04", f"model_registry.json unreadable: {exc}")
    return
  problems: list[str] = []
  stale: list[str] = []
  defaults: dict[str, list[str]] = {}
  for entry in models:
    mid = entry.get("id", "?")
    status = entry.get("status")
    if entry.get("default"):
      defaults.setdefault(entry.get("kind", "?"), []).append(mid)
      if status == "retired":
        problems.append(f"{mid} is a retired default")
    if status in {"active", "preview"} or entry.get("default"):
      if not entry.get("api"):
        problems.append(f"{mid} lacks api")
      if not entry.get("last_verified"):
        problems.append(f"{mid} lacks last_verified")
      else:
        try:
          age = (today - dt.date.fromisoformat(str(entry["last_verified"]))).days
        except ValueError:
          problems.append(f"{mid} last_verified is not YYYY-MM-DD")
          continue
        if age >= REGISTRY_MAX_AGE_DAYS:
          stale.append(f"{mid} ({age} days)")
  for kind, ids in defaults.items():
    if len(ids) > 1:
      problems.append(f"kind {kind} has several defaults {ids}")
  for p in problems:
    f.fail("PD-04", p)
  if stale:
    f.warn(
      "PD-04",
      f"last_verified older than {REGISTRY_MAX_AGE_DAYS} days: {', '.join(stale)} - re-verify",
    )
  if not problems and not stale:
    f.ok(
      "PD-04",
      f"registry has {len(models)} models, defaults {sorted(defaults)}, all verified recently",
    )


# ---------------------------------------------------------------------------
def lint(
  skill_dir: Path,
  package_root: Path | None = None,
  zip_path: Path | None = None,
  today: dt.date | None = None,
  brand_terms: tuple[str, ...] = DEFAULT_BRAND_TERMS,
  internal_terms: tuple[str, ...] = (),
  max_lines: int = 500,
  run_dry_run: bool = True,
) -> Findings:
  root = Path(skill_dir).resolve()
  package_root = Path(package_root).resolve() if package_root else root.parent
  today = today or dt.date.today()
  f = Findings()
  skill_text = lint_frontmatter(f, root, max_lines)
  lint_text_files(f, package_root, brand_terms, internal_terms)
  lint_references(f, root, skill_text)
  lint_package_hygiene(f, root, package_root)
  lint_zip(f, zip_path)
  lint_generator(f, root, run_dry_run)
  lint_readme(f, package_root)
  lint_registry(f, root, today)
  return f


def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(
    description="Static conformance lint for the scene-machine skill package."
  )
  ap.add_argument("skill_dir")
  ap.add_argument("--zip", default=None, help="dist/scene-machine.zip to check (PK-03)")
  ap.add_argument(
    "--package-root", default=None, help="package root (default: parent of skill_dir)"
  )
  ap.add_argument("--today", default=None, help="override today's date for PD-04 (YYYY-MM-DD)")
  ap.add_argument("--brand-terms", default=",".join(DEFAULT_BRAND_TERMS))
  ap.add_argument("--internal-terms", default="")
  ap.add_argument("--max-lines", type=int, default=500)
  ap.add_argument("--no-dry-run-check", action="store_true")
  args = ap.parse_args(argv)
  today = dt.date.fromisoformat(args.today) if args.today else None
  findings = lint(
    Path(args.skill_dir),
    args.package_root,
    Path(args.zip) if args.zip else None,
    today,
    tuple(t for t in args.brand_terms.split(",") if t),
    tuple(t for t in args.internal_terms.split(",") if t),
    args.max_lines,
    not args.no_dry_run_check,
  )
  for level, code, msg in findings.items:
    print(f"{level} {code}: {msg}")
  print(f"SUMMARY fails={findings.fails} warns={findings.warns}")
  return 1 if findings.fails else 0


if __name__ == "__main__":
  sys.exit(main())
