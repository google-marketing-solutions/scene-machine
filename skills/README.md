# Scene Machine skill (`scene-machine`)

`scene-machine` is an Agent Skill (a `SKILL.md` folder following the open Agent
Skills format) that turns a brand brief, campaign metrics or product images into
a commercial video spot built on the YouTube ABCD framework (Attention, Branding,
Connection, Direction). The pipeline is: storyboard -> Vertex AI media
(keyframe images, Veo clips, Gemini TTS voiceover, Lyria 2 music) -> FFmpeg
assembly with lower-thirds, an endcard and -14 LUFS mastering. The skill adapts
to the agent runtime it is loaded into:

- Path A (Gemini Enterprise web chat): delegates to the built-in video agent and
  returns one 8-second hero clip per turn; no local tools.
- Path B (agent runtime with a shell and built-in media generation tools): the
  agent generates the clips with its own tools and runs only the FFmpeg
  assembler.
- Path C (agent runtime with a shell only - Claude Code, Antigravity, Codex,
  Gemini CLI, Cursor, Windsurf, Copilot and similar): the generator script calls
  Vertex AI and then the assembler; a dry-run that imports no SDK and bills
  nothing is the default.
- Plan only (no shell, no network or no credentials): the agent writes the
  storyboard and the dry-run plan and states that no video was rendered.

This is not an officially supported Google product.

The example brand used throughout the package, NordicGlow, is fictional.

## Repository layout

On GitHub this directory is `skills/` inside the
[scene-machine](https://github.com/google-marketing-solutions/scene-machine)
repository and the workflow lives at `.github/workflows/skill-ci.yml`; a mirror
of this directory in another source tree keeps the same workflow under
`ci/skill-ci.yml`. Apart from that location the two trees are identical.

    skills/                              (this directory)
      README.md  CHANGELOG.md  CONTRIBUTING.md  Makefile  install.sh  .gitignore
      requirements.txt  requirements-dev.txt  ruff.toml  pytest.ini
      ci/skill-ci.yml                    GitHub: .github/workflows/skill-ci.yml
      scene-machine/                     the skill (frontmatter name == directory)
        SKILL.md
        scripts/assemble_ad_video.py  generate_ad_spot_vertex.py  media_backend.py
                model_registry.json  env_probe.py
        references/youtube_abcd_and_schema.md  runtimes.md
        assets/examples/storyboard_5x6.json  storyboard_3x6.json
      tests/                             hermetic pytest suite
      benchmarks/                        skill lint, runtime fixtures, render benchmarks, eval cases
      dist/                              build output only (make zip), git-ignored, never shipped

Only `scene-machine/` is installed into agent tools; everything else is
development tooling.

## Prerequisites

- Python >= 3.11 (developed and tested with 3.13; CI runs 3.11, 3.12 and 3.13).
- ffmpeg and ffprobe >= 6 recommended (developed against 9.0.2; CI also runs
  the 4.4 and 6.1 builds shipped by Ubuntu 22.04 and 24.04). Debian/Ubuntu:
  `sudo apt-get install -y ffmpeg`; macOS: `brew install ffmpeg`.
- Pillow (lower-thirds and endcard; required unless the assembler is run with
  `--allow-no-overlays`).
- `google-genai` pinned to 3.6.1 and `google-auth` 2.62.2 (the Lyria 2 call
  uses the REST endpoint with an ADC token). Both are needed only for
  `--execute`; `--help`, `--dry-run`, `--list-models` and the assembler work
  without them.

Recommended setup from this directory:

    python3 -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt
    python3 scene-machine/scripts/env_probe.py

`env_probe.py` prints a JSON report (skill directory, Python, ffmpeg/ffprobe
versions, Pillow, google-genai, google-auth, ADC file, gcloud project hint,
writable work directory, mirror directory, fonts, `ready_for_execute`,
`next_step`); `--text` prints the same as a table (`--json` is the default).
It always exits 0. For development and tests use
`pip install -r requirements-dev.txt`.

## Platform support

Linux and macOS are supported. Windows is untested: the assembler contains
Windows font paths, but they are unverified, and `install.sh` requires bash.

## Cost warning

Running the generator with `--execute` makes paid calls to Vertex AI in the
project you name. Guard rails:

- Dry-run is the default. `python3 scene-machine/scripts/generate_ad_spot_vertex.py --storyboard <file>`
  validates the storyboard, prints the prerequisites, the resolved project and
  its source, a plan table and one JSON line (`"status": "dry_run",
  "rendered": false, "planned_calls": N`), and imports no SDK.
- `--execute` requires an explicit project: `--project <project-id>` or the
  `GOOGLE_CLOUD_PROJECT` environment variable. The gcloud default project is
  displayed as a hint only and is never billed implicitly; without an explicit
  project the generator exits 2.
- Approximate call counts for the default 5-scene storyboard
  (`assets/examples/storyboard_5x6.json`): 5 image generations (one keyframe
  per shot), 5 video generations of 6 s each (audio generation is off by
  default; `--veo-audio` enables it at the with-audio rate), 1 text-to-speech
  call and 1 music clip: 12 calls. The 3-scene example makes 8 calls. The plan
  table prints the exact numbers for your storyboard before anything runs.
- Re-running after a partial failure (exit 7) reuses finished assets and does
  not repeat their calls.

Prices change; this README deliberately gives no figures. See the Vertex AI
generative AI pricing page:
<https://cloud.google.com/vertex-ai/generative-ai/pricing> (checked
2026-11-20). Use a sandbox project with a budget cap for the first run.

