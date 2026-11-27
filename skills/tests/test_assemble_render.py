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
"""Render contract tests for scene-machine/scripts/assemble_ad_video.py (v2.1).

Every case renders synthetic lavfi media through the real script in a
subprocess and checks the contract of TASKS.md section 7.3 / 7.4: exit codes,
one-line JSON errors and warnings on stderr, the summary JSON on stdout,
stream-level durations and frame counts, loudness, overlays and output names.
Successful renders are cached per session so each storyboard is encoded once.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

import pytest

import media_probe
from conftest import (
  ASSEMBLER,
  SYSTEM_PYTHON,
  find_error,
  find_warnings,
  json_lines,
  load_script,
  parse_summary,
  run_py,
)

SUMMARY_KEYS = {
  "status",
  "primary_video",
  "expected_duration_seconds",
  "video_stream_duration_seconds",
  "audio_stream_duration_seconds",
  "video_frames",
  "resolution",
  "integrated_lufs",
  "true_peak_dbtp",
  "overlays_rendered",
  "output_files",
  "mirrored_to",
}
SQUARE_HINT = (
  "1:1 is produced as a crop of the 9:16 render: set aspectRatio 9:16 and exportSquareCrop true"
)
DURATION_TOL = 0.05
LUFS_TOL = 1.0


class RenderResult:
  def __init__(self, name: str, proc: subprocess.CompletedProcess[str], out_dir: Path, wall: float):
    self.name = name
    self.rc = proc.returncode
    self.stdout = proc.stdout
    self.stderr = proc.stderr
    self.out_dir = out_dir
    self.wall = wall
    self.summary: dict[str, Any] = parse_summary(proc.stdout) if proc.returncode == 0 else {}

  def video(self, filename: str = "final_video_16x9.mp4") -> Path:
    return self.out_dir / filename

  def describe(self) -> str:
    return (
      f"{self.name}: exit {self.rc}\nSTDOUT: {self.stdout[-600:]}\nSTDERR: {self.stderr[-900:]}"
    )


_CACHE: dict[tuple[str, tuple[str, ...]], RenderResult] = {}


@pytest.fixture(scope="session")
def render_root(tmp_path_factory: pytest.TempPathFactory) -> Path:
  return tmp_path_factory.mktemp("renders")


@pytest.fixture
def render(storyboard_dir: Path, render_root: Path) -> Callable[..., RenderResult]:
  def _render(
    name: str,
    *extra: str,
    env: dict[str, str] | None = None,
    cache: bool = True,
    python: str | None = None,
  ) -> RenderResult:
    key = (name, tuple(extra) + tuple(sorted((env or {}).items())) + (python or "",))
    if cache and key in _CACHE:
      return _CACHE[key]
    tag = hashlib.md5(repr(key).encode()).hexdigest()[:8]
    out_dir = render_root / f"{name}_{tag}"
    args = [
      "render",
      "--storyboard",
      str(storyboard_dir / f"{name}.json"),
      "--output-dir",
      str(out_dir),
      *extra,
    ]
    t0 = time.monotonic()
    proc = run_py(ASSEMBLER, args, env=env, python=python)
    result = RenderResult(name, proc, out_dir, time.monotonic() - t0)
    if cache:
      _CACHE[key] = result
    return result

  return _render


def assert_ok(r: RenderResult) -> dict[str, Any]:
  assert r.rc == 0, r.describe()
  assert r.summary.get("status") == "ok", r.describe()
  missing = SUMMARY_KEYS - set(r.summary)
  assert not missing, f"summary lacks {sorted(missing)}: {r.summary}"
  return r.summary


def assert_duration(
  path: Path, expected: float, frames: int | None = None, fps: str = "24/1"
) -> dict[str, Any]:
  info = media_probe.probe(path)
  assert info["video"], info
  vdur = info["video"]["stream_duration"] or info["duration"]
  assert abs(vdur - expected) <= DURATION_TOL, f"{path.name}: video stream {vdur} s != {expected} s"
  assert info["video"]["r_frame_rate"] == fps, info["video"]
  if frames is not None:
    assert info["video"]["nb_frames"] == frames, info["video"]
  return info


def assert_broadcast_audio(
  path: Path, target: float = -14.0, tol: float = LUFS_TOL
) -> dict[str, Any]:
  info = media_probe.probe(path)
  assert info["audio"], f"{path.name} has no audio stream"
  assert info["audio"]["codec_name"] == "aac" and info["audio"]["sample_rate"] == 48000
  assert info["audio"]["channels"] == 2, info["audio"]
  loud = media_probe.loudness(path)
  assert loud["integrated_lufs"] is not None, loud
  assert abs(loud["integrated_lufs"] - target) <= tol, loud
  return loud


def assert_single_json_stderr(r: RenderResult) -> dict[str, Any]:
  lines = [ln for ln in r.stderr.splitlines() if ln.strip()]
  assert lines, r.describe()
  assert "Traceback" not in r.stderr, r.describe()
  objs = json_lines(r.stderr)
  assert len(objs) == len(lines), f"non-JSON stderr lines: {lines}"
  err = find_error(r.stderr)
  assert isinstance(err.get("message"), str) and err["message"]
  return err


# ---------------------------------------------------------------------------
# Successful renders
# ---------------------------------------------------------------------------
def test_5x6_16x9_full_contract(render: Callable[..., RenderResult]) -> None:
  r = render("sb_5x6_16x9")
  s = assert_ok(r)
  video = r.video()
  assert Path(s["primary_video"]) == video and video.is_file()
  info = assert_duration(video, 30.0, frames=720)
  assert (info["video"]["width"], info["video"]["height"]) == (1280, 720)
  assert info["video"]["pix_fmt"] == "yuv420p" and info["video"]["codec_name"] == "h264"
  assert (info["video"]["profile"] or "").lower() == "high"
  loud = assert_broadcast_audio(video)
  assert loud["true_peak_dbtp"] is not None and loud["true_peak_dbtp"] <= -1.0
  assert s["expected_duration_seconds"] == pytest.approx(30.0)
  assert s["video_stream_duration_seconds"] == pytest.approx(30.0, abs=DURATION_TOL)
  assert s["audio_stream_duration_seconds"] == pytest.approx(30.0, abs=0.1)
  assert s["video_frames"] == 720
  assert s["resolution"] == "1280x720"
  assert abs(float(s["integrated_lufs"]) - loud["integrated_lufs"]) <= 0.6
  assert float(s["true_peak_dbtp"]) <= -1.0
  assert s["overlays_rendered"] is True
  assert s["mirrored_to"] == []
  names = {Path(p).name for p in s["output_files"]}
  assert {"final_video_16x9.mp4", "storyboard.json", "storyboard.md"} <= names
  assert (r.out_dir / "storyboard.json").is_file() and (r.out_dir / "storyboard.md").is_file()
  md = (r.out_dir / "storyboard.md").read_text(encoding="utf-8")
  assert md.isascii(), "storyboard.md must be ASCII only"
  assert "workspace_deliverables" not in s
  assert not find_warnings(r.stderr, "short_clip")


def test_3x6_16x9(render: Callable[..., RenderResult]) -> None:
  r = render("sb_3x6_16x9")
  s = assert_ok(r)
  assert_duration(r.video(), 18.0, frames=432)
  assert_broadcast_audio(r.video())
  assert s["video_frames"] == 432 and s["expected_duration_seconds"] == pytest.approx(18.0)


def test_9x16_with_square_crop(render: Callable[..., RenderResult]) -> None:
  r = render("sb_5x6_9x16_square")
  s = assert_ok(r)
  tall = r.video("final_video_9x16.mp4")
  square = r.video("final_video_1x1.mp4")
  assert tall.is_file() and square.is_file()
  assert Path(s["primary_video"]) == tall and s["resolution"] == "720x1280"
  info_tall = assert_duration(tall, 30.0, frames=720)
  assert (info_tall["video"]["width"], info_tall["video"]["height"]) == (720, 1280)
  info_sq = assert_duration(square, 30.0)
  assert (info_sq["video"]["width"], info_sq["video"]["height"]) == (720, 720)
  assert_broadcast_audio(tall)
  assert_broadcast_audio(square)
  names = {Path(p).name for p in s["output_files"]}
  assert "final_video_1x1.mp4" in names and "final_video_9x16.mp4" in names


@pytest.mark.parametrize(
  "name, expect_audio",
  [
    ("sb_vo_only", "loud"),
    ("sb_music_only", "loud"),
    ("sb_embedded_audio", "loud"),
    ("sb_no_audio", "silent"),
  ],
)
def test_audio_variants(render: Callable[..., RenderResult], name: str, expect_audio: str) -> None:
  r = render(name)
  assert_ok(r)
  video = r.video()
  assert_duration(video, 18.0, frames=432)
  info = media_probe.probe(video)
  assert info["audio"], "every render keeps an audio stream"
  loud = media_probe.loudness(video)
  if expect_audio == "loud":
    assert (
      loud["integrated_lufs"] is not None and abs(loud["integrated_lufs"] + 14.0) <= LUFS_TOL
    ), loud
  else:
    assert loud["integrated_lufs"] is None or loud["integrated_lufs"] <= -60.0, loud


def test_pink_noise_voiceover_true_peak(render: Callable[..., RenderResult]) -> None:
  r = render("sb_noise_vo")
  s = assert_ok(r)
  loud = assert_broadcast_audio(r.video())
  assert loud["true_peak_dbtp"] is not None and loud["true_peak_dbtp"] <= -1.0, loud
  assert float(s["true_peak_dbtp"]) <= -1.0


def test_file_uri_clips_with_query(render: Callable[..., RenderResult]) -> None:
  r = render("sb_uri_clips")
  s = assert_ok(r)
  assert_duration(r.video(), 30.0, frames=720)
  assert_broadcast_audio(r.video())
  assert s["resolution"] == "1280x720"


def test_8s_clip_in_6s_slot_is_trimmed_not_frozen(render: Callable[..., RenderResult]) -> None:
  r = render("sb_long_8s")
  assert_ok(r)
  video = r.video()
  assert_duration(video, 18.0, frames=432)
  # shot 2 occupies 6.0-12.0 s; its last frames must still move (no cloned tail).
  # Both samples sit before the lower-third fade-out (slot end - 0.70 s).
  psnr = media_probe.frame_psnr(video, 10.50, 11.20)
  assert psnr is not None and psnr < 40.0, (
    f"tail of the trimmed 8 s clip looks frozen (PSNR {psnr})"
  )


def test_4s_shots_pass_through(render: Callable[..., RenderResult]) -> None:
  r = render("sb_4s_shots")
  s = assert_ok(r)
  assert_duration(r.video(), 20.0, frames=480)
  assert s["expected_duration_seconds"] == pytest.approx(20.0)
  written = json.loads((r.out_dir / "storyboard.json").read_text(encoding="utf-8"))
  assert all(float(sh["durationSeconds"]) == 4.0 for sh in written["shots"])
  assert float(written["totalDurationSeconds"]) == pytest.approx(20.0)


@pytest.mark.parametrize(
  "name", ["sb_short_2s", "sb_short_2s_no_overlay", "sb_short_1s", "sb_short_1s_no_overlay"]
)
def test_short_clip_fills_full_slot(render: Callable[..., RenderResult], name: str) -> None:
  r = render(name)
  s = assert_ok(r)
  assert_duration(r.video(), 18.0, frames=432)
  assert s["video_stream_duration_seconds"] == pytest.approx(18.0, abs=DURATION_TOL)
  warnings = find_warnings(r.stderr, "short_clip")
  assert warnings, f"expected a short_clip warning on stderr: {r.stderr!r}"
  assert any(w.get("shotIndex") == 2 for w in warnings), warnings
  # the padded tail of shot 2 (6.0-12.0 s) is a clone of the last clip frame: two lossy x264
  # stages leave a little quantisation noise, so compare with PSNR instead of byte identity
  # (samples inside 0.70 s .. slot - 0.70 s so the lower-third fades do not interfere)
  video = r.video()
  psnr = media_probe.frame_psnr(video, 10.0, 11.2)
  assert psnr is not None and psnr >= 45.0, f"padded tail is not a frozen clone (PSNR {psnr})"


def test_vfr_30fps_clip_is_normalised(render: Callable[..., RenderResult]) -> None:
  r = render("sb_vfr_30fps")
  assert_ok(r)
  info = assert_duration(r.video(), 18.0, frames=432)
  assert (info["video"]["width"], info["video"]["height"]) == (1280, 720)


def test_1080p_clip_with_silent_audio_track(render: Callable[..., RenderResult]) -> None:
  r = render("sb_1080p_silent_audio")
  assert_ok(r)
  info = assert_duration(r.video(), 18.0, frames=432)
  assert (info["video"]["width"], info["video"]["height"]) == (1280, 720)
  # VO + music are present: the silent embedded track must not win
  assert_broadcast_audio(r.video())


def test_null_headline_is_coerced(render: Callable[..., RenderResult]) -> None:
  r = render("sb_null_headline")
  s = assert_ok(r)
  assert s["overlays_rendered"] is True
  assert_duration(r.video(), 18.0, frames=432)


def _no_overlay_flag() -> str | None:
  proc = run_py(ASSEMBLER, ["render", "--help"])
  return "--no-overlays" if "--no-overlays" in proc.stdout else None


def test_overlays_change_flat_gray_regions(render: Callable[..., RenderResult]) -> None:
  with_overlays = render("sb_flat_gray")
  s = assert_ok(with_overlays)
  assert s["overlays_rendered"] is True
  flag = _no_overlay_flag()
  if flag:
    without = render("sb_flat_gray", flag)
  else:
    if (
      not Path(SYSTEM_PYTHON).is_file()
      or subprocess.run(
        [SYSTEM_PYTHON, "-c", "import PIL"], capture_output=True, check=False
      ).returncode
      == 0
    ):
      pytest.skip("no Pillow-free interpreter available to produce the un-overlaid reference")
    without = render("sb_flat_gray", "--allow-no-overlays", python=SYSTEM_PYTHON)
  s2 = assert_ok(without)
  assert s2["overlays_rendered"] is False
  lt = media_probe.lower_third_crop(1280, 720)
  ec = media_probe.endcard_crop(1280, 720)
  lt_on = media_probe.region_luma(with_overlays.video(), 3.0, lt)
  lt_off = media_probe.region_luma(without.video(), 3.0, lt)
  ec_on = media_probe.region_luma(with_overlays.video(), 17.0, ec)
  ec_off = media_probe.region_luma(without.video(), 17.0, ec)
  assert None not in (lt_on, lt_off, ec_on, ec_off)
  assert abs(lt_on - lt_off) >= 25, f"lower-third not visible: {lt_on} vs {lt_off}"
  assert abs(ec_on - ec_off) >= 25, f"endcard not visible: {ec_on} vs {ec_off}"


def test_mirror_dir_flag_and_env(render: Callable[..., RenderResult], tmp_path: Path) -> None:
  mirror = tmp_path / "mirror_flag"
  r = render("sb_3x6_16x9", "--mirror-dir", str(mirror), cache=False)
  s = assert_ok(r)
  copied = {Path(p).name for p in s["mirrored_to"]}
  assert {"final_video_16x9.mp4", "storyboard.json", "storyboard.md"} <= copied
  assert all(Path(p).is_file() and Path(p).parent == mirror for p in s["mirrored_to"])
  mirror_env = tmp_path / "mirror_env"
  r2 = render("sb_3x6_16x9", env={"SCENE_MACHINE_MIRROR_DIR": str(mirror_env)}, cache=False)
  s2 = assert_ok(r2)
  assert s2["mirrored_to"] and all(Path(p).parent == mirror_env for p in s2["mirrored_to"])


def test_default_output_dir_follows_workdir_env(storyboard_dir: Path, tmp_path: Path) -> None:
  workdir = tmp_path / "wd"
  proc = run_py(
    ASSEMBLER,
    ["render", "--storyboard", str(storyboard_dir / "sb_3x6_16x9.json")],
    env={"SCENE_MACHINE_WORKDIR": str(workdir)},
    cwd=tmp_path,
  )
  assert proc.returncode == 0, proc.stderr[-800:]
  summary = parse_summary(proc.stdout)
  assert (
    Path(summary["primary_video"]).resolve()
    == (workdir / "output" / "final_video_16x9.mp4").resolve()
  )
  assert not (tmp_path / "output").exists() and not Path("/workspace/deliverables").exists()


def test_render_help_lists_contract_flags() -> None:
  proc = run_py(ASSEMBLER, ["render", "--help"])
  assert proc.returncode == 0
  for flag in ("--storyboard", "--output-dir", "--allow-no-overlays", "--mirror-dir"):
    assert flag in proc.stdout, flag


def test_performance_budget_5x6(render: Callable[..., RenderResult]) -> None:
  r = render("sb_5x6_16x9")
  assert_ok(r)
  assert r.wall < 60.0, f"5 x 6 s render took {r.wall:.1f} s"


@pytest.mark.determinism
def test_two_renders_are_byte_identical(render: Callable[..., RenderResult]) -> None:
  a = render("sb_3x6_16x9", cache=False)
  b = render("sb_3x6_16x9", cache=False)
  assert_ok(a)
  assert_ok(b)
  assert (
    hashlib.md5(a.video().read_bytes()).hexdigest()
    == hashlib.md5(b.video().read_bytes()).hexdigest()
  )


# ---------------------------------------------------------------------------
# Failure modes: exit codes and one-line JSON errors
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
  "name, exit_code, error, shot_index, hint",
  [
    ("sb_missing_clip", 3, "missing_input", 4, None),
    ("malformed", 5, "invalid_storyboard", None, None),
    ("sb_one_shot", 5, "invalid_storyboard", None, None),
    ("sb_seven_shots", 5, "invalid_storyboard", None, None),
    ("sb_bad_aspect", 5, "invalid_storyboard", None, None),
    ("sb_1x1", 5, "invalid_storyboard", None, SQUARE_HINT),
    ("sb_bad_hex", 5, "invalid_storyboard", None, None),
    ("sb_zero_duration", 5, "invalid_storyboard", None, None),
  ],
)
def test_failure_exit_codes(
  render: Callable[..., RenderResult],
  name: str,
  exit_code: int,
  error: str,
  shot_index: int | None,
  hint: str | None,
) -> None:
  r = render(name)
  assert r.rc == exit_code, r.describe()
  assert r.stdout.strip() == "", "failures print nothing on stdout"
  err = assert_single_json_stderr(r)
  assert err["error"] == error, err
  if shot_index is not None:
    assert err.get("shotIndex") == shot_index, err
  if hint is not None:
    assert err.get("hint") == hint, err
  assert r.wall < 5.0, f"validation must precede encoding ({r.wall:.1f} s)"
  assert not r.out_dir.exists() or not list(r.out_dir.glob("*.mp4"))


def test_missing_storyboard_file_exit_3(tmp_path: Path) -> None:
  proc = run_py(
    ASSEMBLER,
    ["render", "--storyboard", str(tmp_path / "nope.json"), "--output-dir", str(tmp_path / "o")],
  )
  assert proc.returncode == 3, proc.stderr
  assert find_error(proc.stderr)["error"] == "missing_input"


def test_ffmpeg_absent_exit_4(storyboard_dir: Path, empty_path: Path, tmp_path: Path) -> None:
  proc = run_py(
    ASSEMBLER,
    [
      "render",
      "--storyboard",
      str(storyboard_dir / "sb_3x6_16x9.json"),
      "--output-dir",
      str(tmp_path / "o"),
    ],
    env={"PATH": str(empty_path)},
  )
  assert proc.returncode == 4, proc.stderr
  err = find_error(proc.stderr)
  assert err["error"] == "dependency_missing", err
  assert "ffmpeg" in err["message"].lower() or "ffprobe" in err["message"].lower(), err
  assert "Traceback" not in proc.stderr


def _pillow_free_python() -> str:
  if not Path(SYSTEM_PYTHON).is_file():
    pytest.skip(f"{SYSTEM_PYTHON} not available")
  # NB: a venv python is often a symlink to the system binary; what matters is that the system
  # interpreter does not see the venv's site-packages, so probe behaviour instead of paths.
  if (
    subprocess.run([SYSTEM_PYTHON, "-c", "import PIL"], capture_output=True, check=False).returncode
    == 0
  ):
    pytest.skip("system python has Pillow installed")
  return SYSTEM_PYTHON


def test_pillow_absent_exit_4_unless_allowed(storyboard_dir: Path, tmp_path: Path) -> None:
  python = _pillow_free_python()
  sb = str(storyboard_dir / "sb_3x6_16x9.json")
  proc = run_py(
    ASSEMBLER, ["render", "--storyboard", sb, "--output-dir", str(tmp_path / "o1")], python=python
  )
  assert proc.returncode == 4, proc.stderr
  err = find_error(proc.stderr)
  assert err["error"] == "dependency_missing" and "pillow" in err["message"].lower()
  assert "allow-no-overlays" in (err.get("hint") or "")
  assert not list((tmp_path / "o1").glob("*.mp4")) if (tmp_path / "o1").exists() else True
  proc2 = run_py(
    ASSEMBLER,
    ["render", "--storyboard", sb, "--output-dir", str(tmp_path / "o2"), "--allow-no-overlays"],
    python=python,
  )
  assert proc2.returncode == 0, proc2.stderr[-800:]
  s = parse_summary(proc2.stdout)
  assert s["overlays_rendered"] is False
  assert_duration(tmp_path / "o2" / "final_video_16x9.mp4", 18.0, frames=432)


def test_debug_env_adds_traceback_but_keeps_json(storyboard_dir: Path, tmp_path: Path) -> None:
  proc = run_py(
    ASSEMBLER,
    [
      "render",
      "--storyboard",
      str(storyboard_dir / "malformed.json"),
      "--output-dir",
      str(tmp_path / "o"),
    ],
    env={"SCENE_MACHINE_DEBUG": "1"},
  )
  assert proc.returncode == 5
  assert find_error(proc.stderr)["error"] == "invalid_storyboard"


# ---------------------------------------------------------------------------
# normalize-image
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("aspect, size", [("16:9", (1280, 720)), ("9:16", (720, 1280))])
def test_normalize_image(
  media_dir: Path, tmp_path: Path, aspect: str, size: tuple[int, int]
) -> None:
  out = tmp_path / f"norm_{aspect.replace(':', 'x')}.png"
  proc = run_py(
    ASSEMBLER,
    [
      "normalize-image",
      "--input",
      str(media_dir / "keyframe_800x600.png"),
      "--output",
      str(out),
      "--aspect-ratio",
      aspect,
    ],
  )
  assert proc.returncode == 0, proc.stderr
  info = media_probe.probe(out)
  assert (info["video"]["width"], info["video"]["height"]) == size
  result = parse_summary(proc.stdout)
  assert result["status"] == "ok" and result["resolution"] == f"{size[0]}x{size[1]}"


def test_normalize_image_uri_input(media_dir: Path, tmp_path: Path) -> None:
  out = tmp_path / "norm_uri.png"
  uri = "file://" + str(media_dir / "keyframe_800x600.png") + "?encoding=base64"
  proc = run_py(ASSEMBLER, ["normalize-image", "--input", uri, "--output", str(out)])
  assert proc.returncode == 0, proc.stderr
  assert media_probe.probe(out)["video"]["width"] == 1280


def test_normalize_image_bad_hex_exit_2(media_dir: Path, tmp_path: Path) -> None:
  proc = run_py(
    ASSEMBLER,
    [
      "normalize-image",
      "--input",
      str(media_dir / "keyframe_800x600.png"),
      "--output",
      str(tmp_path / "x.png"),
      "--bg-hex",
      "notahex",
    ],
  )
  assert proc.returncode == 2, proc.stderr
  assert "bg-hex" in proc.stderr or "hex" in proc.stderr.lower()


def test_one_line_collapses_whitespace_and_truncates() -> None:
  mod = load_script(ASSEMBLER)
  assert mod.one_line("  hello\n\tworld\r\nagain  ") == "hello world again"
  long_msg = "x" * 700
  capped = mod.one_line(long_msg)
  assert len(capped) == 600 and capped.endswith("...")
  assert mod.one_line("abcdef", limit=5) == "ab..."
  assert mod.one_line("abcdef", limit=2) == "ab"
  assert mod.one_line("abcdef", limit=0) == ""


def test_no_pycache_left_by_renders() -> None:
  scripts = ASSEMBLER.parent
  assert not (scripts / "__pycache__").exists() or not any((scripts / "__pycache__").iterdir())
  assert os.environ.get("PYTHONDONTWRITEBYTECODE") == "1"
  shutil.rmtree(scripts / "__pycache__", ignore_errors=True)
