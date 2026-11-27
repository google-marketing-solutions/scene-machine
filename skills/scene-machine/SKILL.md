---
name: scene-machine
description: >-
  Use when the user asks for an ad video, commercial spot, promo video, product
  video, YouTube In-Stream or Shorts ad, or a video storyboard from a brand
  brief, campaign metrics or product images. Produces a YouTube ABCD storyboard
  and, where the runtime allows, the rendered MP4: a stitched 30 s (5 x 6 s) or
  18 s (3 x 6 s) spot with voiceover, music and brand typography via Vertex AI
  and FFmpeg, or an 8 s hero clip via the Gemini Enterprise video agent.
  Dry-run and cost plan first; paid generation only on explicit request with a
  named Google Cloud project. Do not use for slide decks, still images or
  audio-only content.
license: Apache-2.0
metadata:
  version: "2.1.0"
  category: "creative-video-production"
---

# Scene Machine - Commercial Video Ad Producer

Turn a brand brief, campaign metrics or product photos into a commercial video
ad structured by the YouTube ABCD principles (Attract, Brand, Connect, Direct).

## Rules

1. Produce the playable video immediately when the prerequisites and a Google
   Cloud project are present; otherwise deliver the storyboard and the plan
   and say that no video was rendered. Never claim a video exists before the
   verification in Section C step 5 passed.
2. No decorative emojis in headings, tables or summaries.
3. Language matching: voiceover, dialogue and on-screen headlines follow the
   language of the user's prompt (German prompt, German copy); camera and
   lighting descriptions stay in English; `musicPrompt` is always English.
4. Paid generation (`--execute`) only when the user asked for the video and
   named or configured a project. Never choose a project on your own.

## Conventions

- `<SKILL_DIR>` is the directory containing this SKILL.md. Resolve it from the
  path you loaded the skill from (typical roots per tool are listed in
  `references/runtimes.md`); `scripts/env_probe.py` prints it as `skill_dir`.
- Work dir `WORK="${SCENE_MACHINE_WORKDIR:-./.scene_machine}"` holds the
  storyboard, generated media and `output/`. Inside a repository add
  `.scene_machine/` to `.gitignore` before writing anything.
- `SCENE_MACHINE_MIRROR_DIR` (or `--mirror-dir`) additionally copies the
  deliverables to a fixed folder for runtimes that collect results there.
- `references/youtube_abcd_and_schema.md`: ABCD timing, prompt rules, the
  storyboard schema v2.1 and a worked example; complete authoring examples
  (30 s and 18 s) in `assets/examples/`.

## Step 1 - Detect capabilities and choose a path

Inspect the tools you were given (names differ per runtime) and classify them:

- shell: any tool that runs a shell command. Aliases: Bash, run_shell_command,
  shell, exec_command, run_terminal_cmd, run_command, execute_command,
  run_in_terminal, execute_bash, executeBash, runTerminalCommand,
  code_execution.
- media_tools: built-in image AND video generation tools that write files.
- agent_xfer: an agent transfer tool (`transfer_to_agent`) or a video agent
  (`videogen_agent`, `gen_video`).

| Condition | Path |
| :--- | :--- |
| agent_xfer and no shell | A (Section A): Gemini Enterprise web chat |
| shell and media_tools | B (Section B): VM agent with built-in media tools |
| shell only | C (Section C): Vertex AI pipeline, dry-run first |
| none of the above | NONE: explain, deliver storyboard and prompts only |

Google Antigravity (IDE and CLI) has no built-in media tools for the agent:
it is Path C, never B. Terminal state without network access or application
default credentials (Codex cloud, the Copilot coding agent, any sandbox):
produce the storyboard and the dry-run plan and state plainly that no video
was rendered. Discovery directories, tool aliases per runtime, sandbox caveats
and the smoke test are in `references/runtimes.md`.

## Section A - Gemini Enterprise web chat (turn-1 hero clip)

The video agent (`videogen_agent`) renders one 8-second clip with native audio
per turn and returns it to the chat; the script sandbox is air-gapped and
cannot stitch or return MP4 files. Therefore:

- Never answer turn 1 with a `storyboard.json` wall of text instead of
  calling the video agent.
- Never promise a stitched 30-second file in web chat. If the user asks for
  one, generate Scene 1 now and say in one sentence, before transferring,
  that web chat renders one 8-second scene per turn (the same skill in a
  shell runtime stitches 5 x 6 s into one 30-second MP4).
- Fallback: if `transfer_to_agent` or `videogen_agent` is absent (video
  generation disabled in the tenant), deliver the storyboard and the
  8-second director prompt below and say in one sentence that this
  environment cannot render video.

Turn-1 steps:

1. Compress the brief into one complete 8-second ABCD director prompt
   (English, with the exact voiceover quoted in the user's language):
   - 0.0-2.0 s (Attract): immediate macro or dynamic hook with the signature
     brand lighting and colours.
   - 2.0-5.0 s (Brand and Connect): one continuous camera move revealing the
     product in an authentic human or seasonal context.
   - 5.0-8.0 s (Direct): clean hero composition settling into a closing
     frame. Keep slogans and URLs out of the visual frame (diffusion models
     misspell text).
   - Audio block: music direction plus a 12-16-word quoted voiceover, e.g.
     `Audio: warm acoustic commercial score with soft chimes. A calm,
     confident narrator says: "When the first frost arrives, NordicGlow
     brings radiant warmth back to your skin."`
   - State the aspect ratio inside the prompt text: "16:9 landscape" by
     default, "9:16 vertical" for Shorts, Reels, TikTok or vertical requests.
2. Call `transfer_to_agent(agent_name="videogen_agent")` immediately with
   that prompt so the user receives the video on turn 1.
3. Follow-up scenes: on request, transfer again with the next ABCD scene
   prompt, keeping palette, wardrobe and musical style identical.

## Section B - VM agent with built-in media tools (stitched spot)

1. Read `references/youtube_abcd_and_schema.md`; create `$WORK`.
2. Generate the music bed (English `musicPrompt`, instrumental) and the
   50-65-word voiceover in the user's language with the built-in tools.
3. Normalise user photos with `python3 "<SKILL_DIR>/scripts/assemble_ad_video.py"
   normalize-image --input <file> --output <png> --aspect-ratio 16:9`;
   generate the remaining keyframes (16:9 default, 9:16 on request, no
   baked-in text).
4. Animate every keyframe (6 s, first frame = keyframe) with the 3-layer
   motion prompt (`[VISUAL ANCHOR LOCK]`, `[CAMERA TRAJECTORY]`,
   `[LIGHTING & MICRO-PHYSICS]`).
5. Write `$WORK/storyboard.json` with the generated file paths
   (`clipFile`, `keyframeFile`, `musicFile`, `voiceoverFile`), then assemble:
   ```bash
   python3 "<SKILL_DIR>/scripts/assemble_ad_video.py" render \
     --storyboard "$WORK/storyboard.json" --output-dir "$WORK/output"
   ```
   Add `--mirror-dir <dir>` when the runtime collects deliverables from a
   fixed folder. Verify as in Section C step 5.

## Section C - Shell runtime with Vertex AI (dry-run first)

Prerequisites: Python 3.11+, ffmpeg and ffprobe, Pillow, google-genai,
application default credentials and a Google Cloud project with the Vertex
AI API enabled. Both scripts exit 0 ok, 2 usage, 3 missing input,
4 dependency missing, 5 invalid storyboard, 6 verification failed,
7 partial media failure (resumable); errors are one JSON line on stderr.

1. Probe: `python3 "<SKILL_DIR>/scripts/env_probe.py"` (JSON; `--text` for a
   table). Read `skill_dir`, `workdir`, `ready_for_execute` and `next_step`.
   If ffmpeg, Pillow or google-genai is missing, tell the user the install
   step (`pip install pillow google-genai`; ffmpeg from the OS package
   manager) and still continue with the storyboard and the dry-run.
2. Storyboard: read `references/youtube_abcd_and_schema.md`, then write
   `$WORK/storyboard.json`: 5 shots (30 s) or 3 shots (18 s) with
   `durationSeconds` 6 (4 and 8 are allowed), `aspectRatio` `16:9` or `9:16`
   (square output: `9:16` plus `exportSquareCrop: true`, a centre crop),
   `language` as a BCP-47 tag (`en-US`, `de-DE`), a 50-65-word
   `voiceoverScript` in the user's language (count the words), an English
   `musicPrompt`, `typoOverlay` and `endcardSpec` for all on-screen text. Do
   not add `clipFile`, `keyframeFile`, `voiceoverFile` or `musicFile`.
3. Dry-run (default; no SDK import, no project, nothing billed):
   ```bash
   python3 "<SKILL_DIR>/scripts/generate_ad_spot_vertex.py" --storyboard "$WORK/storyboard.json"
   ```
   Relay the plan table (kind, model, location, count, unit cost note),
   `planned_calls`, `project` and `project_source` from the final JSON line,
   and the cost note: a 5-shot spot makes about 12 paid calls (5 image,
   5 video x 6 s, 1 TTS, 1 music), billed to the project. Exit 5 lists what
   to fix in the storyboard; fix it and re-run.
4. Execute only when the user asked for the video and named or configured a
   project (`--project <id>` or `GOOGLE_CLOUD_PROJECT`; the gcloud default
   shown in the plan is a hint, never a choice you make):
   ```bash
   python3 "<SKILL_DIR>/scripts/generate_ad_spot_vertex.py" \
     --storyboard "$WORK/storyboard.json" --execute --project <id>
   ```
   Options: `--location` (per-model default), `--music-location`
   (default `global`), `--voice` (default `Kore`), `--max-workers` (3),
   `--poll-interval` (10 s), `--poll-timeout` (900 s), `--veo-audio`,
   `--veo-resolution`, `--image-model/--video-model/--tts-model/--music-model`,
   `--list-models`, `--no-strict-copy`, `--skip-assemble`, `--output-dir`
   (default `$WORK/output`). Exit 7 prints `failed_shots`; resume with the
   same flags and `--storyboard <output-dir>/work/storyboard_resolved.json`
   (finished shots make no new calls).
5. Verify before claiming a video exists: the assembler summary JSON
   (`status: ok`, printed before the generator's final `rendered: true`
   line) must show `video_stream_duration_seconds` within 0.05 s of
   `expected_duration_seconds`, `integrated_lufs` near -14, `true_peak_dbtp`
   at or below -1 and `overlays_rendered: true`. Then present the absolute
   output paths and a short ABCD scene table.

Outputs in `$WORK/output`: `final_video_16x9.mp4` or `final_video_9x16.mp4`
(plus `final_video_1x1.mp4` only with `exportSquareCrop`), `storyboard.json`
(resolved) and `storyboard.md`.

Assembler only (clips already exist, for example from Section B):
```bash
python3 "<SKILL_DIR>/scripts/assemble_ad_video.py" render \
  --storyboard <path> --output-dir <dir> [--allow-no-overlays] [--mirror-dir <dir>]
```
Without Pillow the assembler exits 4 unless `--allow-no-overlays` is given
(then no lower-thirds and no endcard are rendered).