## Model availability, regions and lifecycle

Model ids, API families, locations and lifecycle status live in
`scene-machine/scripts/model_registry.json` (`last_verified` 2026-11-27).
`python3 scene-machine/scripts/generate_ad_spot_vertex.py --list-models` prints
the table.

| Kind | Default model | Location | Notes |
| :--- | :--- | :--- | :--- |
| image | `gemini-3.1-flash-image` | `global` by default (`us`, `eu` also listed; override with `--location`) | keyframes via `generate_content` (`IMAGE` modality); also selectable: `gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image` (retiring 2027-03-15) |
| video | `veo-3.1-fast-generate-001` | `us-central1` by default (`global` also listed; override with `--location`) | 16:9 or 9:16, 4/6/8 s clips, audio off by default; also selectable: `veo-3.1-generate-001`, `veo-3.1-lite-generate-001` (preview) |
| tts | `gemini-2.5-flash-tts` | `global` (`us`, `eu` also listed on 3.8 models) | voice `--voice` (default `Kore`), language from the storyboard; also selectable: `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview` |
| music | `lyria-002` | `--music-location` (default `global`; `us-central1` selectable) | public docs disagree on the location (model card: `global`; API sample: `us-central1`), so both are selectable; English prompts only |

- Retired ids are rejected before any call with the replacement named:
  Imagen 3/4 (`imagen-3.0-generate-001`, `imagen-3.0-generate-002`,
  `imagen-4.0-generate-001`, `imagen-4.0-ultra-generate-001`) ->
  `gemini-3.1-flash-image`, Veo 2/3.0 (`veo-2.0-generate-001`,
  `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`) -> Veo 3.1, and
  `gemini-2.5-flash-preview-tts` -> `gemini-2.5-flash-tts`.
- Interactions API media models (`gemini-omni-1.2-flash`, deprecated previews
  `gemini-omni-1.1-flash-preview` and `gemini-omni-flash-preview`, plus
  `lyria-3-pro-preview` and `lyria-3-clip-preview`) are recorded in the
  registry with `status: successor` and `api: interactions`; they use a
  different API shape (GCS URI video delivery for Omni; MP3 song output for
  Lyria 3) and have no adapter yet, so they are not selectable.
- Availability per region and the lifecycle dates were verified against the
  public Google Cloud model catalog on 2026-11-27 and exercised live on
  Vertex AI. Re-verify the registry before each release and update
  `last_verified` (the lint fails when it is older than 180 days).

## Authentication

The generator uses Application Default Credentials (ADC):

    gcloud auth application-default login
    gcloud auth application-default set-quota-project <project-id>

The second command matters: without a quota project, user ADC calls to Vertex
AI can be rejected or billed to the wrong project. Alternatively point
`GOOGLE_APPLICATION_CREDENTIALS` at a service-account key file; the dry-run and
`env_probe.py` report whether an ADC file is present at that path or at the
default location (`~/.config/gcloud/application_default_credentials.json`).

The project that is billed is always explicit: `--project <project-id>` or
`GOOGLE_CLOUD_PROJECT`. `gcloud config set project` alone is not enough for
`--execute` (it only changes the displayed hint). The Vertex AI API must be
enabled in that project.

## Install matrix

