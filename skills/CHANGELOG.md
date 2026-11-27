# Changelog

All notable changes to the `scene-machine` skill package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow the `metadata.version` field of `scene-machine/SKILL.md`.

## [2.1.0] - 2026-11-20

First release prepared for publication in
`github.com/google-marketing-solutions/scene-machine` (directory `skills/`).
Verified 2026-11-23: make lint test bench zip green (260 passed, 1 skipped); see
benchmarks/results/COMPARISON.md.

### Breaking changes

- Exit codes: both scripts now return 2 (usage), 3 (missing input),
  4 (dependency missing or ffmpeg failed), 5 (invalid storyboard),
  6 (output verification failed) and 7 (partial, resumable media generation
  failure) with a one-line JSON object on stderr; exit 1 is reserved for
  unexpected internal errors. Callers that tested for exit 1 must be updated.
- The generator no longer performs paid calls by default. `--dry-run` is the
  default; `--execute` is required for generation and needs an explicit
  project (`--project` or `GOOGLE_CLOUD_PROJECT`). The gcloud default project
  is only displayed as a hint and is never billed implicitly.
- The assembler no longer copies deliverables implicitly into a hard-coded
  `deliverables` directory at the filesystem root of container runtimes.
  Mirroring is opt-in via `--mirror-dir PATH` or `SCENE_MACHINE_MIRROR_DIR`.
- Default output locations moved to `${SCENE_MACHINE_WORKDIR:-./.scene_machine}`
  (add `.scene_machine/` to your `.gitignore`).
- Pillow is now required for lower-thirds and the endcard; without it the
  assembler exits 4 unless `--allow-no-overlays` is passed (previously the
  overlays were skipped silently).
- The retired model ids `imagen-3.0-generate-002` and
  `gemini-2.5-flash-preview-tts` are no longer accepted; the error names the
  replacement.

### Added

- Model registry and adapters (M1): `scene-machine/scripts/model_registry.json`
  with an `api` discriminator, per-model locations and `default_location`,
  `status` (`active`, `preview`, `retired`, `successor`) and `last_verified`
  (2026-11-27) covering Gemini Image (`gemini-3.1-flash-image`,
  `gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`,
  `gemini-3-pro-image`, `gemini-2.5-flash-image`), Veo 3.1
  (`veo-3.1-fast-generate-001`, `veo-3.1-generate-001`,
  `veo-3.1-lite-generate-001`), Gemini TTS (`gemini-2.5-flash-tts`,
  `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`,
  `gemini-3.1-flash-tts-preview`), Lyria 2 (`lyria-002`), retired Imagen 3/4
  and Veo 2/3.0 ids, and Interactions API entries (`gemini-omni-1.2-flash`,
  Omni previews, `lyria-3-pro-preview`, `lyria-3-clip-preview`) recorded with
  `api: interactions`; `media_backend.py` with one adapter per API family and
  one client per location; `--list-models`.
- Dry-run plan and explicit execution (M2): prerequisite block (ffmpeg,
  ffprobe, Pillow, google-genai importable, ADC file, gcloud project hint),
  storyboard validation before any call, plan table with per-kind call counts,
  `planned_calls`, `project` and `project_source` in the plan and in the final
  summary, `calls_made` per kind after `--execute`. New flags: `--execute`,
  `--project`, `--location`, `--music-location`, `--image-model`,
  `--video-model`, `--tts-model`, `--music-model`, `--voice`, `--veo-audio`,
  `--veo-resolution`, `--max-workers`, `--poll-interval`, `--poll-timeout`,
  `--list-models`, `--no-strict-copy`, `--output-dir`, `--skip-assemble`,
  `--version`.
- Capability-based runtime detection (M3): SKILL.md Step 1 describes the
  capabilities to look for instead of literal tool names;
  `references/runtimes.md` carries the alias table and per-tool notes;
  `<SKILL_DIR>` is defined as the directory containing SKILL.md;
  `scripts/env_probe.py` reports the environment as JSON; a defined
  terminal state for agents without network or credentials (storyboard and
  plan only, stated plainly).
- OSS packaging (M4): README with the OSS disclaimer, prerequisites, platform
  statement, cost warning in call units, model lifecycle notes, ADC
  quota-project note, install matrix and manual test plan; `install.sh`
  (copy by default, `--link`, `--force`, `--project-dir`, `--dry-run`) for
  Claude Code, Antigravity, Codex, Gemini CLI, Cursor, Windsurf, GitHub Copilot
  and generic `.agents/skills/` consumers; `Makefile`; pinned
  `requirements.txt` and `requirements-dev.txt`; `CONTRIBUTING.md`;
  `.gitignore`; GitHub Actions workflow (`ci/skill-ci.yml`).
