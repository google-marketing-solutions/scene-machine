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
"""Render benchmark (``-m bench``): wall time, durations, frames, loudness vs the v2.0.0 baseline.

Renders the 5 x 6 s 16:9, 3 x 6 s and 9:16 + 1:1 cases with the real assembler
on lavfi media, writes ``benchmarks/results/latest.json`` and prints a
comparison table against ``benchmarks/results/baseline_v2.0.0.json``. Fails when
a render exits non-zero, a duration/loudness/true-peak gate fails, or the wall
time exceeds ``SM_BENCH_WALL_FACTOR`` (default 2.0) times the baseline.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

import media_probe

pytestmark = pytest.mark.bench

BENCH_DIR = Path(__file__).resolve().parent
ROOT = BENCH_DIR.parent
ASSEMBLER = ROOT / "scene-machine" / "scripts" / "assemble_ad_video.py"
RESULTS_DIR = BENCH_DIR / "results"
BASELINE = RESULTS_DIR / "baseline_v2.0.0.json"
LATEST = RESULTS_DIR / "latest.json"
VERSION = "2.1.0"
CASES: dict[str, dict[str, Any]] = {
  "sb_5x6_16x9": {"files": {"final_video_16x9.mp4": (1280, 720)}, "duration": 30.0, "frames": 720},
  "sb_3x6_16x9": {"files": {"final_video_16x9.mp4": (1280, 720)}, "duration": 18.0, "frames": 432},
  "sb_5x6_9x16_square": {
    "files": {"final_video_9x16.mp4": (720, 1280), "final_video_1x1.mp4": (720, 720)},
    "duration": 30.0,
    "frames": 720,
  },
}
DURATION_TOL = 0.05
LUFS_TARGET = -14.0
LUFS_TOL = 1.0
TRUE_PEAK_MAX = -1.0


def _ffmpeg_version() -> str:
  try:
    out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=False).stdout
    return out.splitlines()[0] if out else "unknown"
  except OSError:
    return "unknown"


def _render(storyboard: Path, out_dir: Path) -> tuple[subprocess.CompletedProcess[str], float]:
  env = dict(os.environ)
  env["PYTHONDONTWRITEBYTECODE"] = "1"
  t0 = time.monotonic()
  proc = subprocess.run(
    [
      sys.executable,
      str(ASSEMBLER),
      "render",
      "--storyboard",
      str(storyboard),
      "--output-dir",
      str(out_dir),
    ],
    capture_output=True,
    text=True,
    check=False,
    env=env,
    timeout=300,
  )
  return proc, round(time.monotonic() - t0, 2)


def _measure(path: Path) -> dict[str, Any]:
  info = media_probe.probe(path)
  loud = media_probe.loudness(path) if info.get("audio") else {}
  video = info.get("video") or {}
  return {
    "duration": info.get("duration"),
    "video_stream_duration": video.get("stream_duration"),
    "audio_stream_duration": (info.get("audio") or {}).get("stream_duration"),
    "frames": video.get("nb_frames"),
    "resolution": f"{video.get('width')}x{video.get('height')}",
    "r_frame_rate": video.get("r_frame_rate"),
    "integrated_lufs": loud.get("integrated_lufs"),
    "true_peak_dbtp": loud.get("true_peak_dbtp"),
    "loudnorm_input_i": loud.get("loudnorm_input_i"),
  }


def _fmt(value: Any) -> str:
  if value is None:
    return "-"
  if isinstance(value, float):
    return f"{value:.2f}"
  return str(value)


def test_render_benchmark(storyboard_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> None:
  baseline = json.loads(BASELINE.read_text(encoding="utf-8")) if BASELINE.is_file() else {}
  base_cases = baseline.get("render_cases", {})
  wall_factor = float(os.environ.get("SM_BENCH_WALL_FACTOR", "2.0"))
  out_root = tmp_path_factory.mktemp("bench")
  results: dict[str, Any] = {}
  failures: list[str] = []
  rows: list[tuple[str, str, str, str, str]] = []

  for name, spec in CASES.items():
    proc, wall = _render(storyboard_dir / f"{name}.json", out_root / name)
    entry: dict[str, Any] = {
      "exit": proc.returncode,
      "wall_seconds": wall,
      "outputs": {},
      "stderr_last_line": (proc.stderr.strip().splitlines() or [""])[-1][:300],
    }
    if proc.returncode != 0:
      failures.append(f"{name}: exit {proc.returncode}: {entry['stderr_last_line']}")
    base = base_cases.get(name, {})
    base_wall = base.get("wall_seconds")
    rows.append((name, "-", "wall_seconds", _fmt(base_wall), _fmt(wall)))
    if base_wall and wall > wall_factor * float(base_wall):
      failures.append(f"{name}: wall {wall:.2f} s > {wall_factor:g} x baseline {base_wall:.2f} s")
    for filename, size in spec["files"].items():
      path = out_root / name / filename
      if not path.is_file():
        failures.append(f"{name}: {filename} missing")
        continue
      m = _measure(path)
      entry["outputs"][filename] = m
      base_out = (base.get("outputs") or {}).get(filename, {})
      rows.append(
        (
          name,
          filename,
          "duration",
          _fmt(base_out.get("duration")),
          _fmt(m["video_stream_duration"]),
        )
      )
      rows.append(
        (
          name,
          filename,
          "integrated_lufs",
          _fmt(base_out.get("integrated_lufs")),
          _fmt(m["integrated_lufs"]),
        )
      )
      rows.append(
        (
          name,
          filename,
          "true_peak_dbtp",
          _fmt(base_out.get("true_peak_dbtp")),
          _fmt(m["true_peak_dbtp"]),
        )
      )
      rows.append((name, filename, "frames", "-", _fmt(m["frames"])))
      vdur = m["video_stream_duration"] or m["duration"] or 0.0
      if abs(vdur - spec["duration"]) > DURATION_TOL:
        failures.append(f"{name}/{filename}: video stream {vdur} s != {spec['duration']} s")
      if m["frames"] != spec["frames"]:
        failures.append(f"{name}/{filename}: {m['frames']} frames != {spec['frames']}")
      if m["resolution"] != f"{size[0]}x{size[1]}":
        failures.append(f"{name}/{filename}: resolution {m['resolution']} != {size[0]}x{size[1]}")
      if m["integrated_lufs"] is None or abs(m["integrated_lufs"] - LUFS_TARGET) > LUFS_TOL:
        failures.append(
          f"{name}/{filename}: loudness {m['integrated_lufs']} outside {LUFS_TARGET} +/- {LUFS_TOL}"
        )
      if m["true_peak_dbtp"] is None or m["true_peak_dbtp"] > TRUE_PEAK_MAX:
        failures.append(
          f"{name}/{filename}: true peak {m['true_peak_dbtp']} > {TRUE_PEAK_MAX} dBTP"
        )
    results[name] = entry

  latest = {
    "version": VERSION,
    "captured_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "baseline": {"version": baseline.get("version"), "captured_at": baseline.get("captured_at")},
    "environment": {
      "ffmpeg": _ffmpeg_version(),
      "python": platform.python_version(),
      "platform": f"{platform.system()}-{platform.machine()}",
      "wall_factor": wall_factor,
    },
    "gates": {
      "duration_tolerance_s": DURATION_TOL,
      "lufs_target": LUFS_TARGET,
      "lufs_tolerance": LUFS_TOL,
      "true_peak_max_dbtp": TRUE_PEAK_MAX,
    },
    "render_cases": results,
    "failures": failures,
  }
  RESULTS_DIR.mkdir(parents=True, exist_ok=True)
  LATEST.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")

  header = ("case", "file", "metric", f"v{baseline.get('version', '2.0.0')}", f"v{VERSION}")
  widths = [max(len(str(r[i])) for r in rows + [header]) for i in range(5)]
  lines = [
    " | ".join(str(h).ljust(widths[i]) for i, h in enumerate(header)),
    "-+-".join("-" * w for w in widths),
  ]
  lines += [" | ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)) for r in rows]
  print("\n".join(lines))
  print(f"wrote {LATEST}")
  assert not failures, "\n".join(failures)