Expected path: A = Gemini Enterprise video agent, C = local scripts via Vertex
AI, plan-only = storyboard and dry-run plan without a rendered video. Shell
tool names are what the agent sees; "(unverified)" marks names and directories
taken from third-party or secondary sources that were not confirmed against an
official document and should be re-checked with the detection smoke prompt in
"Verification".

| Tool | Tier | Install command | Project path | Global path | Shell tool the agent sees | Expected path | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Code | 1 | `./install.sh --target claude` (add `--project-dir <repo>` for a project copy) | `.claude/skills/scene-machine/` | `~/.claude/skills/scene-machine/` | `Bash` | C | `/skills` lists the skill |
| Google Antigravity (IDE, `agy` CLI) | 1 | `./install.sh --target antigravity --project-dir <workspace>` | `.agent/skills/scene-machine/` (primary) and `.agents/skills/scene-machine/` | `~/.gemini/antigravity/skills/scene-machine/` | `run_command` (unverified) | C, never B (no media tools the skill can call) | install into the workspace `.agent/skills/` first; the global directory has known discovery issues in current builds |
| OpenAI Codex CLI / IDE extension | 1 | `./install.sh --target codex` | `.agents/skills/scene-machine/` | `~/.agents/skills/scene-machine/` or `$CODEX_HOME/skills/scene-machine/` | `shell` | C | `/skills` in Codex lists it |
| OpenAI Codex cloud | 1 | commit `.agents/skills/scene-machine/` to the repository (`--project-dir <repo>`) | `.agents/skills/scene-machine/` | n/a | `shell` | plan-only unless credentials are configured | network is off by default and there is no ADC in the container |
| Gemini CLI | 2 | `./install.sh --target gemini` or `gemini skills link $(pwd)/scene-machine` | `.gemini/skills/scene-machine/` | `~/.gemini/skills/scene-machine/` | `run_shell_command` | C | `gemini skills list` confirms discovery |
| Cursor | 2 | `./install.sh --target cursor` | `.cursor/skills/scene-machine/` | `~/.cursor/skills/scene-machine/` | `run_terminal_cmd` (unverified) | C | also reads `.agents/skills/` and `.claude/skills/` |
| Windsurf (Cascade) | 2 | `./install.sh --target windsurf` | `.windsurf/skills/scene-machine/` | `~/.codeium/windsurf/skills/scene-machine/` | `run_command` | C | Cascade > Skills shows the skill |
| GitHub Copilot (VS Code agent mode, CLI) | 2 | `./install.sh --target copilot --project-dir <repo>` | `.github/skills/scene-machine/` (committed content, not a symlink) | `~/.copilot/skills/scene-machine/` | `run_in_terminal` (unverified) | C | also reads `.claude/skills/` and `.agents/skills/` |
| GitHub Copilot coding agent | 2 | commit `.github/skills/scene-machine/` | `.github/skills/scene-machine/` | n/a | `run_in_terminal` (unverified) | plan-only unless credentials are configured | credentials and ffmpeg must be provided through `copilot-setup-steps`; the runner has an egress firewall |
| Cline | 3 | `./install.sh --target agents --project-dir <repo>`, then copy `scene-machine/` into the Cline skills directory | `.clinerules/skills/` or `.cline/skills/` (unverified which, varies by version) | n/a | `execute_command` | C | |
| Roo Code | 3 | copy `scene-machine/` manually | `.roo/skills/scene-machine/` (unverified) | `~/.roo/skills/scene-machine/` (unverified) | `execute_command` | C | |
| Kiro | 3 | copy `scene-machine/` manually | `.kiro/skills/scene-machine/` (unverified) | `~/.kiro/skills/scene-machine/` (unverified) | `executeBash` (unverified) | C | |
| OpenHands | 3 | `./install.sh --target agents --project-dir <repo>` | `.agents/skills/scene-machine/` or `.openhands/skills/` | n/a | `execute_bash` | C | runs in a container sandbox; use `--mirror-dir` or `SCENE_MACHINE_MIRROR_DIR` to collect deliverables |
| Amp | 3 | `./install.sh --target agents` | `.agents/skills/scene-machine/` (unverified) | `~/.agents/skills/scene-machine/` (unverified) | `Bash` (unverified) | C | |
| Zed | 3 | add the skill through the agent panel | managed by Zed | managed by Zed | depends on the configured agent | C | (unverified) |
| Continue | 3 | reference `scene-machine/SKILL.md` as a rule | `.continue/rules/` | n/a | `runTerminalCommand` (unverified) | C | no skill discovery; the file must be referenced manually |
| Jules | 3 | point to the skill from `AGENTS.md`; install prerequisites in the environment setup script | n/a | n/a | VM shell | plan-only unless credentials are configured | no documented skill discovery (unverified) |
| Aider | 3 | `/read-only scene-machine/SKILL.md` | n/a | n/a | none (the human runs the scripts) | C, executed by the human | |
| Gemini Enterprise web chat | GE | `make zip`, then upload `dist/scene-machine.zip` on the Skills page | n/a | n/a | none (built-in video agent via `transfer_to_agent`) | A | whether uploaded `scripts/` are executed by the chat sandbox is unverified; Path A does not depend on it |