- Assembler contract (M5): summary fields `video_stream_duration_seconds`,
  `audio_stream_duration_seconds`, `video_frames`, `integrated_lufs`,
  `true_peak_dbtp`, `overlays_rendered`, `output_files`, `mirrored_to`;
  `--allow-no-overlays`, `--no-overlays`, `--mirror-dir`; upfront validation
  of the storyboard and of every clip; `short_clip` warnings on stderr.
- Bounded, resumable generation (M6): per-clip poll deadline
  (`--poll-timeout`, default 900 s) and interval (`--poll-interval`, default
  10 s); per-shot failure isolation; checkpoint
  `work/storyboard_resolved.json` after every asset; exit 7 with the list of
  failed shots; re-running with the resolved storyboard reuses finished assets.
- Tests, benchmarks and lint (M7): hermetic pytest suite (fake google-genai
  with documented response shapes, FFmpeg lavfi fixtures, SDK surface test,
  runtime-detection fixtures, install.sh tests), skill conformance lint,
  render benchmarks with a baseline comparison, eval cases.
- Retry with exponential backoff (3 attempts) on 429, 5xx,
  `RESOURCE_EXHAUSTED` and `UNAVAILABLE` for every media call (S1).
- Triggers-first skill description within the 700-character budget (S3).
- TTS `language_code` derived from `storyboard.language` (BCP-47) (S4).
- Path A hardening: fallback when no video agent is available, aspect ratio
  stated inside the director prompt (S5).
- Eval cases with deterministic validators, plus an advisory LLM-judge rubric
  that is not run in CI (S6).
- Example storyboards `assets/examples/storyboard_5x6.json` and
  `storyboard_3x6.json` for the fictional NordicGlow brand.

### Changed

- Default models: image `gemini-3.1-flash-image` (was
  `imagen-3.0-generate-002`), TTS `gemini-2.5-flash-tts` (was
  `gemini-2.5-flash-preview-tts`); video stays `veo-3.1-fast-generate-001`,
  music stays `lyria-002` but is called at `global` by default
  (`--music-location us-central1` remains selectable).
- Storyboard schema 2.1: `shots` 2 to 6 entries, `durationSeconds` one of
  4, 6 or 8 (passed through to Veo), `aspectRatio` stays `16:9` or `9:16`
  with square output documented as `exportSquareCrop: true` on a 9:16 render,
  `language` is BCP-47 and drives TTS, `musicPrompt` must be English (ASCII),
  `typoOverlay` fields may be null (coerced to an empty string).
- Assembler: `tpad` fills the whole slot instead of a fixed 4 s; two-pass
  `loudnorm`; macOS and Windows font candidates plus Pillow's scalable default
  font; generated `storyboard.md` is ASCII only with escaped pipes.
- The generator streams the assembler output and propagates its exit code.
- Real brand names in examples and prose were replaced by the fictional
  NordicGlow brand.
- SKILL.md rule 1 reworded: produce the playable video immediately when the
  prerequisites and a project are present; otherwise deliver the storyboard
  and the plan and say that no video was rendered.
- `metadata.version` is `2.1.0`.

### Fixed

- The endcard and lower-thirds were skipped silently when Pillow was missing;
  the assembler now fails fast with a JSON error (exit 4).
- A video stream shorter than the storyboard total (for example 29 s) was
  reported as 30.0 s; the summary now reports stream-level durations and
  exits 6 when the video stream misses the expected duration by more than
  0.05 s.
- Veo clips were always requested with `duration_seconds=6` regardless of the
  storyboard; the value is now taken from each shot.
- Veo polling had no deadline and a single quota error aborted the run after
  paid clips had been generated; polling is bounded and shots fail
  independently.
- Lyria 2 was called on a regional host for the `global` location; the host
  now follows the location.
- `typoOverlay` null values no longer crash the overlay renderer.
- Model registry: the preview TTS entry (`gemini-3.1-flash-tts-preview`)
  carries `last_verified` like every other selectable entry (lint PD-04).

### Removed

- The implicit deliverables mirror (see breaking changes).
- Literal `run_command`-based runtime detection in SKILL.md.
- `final_video_1x1.mp4` as an advertised primary output; it is produced only
  when `exportSquareCrop` is set and is a centre crop of the 9:16 render.
- Hard-coded Linux-only font lookup.

## [2.0.0]

- Initial package distributed by e-mail (SKILL.md, `assemble_ad_video.py`,
  `generate_ad_spot_vertex.py`, one reference document and a short README).
  Not published.
