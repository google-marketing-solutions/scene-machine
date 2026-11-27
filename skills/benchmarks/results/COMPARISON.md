# COMPARISON - scene-machine v2.0.0 (e-mailed package) vs v2.1.0

Generated 2026-11-23T10:12:03Z from `baseline_v2.0.0.json` (captured 2026-11-20T16:48:21Z) and `latest.json` (captured 2026-11-23T10:11:09Z), both on ffmpeg version 9.0.2-1, Python 3.13.15, synthetic lavfi media only. Wall times are indicative (shared workstation, load varies between the two captures).

## Render benchmarks (`make bench`)

| Case | Metric | v2.0.0 | v2.1.0 | Gate |
| :--- | :--- | :--- | :--- | :--- |
| 5 x 6 s, 16:9, VO + music | wall time | 8.85 s | 10.59 s | < 60 s and <= 2x baseline |
| 5 x 6 s, 16:9, VO + music | video stream duration | 30.000 s (format) | 30.000 s (720 frames) | +/- 0.05 s |
| 5 x 6 s, 16:9, VO + music | integrated loudness (ebur128 / loudnorm) | -14.4 LUFS | -13.8 / -13.99 LUFS | -14 +/- 1.0 |
| 5 x 6 s, 16:9, VO + music | true peak | -8.7 dBTP | -7.9 dBTP | <= -1.0 |
| 3 x 6 s, 16:9 | wall time | 5.7 s | 7.39 s | < 60 s and <= 2x baseline |
| 3 x 6 s, 16:9 | video stream duration | 18.000 s (format) | 18.000 s (432 frames) | +/- 0.05 s |
| 3 x 6 s, 16:9 | integrated loudness (ebur128 / loudnorm) | -14.1 LUFS | -14.1 / -14.34 LUFS | -14 +/- 1.0 |
| 3 x 6 s, 16:9 | true peak | -8.7 dBTP | -8.6 dBTP | <= -1.0 |
| 5 x 6 s, 9:16 (primary) | wall time | 9.73 s | 11.66 s | < 60 s and <= 2x baseline |
| 5 x 6 s, 9:16 (primary) | video stream duration | 30.000 s (format) | 30.000 s (720 frames) | +/- 0.05 s |
| 5 x 6 s, 9:16 (primary) | integrated loudness (ebur128 / loudnorm) | -14.4 LUFS | -13.8 / -13.99 LUFS | -14 +/- 1.0 |
| 5 x 6 s, 9:16 (primary) | true peak | -8.7 dBTP | -7.9 dBTP | <= -1.0 |
| 5 x 6 s, 1:1 crop of the 9:16 render | wall time | 9.73 s | 11.66 s | < 60 s and <= 2x baseline |
| 5 x 6 s, 1:1 crop of the 9:16 render | video stream duration | 30.000 s (format) | 30.000 s (720 frames) | +/- 0.05 s |
| 5 x 6 s, 1:1 crop of the 9:16 render | integrated loudness (ebur128 / loudnorm) | -14.4 LUFS | -13.8 / -13.99 LUFS | -14 +/- 1.0 |
| 5 x 6 s, 1:1 crop of the 9:16 render | true peak | -8.7 dBTP | -7.9 dBTP | <= -1.0 |

## Failure modes (assembler; exit code and stderr)

| Case | v2.0.0 | v2.1.0 |
| :--- | :--- | :--- |
| aspectRatio 1:1 | exit 1 in 0.1 s, `ValueError: Unsupported aspectRatio '1:1'. Use '16:9' or '9:` | exit 5 in 0.09 s, JSON error `invalid_storyboard` |
| aspectRatio 4:3 | exit 1 in 0.11 s, `ValueError: Unsupported aspectRatio '4:3'. Use '16:9' or '9:` | exit 5 in 0.1 s, JSON error `invalid_storyboard` |
| 1 shot | exit 1 in 0.09 s, `ValueError: storyboard.json must contain at least 2 shots.` | exit 5 in 0.09 s, JSON error `invalid_storyboard` |
| malformed JSON | exit 1 in 0.1 s, `json.decoder.JSONDecodeError: Expecting property name enclos` | exit 5 in 0.09 s, JSON error `invalid_storyboard` |
| missing clip (shot 4) | exit 1 in 2.95 s, `FileNotFoundError: Missing video clip for shotIndex=4: /tmp/` | exit 3 in 0.09 s, JSON error `missing_input` |
| ffmpeg absent from PATH | exit 1 in 0.14 s, `FileNotFoundError: [Errno 2] No such file or directory: 'ffm` | exit 4 in 0.09 s, JSON error `dependency_missing` |
| no Pillow (system python3) | exit 0 in 4.5 s, `` | exit 4 in 0.08 s, JSON error `dependency_missing` |
| 1 s clip in a 6 s slot, no typoOverlay | exit 0; video stream 29.0 s / 696 frames while the summary reports 30.0 s | exit 0; video stream 30.0 s / 720 frames, summary `video_stream_duration_seconds` 30.0 |
| no Pillow, endcard | exit 0, status ok, endcard region luma 96.7115 at t = 17.0 s (card missing; the v2.1.0 render with Pillow measures 53.4 at the same instant) | exit 4 `dependency_missing`; with `--allow-no-overlays` exit 0 and `overlays_rendered: false` |

## Static conformance lint (`benchmarks/skill_lint.py`)

| | v2.0.0 | v2.1.0 |
| :--- | :--- | :--- |
| rules evaluated | 15 (prototype, 17 rules) | 23 (23 rules incl. TX-04, PD-03, PD-04) |
| FAIL | 2 (PK-01, PD-01) | 0 |
| WARN | 0 | 0 |

## Generator

| | v2.0.0 | v2.1.0 |
| :--- | :--- | :--- |
| default invocation | ~12 paid calls immediately, no dry-run flag (lint PD-01 FAIL) | dry-run (no SDK import, no client), plan table + JSON, exit 0 (PD-01 PASS) |
| missing project | ValueError traceback, exit 1 | argparse exit 2 naming --project and GOOGLE_CLOUD_PROJECT; gcloud default shown as a hint only |
| default models | imagen-3.0-generate-002 (retired), gemini-2.5-flash-preview-tts (retired), Lyria on the regional host | gemini-3.1-flash-image, veo-3.1-fast-generate-001 (generate_audio off, durationSeconds passed through), gemini-2.5-flash-tts, lyria-002 on the global host |
| one Veo failure | whole run aborts after the other clips were paid for; unbounded polling | 3 attempts with backoff, per-shot isolation, poll timeout, exit 7 with the failed-shot list, resume with 0 new calls for finished shots |
| contract tests | prototype 7/7 in 74.92 s (v2.0.0 semantics) | tests/test_generator_contract.py 49 + test_media_backend.py 23 + test_sdk_surface.py 6 against the real pinned SDK surface |

## Test suite (`make test`)

- v2.1.0: 260 passed, 1 skipped, 0 xfailed (hermetic: fake google-genai, no network, lavfi media).
- v2.0.0: no tests shipped.

## Not measured here

Live Vertex AI behaviour (model availability per region, Lyria host, TTS voices, Veo clip precision, quota errors, real cost) requires a GCP project and is listed in the README section "Known limitations and what was not tested here".