## Install methods

Use them in this order of preference.

### a) Clone and run `install.sh` (recommended)

    git clone https://github.com/google-marketing-solutions/scene-machine && cd scene-machine/skills
    ./install.sh --target <claude|antigravity|codex|gemini|cursor|windsurf|copilot|agents|all> [--project-dir <repo>] [--link] [--force] [--dry-run]

- `install.sh` copies `scene-machine/` into the skill directory of each tool
  (copies, not symlinks: symlinks break the Copilot coding agent and Windows
  and change silently under `git pull`). It never downloads anything.
- Without `--project-dir` the global (home) directories from the matrix are
  used; with `--project-dir <repo>` only the project-level directories are
  written and global installs are skipped (a note says so). Antigravity gets
  both `.agent/skills/` and `.agents/skills/` at project level.
- `--all` installs every target; identical destinations (for example
  `~/.agents/skills/` shared by `codex` and `agents`) are written once.
- Re-running is safe: an identical existing copy prints `unchanged`, a
  destination that differs is refused (exit 1) until you pass `--force`, which
  replaces it. `--link` creates a symlink instead (local development only);
  `--dry-run` prints one `[dry-run] copy <src> -> <dest>` line per destination
  and changes nothing; `--home DIR` replaces `$HOME` (used by the tests).
  `make install TOOL=claude` is a shortcut for `./install.sh --target claude`.
- Codex honours `CODEX_HOME`: the global copy goes to `$CODEX_HOME/skills/`
  when the variable is set.

### b) `npx skills` (third-party CLI)

    npx skills@<pinned-version> add google-marketing-solutions/scene-machine --skill scene-machine

Pin the version (the CLI is a third-party npm package that changes
independently of this repository). This method resolves `skills/scene-machine`
from the default branch, so it only works once the skill is merged there.

### c) Gemini Enterprise (Path A)

    make zip

Upload `dist/scene-machine.zip` through the Skills page of the Gemini
Enterprise web app (Skills -> Upload skill -> Import). The archive has
`SKILL.md` at its root, the form every documented upload parser accepts; a
single top-level folder named `scene-machine` is also documented as accepted
but is not what `make zip` produces. Video generation must be enabled for the
tenant.

### d) Gemini CLI link

    gemini skills link $(pwd)/scene-machine

Registers the checkout directly with the Gemini CLI (similar in effect to `./install.sh --target gemini --link`).

## Usage

### Path C flow (what the agent does, and what you can run by hand)

    # 1. Probe the environment: JSON report, no network, nothing billed.
    python3 scene-machine/scripts/env_probe.py

    # 2. Write the storyboard. Schema and rules: scene-machine/references/youtube_abcd_and_schema.md;
    #    examples: scene-machine/assets/examples/storyboard_5x6.json and storyboard_3x6.json.
    #    Shots: 2 to 6, durationSeconds 4, 6 or 8, aspectRatio 16:9 or 9:16 (square output via
    #    exportSquareCrop: true on 9:16), voiceover 50-65 words, English musicPrompt, language as BCP-47.

    # 3. Dry-run (default): validation, prerequisites, project and source, plan table, one JSON line.
    python3 scene-machine/scripts/generate_ad_spot_vertex.py --storyboard storyboard.json

    # 4. Execute (paid): only with an explicit project, and only when a video was asked for.
    python3 scene-machine/scripts/generate_ad_spot_vertex.py --storyboard storyboard.json \
        --execute --project <project-id>

    # 5. Verify: the assembler prints its summary JSON ("status": "ok", video_stream_duration_seconds,
    #    integrated_lufs, ...) and the generator then prints its own final line ("rendered": true,
    #    calls_made, output_dir). The video exists only when both are present and
    #    video_stream_duration_seconds matches expected_duration_seconds within 0.05 s.

