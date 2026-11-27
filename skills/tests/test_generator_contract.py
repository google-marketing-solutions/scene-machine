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
"""Contract tests for scene-machine/scripts/generate_ad_spot_vertex.py (v2.1).

Hermetic: google.genai / google.auth / urlopen are the fakes from
fake_genai.py (installed for every test by conftest), the network is blocked,
PATH has no gcloud and HOME is empty. Fake Veo returns real lavfi MP4 bytes so
the assembler runs for real at the end of the --execute flow.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

import fake_genai
import media_probe
import storyboards
from conftest import (
  GENERATOR,
  SYSTEM_PYTHON,
  call_main,
  find_error,
  find_warnings,
  json_lines,
  last_json_line,
  load_script,
  run_py,
)

DEFAULTS = {
  "image": "gemini-3.1-flash-image",
  "video": "veo-3.1-fast-generate-001",
  "tts": "gemini-2.5-flash-tts",
  "music": "lyria-002",
}
SQUARE_HINT = (
  "1:1 is produced as a crop of the 9:16 render: set aspectRatio 9:16 and exportSquareCrop true"
)
PREREQ_KEYS = {
  "ffmpeg",
  "ffprobe",
  "pillow",
  "google_genai_importable",
  "adc_file_present",
  "gcloud_default_project_hint",
}
LYRIA_GLOBAL = "https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/publishers/google/models/lyria-002:predict"
LYRIA_REGIONAL = (
  "https://us-central1-aiplatform.googleapis.com/v1/projects/{p}/locations/us-central1"
  "/publishers/google/models/lyria-002:predict"
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def write_sb(tmp_path: Path, name: str = "storyboard.json", **kw: Any) -> Path:
  return storyboards.write_json(tmp_path / name, storyboards.generator_storyboard(**kw))


def run_gen(capfd: pytest.CaptureFixture[str], argv: list[str]) -> tuple[int, str, str]:
  """Runs a fresh in-process import of the generator and returns (rc, stdout, stderr)."""
  capfd.readouterr()
  mod = load_script(GENERATOR)
  rc = call_main(mod, argv)
  out, err = capfd.readouterr()
  return rc, out, err


def dry_json(out: str) -> dict[str, Any]:
  data = last_json_line(out)
  assert data.get("status") == "dry_run", data
  return data


def plan_counts(data: dict[str, Any]) -> dict[str, int]:
  counts: dict[str, int] = {}
  for row in data.get("plan") or []:
    counts[row["kind"]] = counts.get(row["kind"], 0) + int(row["count"])
  return counts


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
  calls: list[float] = []
  monkeypatch.setattr(time, "sleep", lambda s: calls.append(float(s)))
  return calls


class FakeClock:
  def __init__(self) -> None:
    self.now = 1000.0
    self.sleeps: list[float] = []

  def monotonic(self) -> float:
    return self.now

  def sleep(self, seconds: float) -> None:
    self.sleeps.append(float(seconds))
    self.now += max(float(seconds), 0.0)


def exec_args(sb: Path, out: Path, *extra: str, project: str | None = "fake-project") -> list[str]:
  args = ["--storyboard", str(sb), "--execute", "--output-dir", str(out), *extra]
  if project:
    args += ["--project", project]
  return args


# ---------------------------------------------------------------------------
# help / dry-run
# ---------------------------------------------------------------------------
def test_help_lists_every_contract_flag() -> None:
  proc = run_py(GENERATOR, ["--help"], block_sdk=True)
  assert proc.returncode == 0, proc.stderr
  for flag in (
    "--storyboard",
    "--dry-run",
    "--execute",
    "--project",
    "--location",
    "--music-location",
    "--image-model",
    "--video-model",
    "--tts-model",
    "--music-model",
    "--voice",
    "--veo-audio",
    "--veo-resolution",
    "--max-workers",
    "--poll-interval",
    "--poll-timeout",
    "--list-models",
    "--no-strict-copy",
    "--output-dir",
    "--skip-assemble",
  ):
    assert flag in proc.stdout, f"--help lacks {flag}"


def test_dry_run_is_default_and_needs_no_sdk(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  monkeypatch: pytest.MonkeyPatch,
  fake_sdk: fake_genai.Recorder,
) -> None:
  monkeypatch.setitem(sys.modules, "google.genai", None)
  sb = write_sb(tmp_path)
  rc, out, err = run_gen(capfd, ["--storyboard", str(sb), "--output-dir", str(tmp_path / "out")])
  assert rc == 0, err
  data = dry_json(out)
  assert data["rendered"] is False and "primary_video" not in data
  assert data["planned_calls"] == 12
  assert data["project"] == "" and data["project_source"] == "none"
  assert PREREQ_KEYS <= set(data["prerequisites"]), data["prerequisites"]
  assert data["prerequisites"]["google_genai_importable"] is False
  validation = data["validation"]
  assert validation["schema"] == "ok" and validation["voiceover_words"] == 58
  assert validation["language"] == "en-US" and validation["music_prompt_ascii"] is True
  assert validation["durations"] == [6, 6, 6, 6, 6]
  assert plan_counts(data) == {"image": 5, "video": 5, "tts": 1, "music": 1}
  by_kind = {row["kind"]: row for row in data["plan"]}
  for kind, model in DEFAULTS.items():
    assert by_kind[kind]["model"] == model, by_kind[kind]
    assert by_kind[kind]["unit_cost_note"], kind
  assert (
    by_kind["image"]["location"] == "us-central1" and by_kind["video"]["location"] == "us-central1"
  )
  assert by_kind["tts"]["location"] == "global" and by_kind["music"]["location"] == "global"
  table = out[: out.rfind("\n{")] if "\n{" in out else out
  for token in ("image", "video", "tts", "music", DEFAULTS["video"], "us-central1"):
    assert token in table, f"plan table lacks {token!r}"
  assert fake_sdk.clients == [] and fake_sdk.lyria_requests == []
  assert fake_sdk.auth_default_calls == 0


def test_dry_run_subprocess_with_sdk_blocked(tmp_path: Path) -> None:
  sb = write_sb(tmp_path)
  proc = run_py(
    GENERATOR, ["--storyboard", str(sb), "--output-dir", str(tmp_path / "out")], block_sdk=True
  )
  assert proc.returncode == 0, proc.stderr
  data = dry_json(proc.stdout)
  assert data["prerequisites"]["google_genai_importable"] is False
  assert "Traceback" not in proc.stderr


def test_dry_run_with_system_python_without_sdk(tmp_path: Path) -> None:
  if not Path(SYSTEM_PYTHON).is_file():
    pytest.skip("no system python")
  if (
    subprocess.run(
      [SYSTEM_PYTHON, "-c", "import google.genai"], capture_output=True, check=False
    ).returncode
    == 0
  ):
    pytest.skip("system python can import google.genai")
  sb = write_sb(tmp_path)
  proc = run_py(
    GENERATOR,
    ["--storyboard", str(sb), "--output-dir", str(tmp_path / "out")],
    python=SYSTEM_PYTHON,
  )
  assert proc.returncode == 0, proc.stderr
  data = dry_json(proc.stdout)
  assert data["prerequisites"]["google_genai_importable"] is False
  assert data["planned_calls"] == 12


def test_dry_run_reports_env_project_as_hint_only(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  monkeypatch: pytest.MonkeyPatch,
  fake_sdk: fake_genai.Recorder,
) -> None:
  monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
  sb = write_sb(tmp_path)
  rc, out, _ = run_gen(capfd, ["--storyboard", str(sb), "--output-dir", str(tmp_path / "out")])
  assert rc == 0
  data = dry_json(out)
  assert data["project"] == "env-project" and data["project_source"] == "env"
  assert fake_sdk.clients == []
  rc, out, _ = run_gen(
    capfd,
    ["--storyboard", str(sb), "--project", "flag-project", "--output-dir", str(tmp_path / "out")],
  )
  data = dry_json(out)
  assert data["project"] == "flag-project" and data["project_source"] == "flag"
  assert fake_sdk.clients == []


def test_dry_run_durations_pass_through(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
  sb = write_sb(tmp_path, n=2, durations=[4, 8])
  rc, out, _ = run_gen(capfd, ["--storyboard", str(sb), "--output-dir", str(tmp_path / "out")])
  assert rc == 0
  data = dry_json(out)
  assert data["validation"]["durations"] == [4, 8]
  assert plan_counts(data) == {"image": 2, "video": 2, "tts": 1, "music": 1}


# ---------------------------------------------------------------------------
# explicit project rule, models, registry
# ---------------------------------------------------------------------------
def test_execute_without_project_exits_2_before_any_client(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
) -> None:
  sb = write_sb(tmp_path)
  rc, out, err = run_gen(
    capfd, ["--storyboard", str(sb), "--execute", "--output-dir", str(tmp_path / "out")]
  )
  assert rc == 2, (out, err)
  assert "--project" in err and "GOOGLE_CLOUD_PROJECT" in err
  assert (
    fake_sdk.clients == [] and fake_sdk.auth_default_calls == 0 and fake_sdk.lyria_requests == []
  )
  assert "Traceback" not in err


def test_execute_without_sdk_exits_4(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setitem(sys.modules, "google.genai", None)
  monkeypatch.setitem(sys.modules, "google", None)
  sb = write_sb(tmp_path, n=2)
  rc, _, err = run_gen(capfd, exec_args(sb, tmp_path / "out", "--skip-assemble"))
  assert rc == 4, err
  assert find_error(err)["error"] == "dependency_missing"


@pytest.mark.parametrize(
  "flag, value, replacement",
  [
    ("--image-model", "imagen-3.0-generate-002", "gemini-3.1-flash-image"),
    ("--tts-model", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts"),
    ("--image-model", "no-such-model-123", None),
    ("--video-model", "gemini-omni-1.2-flash", None),
  ],
)
def test_unknown_or_retired_models_exit_2(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  flag: str,
  value: str,
  replacement: str | None,
) -> None:
  sb = write_sb(tmp_path)
  rc, out, err = run_gen(
    capfd, ["--storyboard", str(sb), flag, value, "--output-dir", str(tmp_path / "out")]
  )
  assert rc == 2, (out, err)
  error = find_error(err)
  assert error["error"] == "usage"
  text = json.dumps(error)
  if replacement:
    assert replacement in text, error
  else:
    assert DEFAULTS[flag.split("-")[2]] in text, error
  assert fake_sdk.clients == []


def test_list_models_prints_registry(capfd: pytest.CaptureFixture[str]) -> None:
  rc, out, _ = run_gen(capfd, ["--list-models"])
  assert rc == 0
  for model in (
    *DEFAULTS.values(),
    "imagen-3.0-generate-002",
    "gemini-2.5-flash-preview-tts",
    "veo-3.1-generate-001",
  ):
    assert model in out, model
  for token in (
    "retired",
    "active",
    "default",
    "last_verified",
    "replacement",
    "generate_videos",
    "predict_rest",
  ):
    assert token in out, token


# ---------------------------------------------------------------------------
# storyboard validation (both modes, before any call)
# ---------------------------------------------------------------------------
def _invalid_cases() -> list[tuple[str, dict[str, Any], str | None]]:
  bad_duration = storyboards.generator_storyboard(n=2)
  bad_duration["shots"][1]["durationSeconds"] = 5
  square = storyboards.generator_storyboard(n=2, aspect="1:1")
  short_vo = storyboards.generator_storyboard(n=2, voiceover_words=20)
  long_vo = storyboards.generator_storyboard(n=2, voiceover_words=80)
  german_music = storyboards.generator_storyboard(
    n=2, music_prompt="Fr\u00f6hliche Weihnachtsmusik mit Gl\u00f6ckchen"
  )
  no_visual = storyboards.generator_storyboard(n=2)
  del no_visual["shots"][1]["visualPrompt"]
  no_shots = storyboards.generator_storyboard(n=2)
  no_shots["shots"] = []
  seven = storyboards.generator_storyboard(n=7)
  bad_aspect = storyboards.generator_storyboard(n=2, aspect="4:3")
  return [
    ("duration_5", bad_duration, None),
    ("aspect_1x1", square, SQUARE_HINT),
    ("voiceover_20_words", short_vo, None),
    ("voiceover_80_words", long_vo, None),
    ("non_ascii_music_prompt", german_music, "lyria-002 accepts en-US prompts"),
    ("missing_visual_prompt", no_visual, None),
    ("zero_shots", no_shots, None),
    ("seven_shots", seven, None),
    ("aspect_4x3", bad_aspect, None),
  ]


@pytest.mark.parametrize(
  "case, sb, expect_text", _invalid_cases(), ids=lambda c: c if isinstance(c, str) else ""
)
@pytest.mark.parametrize("mode", ["dry-run", "execute"])
def test_invalid_storyboard_exits_5(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  case: str,
  sb: dict[str, Any],
  expect_text: str | None,
  mode: str,
) -> None:
  path = storyboards.write_json(tmp_path / f"{case}.json", sb)
  argv = ["--storyboard", str(path), "--output-dir", str(tmp_path / "out")]
  if mode == "execute":
    argv += ["--execute", "--project", "fake-project"]
  rc, out, err = run_gen(capfd, argv)
  assert rc == 5, (case, out, err)
  error = find_error(err)
  assert error["error"] == "invalid_storyboard", error
  if expect_text:
    assert expect_text in json.dumps(error), error
  assert not [o for o in json_lines(out) if o.get("status") == "dry_run"]
  assert fake_sdk.clients == [] and fake_sdk.lyria_requests == [] and fake_sdk.calls == []
  assert "Traceback" not in err


def test_no_strict_copy_downgrades_voiceover_length(
  tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
  sb = write_sb(tmp_path, n=2, voiceover_words=20)
  rc, out, err = run_gen(
    capfd, ["--storyboard", str(sb), "--no-strict-copy", "--output-dir", str(tmp_path / "out")]
  )
  assert rc == 0, err
  assert find_warnings(err, "voiceover_length"), err
  assert dry_json(out)["validation"]["voiceover_words"] == 20


def test_missing_storyboard_exits_3(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
  rc, _, err = run_gen(
    capfd, ["--storyboard", str(tmp_path / "nope.json"), "--output-dir", str(tmp_path / "out")]
  )
  assert rc == 3, err
  assert find_error(err)["error"] == "missing_input"


# ---------------------------------------------------------------------------
# --execute flows against the fake SDK
# ---------------------------------------------------------------------------
def test_end_to_end_with_fakes_5_scenes(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  sb = write_sb(tmp_path)
  out_dir = tmp_path / "out"
  rc, out, err = run_gen(capfd, exec_args(sb, out_dir))
  assert rc == 0, (out[-800:], err[-800:])
  final = last_json_line(out)
  assert final["status"] == "ok" and final["rendered"] is True
  assert final["project"] == "fake-project" and final["project_source"] == "flag"
  assert final["calls_made"] == {"image": 5, "video": 5, "tts": 1, "music": 1}
  assert Path(final["output_dir"]).resolve() == out_dir.resolve()

  assert (
    fake_sdk.count("image") == 5 and fake_sdk.count("video") == 5 and fake_sdk.count("tts") == 1
  )
  for call in fake_sdk.of("image"):
    assert call["api"] == "generate_content_image" and call["model"] == DEFAULTS["image"]
    assert call["aspect_ratio"] == "16:9" and call["location"] == "us-central1"
  for call in fake_sdk.of("video"):
    assert call["model"] == DEFAULTS["video"] and call["location"] == "us-central1"
    assert call["duration_seconds"] == 6 and call["aspect_ratio"] == "16:9"
    assert call["generate_audio"] is False and call["used_source"] is True
    assert call["image_location"] and Path(call["image_location"]).name.startswith("shot_")
  tts = fake_sdk.of("tts")[0]
  assert tts["model"] == DEFAULTS["tts"] and tts["location"] == "global"
  assert tts["voice_name"] == "Kore" and tts["language_code"] == "en-US"

  locations = [c.get("location") for c in fake_sdk.clients]
  assert set(locations) == {"us-central1", "global"} and len(locations) == len(set(locations)), (
    locations
  )
  assert all(
    c.get("project") == "fake-project" and c.get("enterprise") is True for c in fake_sdk.clients
  )

  assert len(fake_sdk.lyria_requests) == 1
  req = fake_sdk.lyria_requests[0]
  assert req["url"] == LYRIA_GLOBAL.format(p="fake-project")
  assert req["payload"]["instances"][0]["prompt"] == storyboards.MUSIC_PROMPT
  assert req["headers"].get("Authorization", "").startswith("Bearer ")
  assert "Bearer " not in out + err and fake_genai.FAKE_TOKEN not in out + err

  work = out_dir / "work"
  names = sorted(p.name for p in work.iterdir())
  expected = sorted(
    [f"shot_{i}.png" for i in range(1, 6)]
    + [f"shot_{i}.mp4" for i in range(1, 6)]
    + ["voiceover.wav", "music_bed.wav", "storyboard_resolved.json"]
  )
  assert names == expected, names
  resolved = json.loads((work / "storyboard_resolved.json").read_text(encoding="utf-8"))
  for shot in resolved["shots"]:
    assert Path(shot["clipFile"]).is_file() and Path(shot["keyframeFile"]).is_file()
  assert Path(resolved["audioSpec"]["voiceoverFile"]).is_file()
  assert Path(resolved["audioSpec"]["musicFile"]).is_file()
  final_mp4 = out_dir / "final_video_16x9.mp4"
  assert final_mp4.is_file()
  info = media_probe.probe(final_mp4)
  assert abs((info["video"]["stream_duration"] or info["duration"]) - 30.0) <= 0.05
  assert info["video"]["nb_frames"] == 720


def test_image_parts_mime_decide_extension(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.image_mode = {"Scene 1.": "jpeg", "Scene 2.": "text_then_png"}
  sb = write_sb(tmp_path, n=2)
  out_dir = tmp_path / "out"
  rc, out, err = run_gen(capfd, exec_args(sb, out_dir, "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  work = out_dir / "work"
  assert (work / "shot_1.jpg").is_file() and (work / "shot_2.png").is_file()
  assert not (work / "shot_1.png").exists()
  resolved = json.loads((work / "storyboard_resolved.json").read_text(encoding="utf-8"))
  assert Path(resolved["shots"][0]["keyframeFile"]).name == "shot_1.jpg"
  assert not (out_dir / "final_video_16x9.mp4").exists()


@pytest.mark.parametrize(
  "location, template", [("global", LYRIA_GLOBAL), ("us-central1", LYRIA_REGIONAL)]
)
def test_lyria_host_follows_music_location(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
  location: str,
  template: str,
) -> None:
  sb = write_sb(tmp_path, n=2)
  extra = ["--skip-assemble"] + ([] if location == "global" else ["--music-location", location])
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out", *extra, project="proj-x"))
  assert rc == 0, (out[-500:], err[-500:])
  assert [r["url"] for r in fake_sdk.lyria_requests] == [template.format(p="proj-x")]
  assert fake_sdk.lyria_requests[0]["timeout"] is not None
  assert (tmp_path / "out" / "work" / "music_bed.wav").read_bytes()[:4] == b"RIFF"


def test_lyria_bytes_base64_alias_is_tolerated(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.lyria_key = "bytesBase64Encoded"
  sb = write_sb(tmp_path, n=2)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out", "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  assert (tmp_path / "out" / "work" / "music_bed.wav").read_bytes()[:4] == b"RIFF"


def test_image_refusal_is_partial_failure_exit_7(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.image_mode = {"Scene 2.": "refuse"}
  sb = write_sb(tmp_path)
  out_dir = tmp_path / "out"
  rc, out, err = run_gen(capfd, exec_args(sb, out_dir))
  assert rc == 7, (out[-500:], err[-500:])
  final = last_json_line(out)
  assert final["status"] == "partial" and final["rendered"] is False
  assert [f["shotIndex"] for f in final["failed_shots"]] == [2]
  assert "can't create that image" in final["failed_shots"][0]["error"]
  assert final["project"] == "fake-project" and final["project_source"] == "flag"
  assert final["calls_made"]["image"] == 5 and final["calls_made"]["video"] == 4
  assert fake_sdk.count("image") == 5 and fake_sdk.count("video") == 4
  work = out_dir / "work"
  assert {f"shot_{i}.mp4" for i in (1, 3, 4, 5)} <= {p.name for p in work.iterdir()}
  assert not (work / "shot_2.mp4").exists()
  assert (work / "storyboard_resolved.json").is_file()
  assert not (out_dir / "final_video_16x9.mp4").exists()
  assert "Traceback" not in err


def test_existing_assets_are_reused(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
  media_dir: Path,
) -> None:
  sb = storyboards.generator_storyboard(n=2)
  sb["shots"][0]["keyframeFile"] = str(media_dir / "keyframe_800x600.png")
  sb["shots"][0]["clipFile"] = str(media_dir / "shot_1.mp4")
  path = storyboards.write_json(tmp_path / "sb.json", sb)
  rc, out, err = run_gen(capfd, exec_args(path, tmp_path / "out", "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  assert fake_sdk.count("image") == 1 and fake_sdk.count("video") == 1
  assert last_json_line(out)["calls_made"] == {"image": 1, "video": 1, "tts": 1, "music": 1}


def test_permanent_video_failure_then_resume(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.video_outcomes = {"mp2": ["error:3"]}  # INVALID_ARGUMENT: not retryable
  sb = write_sb(tmp_path, n=3)
  out_dir = tmp_path / "out"
  rc, out, err = run_gen(capfd, exec_args(sb, out_dir))
  assert rc == 7, (out[-500:], err[-500:])
  final = last_json_line(out)
  assert final["status"] == "partial" and [f["shotIndex"] for f in final["failed_shots"]] == [2]
  assert len([c for c in fake_sdk.of("video") if "mp2" in (c["prompt"] or "")]) == 1
  work = out_dir / "work"
  assert (work / "shot_1.mp4").is_file() and (work / "shot_3.mp4").is_file()
  assert not (work / "shot_2.mp4").exists()
  assert (work / "shot_2.png").is_file(), "the keyframe of the failed shot is checkpointed"
  resolved = json.loads((work / "storyboard_resolved.json").read_text(encoding="utf-8"))
  for shot in resolved["shots"]:
    if shot["shotIndex"] == 2:
      assert not shot.get("clipFile") or not Path(shot["clipFile"]).is_file()
    else:
      assert Path(shot["clipFile"]).is_file()

  assert resolved.get("failedShots"), "checkpoint lists the failed shot"
  assert Path(final["resolved_storyboard"]) == work / "storyboard_resolved.json"

  # second run (documented resume command: --storyboard <out>/work/storyboard_resolved.json):
  # the failure is gone and finished assets are reused (0 new calls for them)
  fake_sdk.video_outcomes = {}
  fake_sdk.calls.clear()
  fake_sdk.lyria_requests.clear()
  rc, out, err = run_gen(capfd, exec_args(work / "storyboard_resolved.json", out_dir))
  assert rc == 0, (out[-500:], err[-500:])
  assert fake_sdk.count("image") == 0 and fake_sdk.count("video") == 1
  assert fake_sdk.count("tts") == 0 and fake_sdk.lyria_requests == []
  final = last_json_line(out)
  assert final["status"] == "ok" and final["rendered"] is True
  assert final["calls_made"] == {"image": 0, "video": 1, "tts": 0, "music": 0}
  info = media_probe.probe(out_dir / "final_video_16x9.mp4")
  assert abs((info["video"]["stream_duration"] or info["duration"]) - 18.0) <= 0.05
  resolved = json.loads((work / "storyboard_resolved.json").read_text(encoding="utf-8"))
  assert "failedShots" not in resolved or not resolved["failedShots"]


def test_transient_veo_error_is_retried(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.video_outcomes = {"mp2": ["raise:503", "ok"]}
  sb = write_sb(tmp_path, n=2)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out", "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  assert len([c for c in fake_sdk.of("video") if "mp2" in (c["prompt"] or "")]) == 2
  assert no_sleep and all(s >= 0 for s in no_sleep)


def test_non_retryable_veo_error_is_not_retried(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.video_outcomes = {"mp1": ["raise:400"]}
  sb = write_sb(tmp_path, n=2)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out", "--skip-assemble"))
  assert rc == 7, (out[-500:], err[-500:])
  assert len([c for c in fake_sdk.of("video") if "mp1" in (c["prompt"] or "")]) == 1
  assert [f["shotIndex"] for f in last_json_line(out)["failed_shots"]] == [1]


def test_poll_timeout_exits_7_without_infinite_loop(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  clock = FakeClock()
  monkeypatch.setattr(time, "monotonic", clock.monotonic)
  monkeypatch.setattr(time, "sleep", clock.sleep)
  fake_sdk.video_outcomes = {"mp1": ["never"]}
  sb = write_sb(tmp_path, n=2)
  started = time.time()
  rc, out, err = run_gen(
    capfd,
    exec_args(
      sb, tmp_path / "out", "--skip-assemble", "--poll-interval", "10", "--poll-timeout", "30"
    ),
  )
  assert time.time() - started < 30, "poll loop must use the (patched) clock, not real time"
  assert rc == 7, (out[-500:], err[-500:])
  final = last_json_line(out)
  failed = [f for f in final["failed_shots"] if f["shotIndex"] == 1]
  assert failed and "timeout" in failed[0]["error"].lower()
  never_ops = [name for name, n in fake_sdk.polls.items() if n > 2]
  assert never_ops and max(fake_sdk.polls[n] for n in never_ops) <= 6


def test_no_secrets_in_outputs(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  fake_sdk.lyria_http_error = 403
  fake_sdk.image_raise = {"Scene 1.": [fake_genai.FakeAPIError(500, "Internal error")] * 4}
  sb = write_sb(tmp_path, n=2)
  out_dir = tmp_path / "out"
  rc, out, err = run_gen(capfd, exec_args(sb, out_dir))
  assert rc == 7, (out[-500:], err[-500:])
  assert fake_sdk.lyria_requests and fake_sdk.lyria_requests[0]["headers"].get("Authorization")
  blob = out + err
  for p in (out_dir / "work").glob("*.json"):
    blob += p.read_text(encoding="utf-8")
  assert "Bearer " not in blob and fake_genai.FAKE_TOKEN not in blob
  final = last_json_line(out)
  assert final["status"] == "partial"
  assert any(f["shotIndex"] == 1 for f in final["failed_shots"])


def test_client_kwarg_enterprise_or_vertexai(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
  monkeypatch: pytest.MonkeyPatch,
  fake_media_bytes: dict[str, Any],
) -> None:
  sb = write_sb(tmp_path, n=2)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out1", "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  assert fake_sdk.clients and all(
    c.get("enterprise") is True and "vertexai" not in c for c in fake_sdk.clients
  )

  legacy = fake_genai.Recorder(dict(fake_media_bytes))
  fake_genai.install(monkeypatch, legacy, enterprise_kwarg=False)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out2", "--skip-assemble"))
  assert rc == 0, (out[-500:], err[-500:])
  assert legacy.clients and all(
    c.get("vertexai") is True and "enterprise" not in c for c in legacy.clients
  )


def test_veo_audio_resolution_language_and_durations(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
) -> None:
  sb = write_sb(tmp_path, n=2, durations=[4, 8], language="de-DE", aspect="9:16")
  rc, out, err = run_gen(
    capfd,
    exec_args(
      sb,
      tmp_path / "out",
      "--skip-assemble",
      "--veo-audio",
      "--veo-resolution",
      "1080p",
      "--voice",
      "Puck",
    ),
  )
  assert rc == 0, (out[-500:], err[-500:])
  videos = sorted(fake_sdk.of("video"), key=lambda c: c["prompt"] or "")
  assert [c["duration_seconds"] for c in videos] == [4, 8]
  assert all(
    c["generate_audio"] is True and c["resolution"] == "1080p" and c["aspect_ratio"] == "9:16"
    for c in videos
  )
  assert all(c["aspect_ratio"] == "9:16" for c in fake_sdk.of("image"))
  tts = fake_sdk.of("tts")[0]
  assert tts["language_code"] == "de-DE" and tts["voice_name"] == "Puck"


def test_project_from_env_in_execute(
  tmp_path: Path,
  capfd: pytest.CaptureFixture[str],
  fake_sdk: fake_genai.Recorder,
  no_sleep: list[float],
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
  sb = write_sb(tmp_path, n=2)
  rc, out, err = run_gen(capfd, exec_args(sb, tmp_path / "out", "--skip-assemble", project=None))
  assert rc == 0, (out[-500:], err[-500:])
  final = last_json_line(out)
  assert final["project"] == "env-project" and final["project_source"] == "env"
  assert all(c.get("project") == "env-project" for c in fake_sdk.clients)
  assert fake_sdk.lyria_requests[0]["url"] == LYRIA_GLOBAL.format(p="env-project")


def test_no_pycache_in_scripts_dir() -> None:
  cache = GENERATOR.parent / "__pycache__"
  assert not cache.exists() or not any(cache.iterdir()), (
    "tests must not leave bytecode caches in the tree"
  )