Abbreviated dry-run output for the 5-scene example:

    scene-machine generator 2.1.0: dry run (no API call, nothing billed)
    prerequisites:
      ffmpeg: "ffmpeg version 9.0.2-1 ..."
      ffprobe: "ffprobe version 9.0.2-1 ..."
      pillow: true
      google_genai_importable: true
      adc_file_present: true
      gcloud_default_project_hint: "<your-default-project or empty>"
    project: - (source: none)
    plan (one row per call kind):
    kind | model | location | count | unit_cost_note
    image | gemini-3.1-flash-image | global | 5 | per image
    video | veo-3.1-fast-generate-001 | us-central1 | 5 | per second of video; audio off by default
    tts | gemini-2.5-flash-tts | global | 1 | per text token and second of output audio
    music | lyria-002 | global | 1 | per generated clip
    planned_calls: 12
    {"status": "dry_run", "rendered": false, "planned_calls": 12, "project": "", "project_source": "none", "prerequisites": {...}, "validation": {"schema": "ok", "voiceover_words": 57, "language": "en-US", "music_prompt_ascii": true, "durations": [6, 6, 6, 6, 6]}, "plan": [...]}

The same command works without Pillow or google-genai installed (the
prerequisite block then reports `false` for them). After `--execute` the
generator runs the assembler automatically and propagates its exit code (a
failing assembler adds an `assembler_failed` line on stderr). Its own final
stdout line is
`{"status": "ok", "rendered": true, "project": "...", "project_source": "flag|env", "calls_made": {"image": 5, "video": 5, "tts": 1, "music": 1}, "output_dir": "...", "resolved_storyboard": "..."}`;
with `--skip-assemble` it stops after the media calls and prints the same line
with `"rendered": false`.

### Generator flags (`scene-machine/scripts/generate_ad_spot_vertex.py`)

| Flag | Default | Meaning |
| :--- | :--- | :--- |
| `--storyboard PATH` | required (except with `--list-models`) | storyboard JSON |
| `--dry-run` | on | validate, print the plan, import no SDK, make no call |
| `--execute` | off | perform the paid calls; needs an explicit project |
| `--project ID` | `GOOGLE_CLOUD_PROJECT` | project to bill; the gcloud default is shown as a hint only |
| `--location LOC` | per-model default (`global` image/TTS, `us-central1` Veo) | Vertex AI location override for image and video models (and TTS when supported) |
| `--music-location LOC` | `global` | Lyria endpoint location (`global` or a region such as `us-central1`) |
| `--image-model ID` | `gemini-3.1-flash-image` | registry id with status `active` or `preview` |
| `--video-model ID` | `veo-3.1-fast-generate-001` | same |
| `--tts-model ID` | `gemini-2.5-flash-tts` | same |
| `--music-model ID` | `lyria-002` | same |
| `--voice NAME` | `Kore` | prebuilt Gemini TTS voice |
| `--veo-audio` | off | let Veo generate native audio (with-audio rate) |
| `--veo-resolution RES` | unset | Veo resolution passthrough, for example `720p` or `1080p` |
| `--max-workers N` | 3 | parallel shots and assets |
| `--poll-interval S` | 10 | seconds between Veo operation polls |
| `--poll-timeout S` | 900 | per-clip deadline; exceeding it fails that shot |
| `--list-models` | | print the registry table and exit |
| `--no-strict-copy` | off | downgrade the 50-65-word voiceover check to a warning |
| `--output-dir DIR` | `${SCENE_MACHINE_WORKDIR:-./.scene_machine}/output` | output root; generated assets go to `<output-dir>/work/` |
| `--skip-assemble` | off | generate assets only; do not run the assembler |
| `--version` | | print the script version |

### Assembler flags (`scene-machine/scripts/assemble_ad_video.py`)

    python3 scene-machine/scripts/assemble_ad_video.py render --storyboard <resolved storyboard.json> \
        [--output-dir DIR] [--allow-no-overlays] [--no-overlays] [--mirror-dir PATH]
    python3 scene-machine/scripts/assemble_ad_video.py normalize-image --input IN --output OUT \
        [--aspect-ratio 16:9|9:16] [--bg-hex "#RRGGBB"]

| Flag | Meaning |
| :--- | :--- |
| `render --storyboard PATH` | storyboard whose shots carry `clipFile` paths (the generator writes `work/storyboard_resolved.json`) |
| `render --output-dir DIR` | default `${SCENE_MACHINE_WORKDIR:-./.scene_machine}/output` |
| `render --allow-no-overlays` | render without Pillow (no lower-thirds, no endcard); otherwise a missing Pillow is exit 4 |
| `render --no-overlays` | skip the overlays even when Pillow is available (implies `--allow-no-overlays`) |
| `render --mirror-dir PATH` | copy every deliverable to PATH as well (also read from `SCENE_MACHINE_MIRROR_DIR`); replaces the former implicit copy |
| `normalize-image --input/--output` | letterbox or pillarbox an image to 1280x720 or 720x1280 |
| `normalize-image --aspect-ratio` | `16:9` (default) or `9:16` |
| `normalize-image --bg-hex` | padding colour as `#RRGGBB` |

The render summary is one JSON line on stdout with `status`, `primary_video`,
`expected_duration_seconds`, `video_stream_duration_seconds`,
`audio_stream_duration_seconds`, `video_frames`, `resolution`,
`integrated_lufs`, `true_peak_dbtp`, `overlays_rendered`, `output_files`,
`storyboard_json`, `storyboard_md` and `mirrored_to`. Warnings (for example
`short_clip` when a clip is shorter than its slot and is padded by cloning the
last frame) are one-line JSON objects on stderr.

### Exit codes (both scripts)

| Exit | Meaning | JSON `error` value on stderr |
| :--- | :--- | :--- |
| 0 | success, or dry-run (`"rendered": false`, no `primary_video`) | - |
| 2 | usage error, missing explicit project with `--execute`, unknown or retired model | argparse text or `usage` |
| 3 | missing input file (storyboard, clip, keyframe) | `missing_input` |
| 4 | tool or dependency missing or failed (ffmpeg, ffprobe, Pillow, google-genai, model registry, I/O error) | `dependency_missing` / `ffmpeg_failed` / `io_failed` |
| 5 | schema or validation failure (`durationSeconds` not 4/6/8, aspect 1:1, non-English music prompt, voiceover length in strict mode) | `invalid_storyboard` |
| 6 | output verification failed (video stream duration off by more than 0.05 s) | `verification_failed` |
| 7 | partial media generation failure (refusal, poll timeout, API error); resumable | `partial_failure` |

Exit 1 is reserved for unexpected internal errors (`internal` from the
generator, `internal_error` from the assembler); the generator returns 130 when
interrupted. Error objects have the shape
`{"error": "<code>", "message": "<one line>", "shotIndex": <optional>, "hint": "<optional>"}`
and never contain request headers or tokens. `SCENE_MACHINE_DEBUG=1` adds
tracebacks.

### Environment variables

| Variable | Used by | Meaning |
| :--- | :--- | :--- |
| `SCENE_MACHINE_WORKDIR` | SKILL.md, both scripts | work and output root (default `./.scene_machine`) |
| `SCENE_MACHINE_MIRROR_DIR` | assembler | opt-in copy of the deliverables to a fixed folder |
| `GOOGLE_CLOUD_PROJECT` | generator | project for `--execute` when `--project` is absent |
| `GOOGLE_APPLICATION_CREDENTIALS` | generator, `env_probe.py` | ADC key file; its presence is reported by the dry-run |
| `SCENE_MACHINE_DEBUG` | both scripts | `1` prints tracebacks |

When the skill works inside a repository, keep the work directory out of
version control and out of editor indexes:

    # .gitignore
    .scene_machine/

### Outputs

Under `<output-dir>` (default `./.scene_machine/output`):

- `final_video_16x9.mp4` or `final_video_9x16.mp4`, depending on `aspectRatio`
  (1280x720 or 720x1280, 24 fps, AAC audio at -14 LUFS integrated).
- `final_video_1x1.mp4` (720x720) only when the storyboard sets
  `exportSquareCrop: true` on a 9:16 render; it is a centre crop of that
  render, not a native square generation (Veo 3.1 renders 16:9 and 9:16 only).
- `storyboard.json` and `storyboard.md` (the resolved storyboard and a readable
  shot list).
- `work/`: keyframes, clips, voiceover, music and the checkpoint
  `work/storyboard_resolved.json`.

### Resuming after a partial failure

When one or more shots fail (model refusal, poll timeout, API error) the other
shots finish, the checkpoint is written, the generator prints a
`partial_failure` error line on stderr and
`{"status": "partial", "rendered": false, "failed_shots": [...], "calls_made": {...}, "resolved_storyboard": "..."}`
on stdout, and exits 7. Re-run with the same flags and the checkpoint as the
storyboard; finished assets are reused and no call is repeated for them:

    python3 scene-machine/scripts/generate_ad_spot_vertex.py \
        --storyboard <output-dir>/work/storyboard_resolved.json --execute --project <project-id>

## Verification

Local gates (identical to the CI jobs in `ci/skill-ci.yml`), run from this
directory with `requirements-dev.txt` installed:

    make lint test bench zip

- `make lint`: ruff plus the skill conformance lint (frontmatter, size, ASCII,
  no internal references, no caches, dry-run flag, zip layout, README checks,
  registry freshness).
- `make test`: hermetic pytest suite (fake google-genai with documented
  response shapes, FFmpeg lavfi fixtures, SDK surface test, runtime-detection
  fixtures, `install.sh` tests). No network, no credentials.
- `make bench`: render timing, loudness and duration gates, compared against
  `benchmarks/results/baseline_v2.0.0.json`; the v2.0.0 vs v2.1.0 numbers are
  in `benchmarks/results/COMPARISON.md`.
- `make zip`: builds `dist/scene-machine.zip` with `SKILL.md` at the root.

Other targets: `make format` (ruff format check), `make compile` (byte-compile
the scripts, then remove `__pycache__`), `make clean` and
`make install TOOL=<name>`. The Makefile sets `PYTHONDONTWRITEBYTECODE=1` so
that no caches enter the tree; `PYTHON` and `BASETEMP` are overridable.

Measured for v2.1.0 on 2026-11-23 (ffmpeg 9.0.2, Python 3.13, synthetic lavfi
media; full tables and the v2.0.0 comparison in
`benchmarks/results/COMPARISON.md`):

| Gate | Result |
| :--- | :--- |
| `make lint` | 23 rules, 0 FAIL, 0 WARN (v2.0.0 package: 2 FAIL) |
| `make test` | 260 passed, 1 skipped (opt-in determinism marker), 0 failed |
| `make bench` | exit 0 in 40 s, all gates met |
| `make zip` | 14 entries, `SKILL.md` at the archive root |

| Render case | Wall time | Video stream | Integrated loudness | True peak |
| :--- | :--- | :--- | :--- | :--- |
| 5 x 6 s, 16:9, voiceover + music | 10.59 s | 30.000 s, 720 frames | -13.8 LUFS | -7.9 dBTP |
| 3 x 6 s, 16:9 | 7.39 s | 18.000 s, 432 frames | -14.1 LUFS | -8.6 dBTP |
| 5 x 6 s, 9:16 primary plus 1:1 crop | 11.66 s | 30.000 s, 720 frames (both files) | -13.8 LUFS | -7.9 dBTP |

Gates: video stream duration within 0.05 s of the storyboard total, -14 +/- 1.0
LUFS, true peak at or below -1.0 dBTP, wall time below 60 s and at most 2x the
v2.0.0 baseline. Failure modes now end with structured exit codes instead of
tracebacks: aspect ratio 1:1 or 4:3, a single shot and malformed JSON -> 5
`invalid_storyboard`; a missing clip -> 3 `missing_input` in 0.09 s (v2.0.0:
exit 1 after 2.95 s of encoding); ffmpeg absent -> 4 `dependency_missing`;
no Pillow -> 4 `dependency_missing` (v2.0.0: exit 0 with the endcard silently
missing); a 1 s clip in a 6 s slot renders 30.000 s / 720 frames (v2.0.0:
29.0 s while the summary reported 30.0).

Detection smoke prompt, identical for every tool, after installing the skill:

> Using the scene-machine skill, tell me which execution path you would take here and run only the environment probe; do not generate any media.

Expected answer: the agent loads the skill, runs
`python3 <SKILL_DIR>/scripts/env_probe.py` (or the generator dry-run), reports
Path C with the detected capabilities (ffmpeg, Pillow, google-genai, ADC) or
"plan only" where there is no network or no credentials, and makes no paid
call. Record the tool version and the shell tool name it used in
`benchmarks/runtime_fixtures/`.

## Known limitations and what was not tested here

Everything in this package was verified without a Google Cloud project: the
tests use a fake SDK with the documented response shapes, and the model ids,
regions and lifecycle dates come from the public documentation as of
2026-11-20. The following items need a live run by the owner. Recipe: a sandbox
project with a hard budget cap, the 3-scene example
(`scene-machine/assets/examples/storyboard_3x6.json`), first the dry-run with
`--project <id>`, then `--execute --max-workers 1`, then inspect
`<output-dir>/work/` with `ffprobe`.

| Check | Manual plan |
| :--- | :--- |
| Live `gemini-3.1-flash-image`: availability in `global` vs `us-central1`, output mime type and size, Veo accepting it as image-to-video input | the recipe above; inspect `work/shot_1.*` |
| Lyria 2: `global` vs `us-central1`, response field names, English-only prompt rule | same run; try `--music-location us-central1` once |
| `gemini-2.5-flash-tts` with voice `Kore` at `global`; `language_code` honoured for a German storyboard | same run with a `de-DE` storyboard |
| Veo 3.1 clip precision (exactly 6.000 s, constant 24 fps), no audio stream vs silent stream with audio off, refusal and filtered-media response shapes | same run; `ffprobe` each clip |
| Quota (429) behaviour and retry tuning | one run with `--max-workers 5` |
| ADC quota project (`gcloud auth application-default set-quota-project`) | first-run check |
| Actual per-run cost | billing export after the run; this README stays in call units |
| Per-tool shell tool names (unverified against an official document): Antigravity `run_command`, the Codex `exec_command` alias in newer builds, Cursor `run_terminal_cmd`, GitHub Copilot (VS Code, CLI, coding agent) `run_in_terminal`, Kiro `executeBash`, Continue `runTerminalCommand`, Amp `Bash`; file tools Antigravity `write_to_file` / `replace_file_content` and Kiro `fsWrite` | run the detection smoke prompt in each tool; record the product version and the tool name in `benchmarks/runtime_fixtures/*.json` and `scene-machine/references/runtimes.md` |
| Antigravity: discovery from the global directories (`~/.gemini/antigravity/skills/`, `~/.agents/skills/`) in current builds; the managed Gemini API Antigravity agent sandbox (tool list, Python version, network policy, skill directory) | install into the workspace `.agent/skills/` and run the smoke prompt; then try the global copy |
| Codex cloud: network policy, whether ffmpeg is in the default image, `.agents/skills/` discovery from a committed repository | cloud task with the smoke prompt (expected: plan only) |
| GitHub Copilot coding agent: default egress allow-list, ffmpeg on the runner image, credentials through `copilot-setup-steps` | repository test with the smoke prompt |
| Cline (`.clinerules/skills/` vs `.cline/skills/`), Roo Code (`.roo/skills/`), Kiro (`.kiro/skills/`) directories and tool names; Amp (`.agents/skills/`, `Bash`); Continue (rule-based loading); Zed (agent-panel skills, tool names of the connected agent); Jules (`AGENTS.md` pointer, setup script, secrets, no documented skill discovery) | smoke prompt per tool |
| Gemini Enterprise: upload, acceptance of extra frontmatter keys (`compatibility`), folder-wrapped zip, whether uploaded `scripts/` are executed, the `videogen_agent` and `gen_video` agent names, aspect ratio honoured inside the prompt, behaviour when video generation is disabled for the tenant | tenant test with `make zip` |
| `npx skills add` resolving `skills/scene-machine` (needs the merged default branch); `gemini skills link` with the checkout | after the merge |
| macOS font rendering; Windows behaviour | manual render on each platform |
| LLM-judge rubric in `benchmarks/evals/` | needs an API key; advisory only, not run in CI |
| Registry lifecycle statements | re-verify `last_verified` before each release |

Known limitations by design:

- 1:1 output is a centre crop of the 9:16 render (`exportSquareCrop`), not a
  native square generation.
- The music prompt must be English (`lyria-002` accepts en-US prompts only);
  the voiceover language follows `language`.
- `--execute` from an agent sandbox without network or credentials cannot work;
  the defined result is the storyboard plus the dry-run plan.
- Loudness and duration gates were calibrated on ffmpeg 9.0.2; CI runs 4.4 and
  6.1 as well, but other builds may differ slightly.

<!-- TODO(owner): add the frontmatter 'compatibility' field after a Gemini Enterprise upload test confirms extra keys are accepted. -->

## Contributing and license

Contributions follow the repository-level [CONTRIBUTING.md](../CONTRIBUTING.md)
(including the CLA) and the package-specific notes in
[CONTRIBUTING.md](CONTRIBUTING.md) in this directory. Run `make lint test`
before opening a pull request. Re-verify the model registry before each release
and update `last_verified`; never ship a retired model as a default.

Licensed under the Apache License, Version 2.0; see the repository
[LICENSE](../LICENSE). Every script and the installer carry the license header.
