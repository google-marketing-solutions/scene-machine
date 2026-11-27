# Runtime detection and per-environment notes

This reference backs Step 1 of SKILL.md. The skill never recognises an
environment by its product name; it classifies the tools it was given
(section 1) and then uses the notes below for install locations, tool aliases
and sandbox limits. Facts marked "(unverified: ...)" were not confirmed against
an official document at the time of writing (2026-11-20); re-check them in the
vendor's documentation when something does not behave as described.

## 1. Detection rules (normative)

The block below is reproduced verbatim from the project plan. The benchmark
`detect_runtime.py` implements the same text and the test suite checks that
this file lists every alias, so SKILL.md, this reference and the code cannot
drift apart.

```text
media_tools  := any tool of kind image_gen AND video_gen (built-in generation that writes files)
shell        := any tool of kind shell (aliases: Bash, run_shell_command, shell, exec_command,
                run_terminal_cmd, run_command, execute_command, run_in_terminal, execute_bash,
                executeBash, runTerminalCommand, code_execution)
agent_xfer   := any tool of kind agent_transfer (transfer_to_agent) or a video agent (videogen_agent, gen_video)

if agent_xfer and not shell: path A
elif shell and media_tools:  path B
elif shell:                  path C   (dry-run first; needs ffmpeg, Pillow, google-genai, ADC for --execute)
else:                        NONE     (explain and output storyboard + prompts only)
```

Reading the rules:

- A tool counts as `shell` when its kind is shell or its name is one of the
  aliases, whatever the vendor calls the command parameter. A tool that only
  edits files (`Write`, `apply_patch`, `write_to_file`) is not a shell.
- `media_tools` needs both an image generator and a video generator that
  write files the shell can read afterwards. No agent product listed below
  documents such tools today, so Path B is reserved for custom VM agents.
- `code_execution` is a shell alias. Sandboxes that offer only it usually have
  no credentials, so they end in the plan-only state of section 5.
- The Gemini Enterprise skill runtime tools (`list_skills`, `load_skill`,
  `run_skill_script`) are not shell aliases: with `transfer_to_agent` present
  and no shell, Path A applies.
- `agent_xfer` fires on the transfer tool or on a video agent name
  (`videogen_agent`, `gen_video`) even when the tool kind is reported as
  "other".

## 2. Tool aliases by kind

| Kind | Role in the rules | Names seen per environment |
| :--- | :--- | :--- |
| shell | `shell` | Claude Code: `Bash`; Gemini CLI: `run_shell_command`; Codex CLI, IDE and cloud: `shell` (newer builds also expose `exec_command`; unverified); Cursor: `run_terminal_cmd` (unverified); Antigravity IDE and CLI: `run_command` (unverified: name comes from the shared harness, not from a public document); Windsurf: `run_command`; Cline and Roo Code: `execute_command`; GitHub Copilot in VS Code, the Copilot CLI and the coding agent: `run_in_terminal` (unverified); OpenHands: `execute_bash`; Kiro: `executeBash` (unverified); Continue: `runTerminalCommand` (unverified); Amp: `Bash` (unverified); Gemini API managed agent: `code_execution` |
| file_write | not used by the rules; used to write `storyboard.json` | Claude Code: `Write`, `Edit`; Gemini CLI: `write_file`, `replace`; Codex: `apply_patch`; Antigravity IDE and Windsurf: `write_to_file`, `replace_file_content` (Antigravity names unverified); Cline: `write_to_file`, `replace_in_file`; Roo Code: `write_to_file`, `apply_diff`; Kiro: `fsWrite` (unverified); OpenHands: `str_replace_editor`; Copilot: `create_file`, `replace_string_in_file`; Cursor: `edit_file`; elsewhere the editor's own tool |
| agent_transfer | `agent_xfer` | Gemini Enterprise web chat: `transfer_to_agent` with the agent name `videogen_agent`; a single-clip `gen_video` tool counts as well. Both agent names were observed live and are unverified in public documentation |
| image_gen, video_gen | `media_tools` (both kinds required) | none documented for any product listed here; a custom VM agent may expose them under any name, the kind matters, not the name |

## 3. Environment notes

Discovery directories are listed as "project ; global". `<SKILL_DIR>` is the
installed copy of `scene-machine/` inside one of them; `scripts/env_probe.py`
prints it as `skill_dir`. The repository's `install.sh --target <tool>`
writes exactly these locations (copy by default; `--link` for development).

| Environment | Discovery: project ; global | Shell tool | Path | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Claude Code (CLI and IDE extensions) | `.claude/skills/scene-machine/` ; `~/.claude/skills/scene-machine/` (plugins: `<plugin>/skills/scene-machine/`) | `Bash` | C | Honours `name`, `description`, `license` and `metadata`; `name` must equal the directory name. Pillow is often missing on a fresh machine: run the probe first. |
| Google Antigravity (IDE agent manager and CLI) | `<project>/.agent/skills/scene-machine/` (primary) and `<project>/.agents/skills/scene-machine/` ; `~/.gemini/antigravity/skills/scene-machine/` (also `~/.agents/skills/`) | `run_command` (unverified) | C | No built-in media tools are callable by the agent, so Antigravity is never Path B. At the time of writing the global directories were not always picked up (unverified: open product issues), therefore install into the project `.agent/skills/` first. The IDE asks for permission before activating a skill. |
| Gemini API managed Antigravity agent (remote sandbox) | `<sandbox project>/.agent/skills/scene-machine/` (unverified) ; - | `code_execution` | C by the rules, plan-only in practice | Remote Ubuntu sandbox without ADC, Pillow or google-genai (unverified: tool list, Python version, network policy). |
| OpenAI Codex CLI and IDE extension | `$CWD/.agents/skills/` and parent directories, `$REPO_ROOT/.agents/skills/` ; `~/.agents/skills/` or `$CODEX_HOME/skills/`, `/etc/codex/skills/` | `shell` | C | The description budget is strict at discovery; the shipped description stays under 700 characters. |
| OpenAI Codex cloud | `.agents/skills/scene-machine/` committed in the repository ; - | `shell` | NONE (plan only) | Ephemeral container, network disabled by default, no ADC; pip and Vertex AI are unreachable unless the environment enables network and provides credentials (unverified: whether ffmpeg is in the default image). |
| Gemini CLI | `.gemini/skills/scene-machine/` ; `~/.gemini/skills/scene-machine/` or `gemini skills link <abs dir>` | `run_shell_command` (asks for confirmation) | C | Management: `gemini skills list`, `link`, `install`, `enable`, `disable`; `/skills reload` inside a session. |
| Cursor | `.cursor/skills/scene-machine/` ; `~/.cursor/skills/scene-machine/` (also reads `.agents/skills/`, `.claude/skills/`, `.codex/skills/`) | `run_terminal_cmd` (unverified) | C | `/create-skill` helper; rules live in `.cursor/rules/*.mdc`. |
| Windsurf (Cascade) | `.windsurf/skills/scene-machine/` ; `~/.codeium/windsurf/skills/scene-machine/` | `run_command` | C | Windsurf examples show extra frontmatter keys; the shipped skill does not need them. |
| GitHub Copilot (VS Code agent mode, Copilot CLI) | `.github/skills/scene-machine/` (committed content, not a symlink) ; `~/.copilot/skills/scene-machine/` (also `.claude/skills/`, `.agents/skills/`) | `run_in_terminal` (unverified) | C | `install.sh` copies instead of linking for this reason. |
| GitHub Copilot coding agent | `.github/skills/scene-machine/` ; - | `run_in_terminal` | NONE unless configured | Actions runner behind an egress firewall; credentials exist only when the repository provides them in `copilot-setup-steps`, then Path C applies (unverified: default allow-list, ffmpeg on the runner image). |
| Cline | `.clinerules/skills/scene-machine/` or `.cline/skills/scene-machine/` (unverified: which one depends on the version) ; - | `execute_command` | C | Tool names come from a search summary (unverified). |
| Roo Code | `.roo/skills/scene-machine/` ; `~/.roo/skills/scene-machine/` | `execute_command` | C | Directories and tool names come from a search summary (unverified). |
| Kiro (AWS) | `.kiro/skills/scene-machine/` ; `~/.kiro/skills/scene-machine/` | `executeBash` (unverified) | C | Skills must sit in their own subfolder; file tool `fsWrite` (unverified). |
| OpenHands | `.agents/skills/scene-machine/` or `.openhands/skills/scene-machine/` ; - | `execute_bash` | C | Runs in a container with one fixed project root; deliverables leave the work dir only with `--mirror-dir` or `SCENE_MACHINE_MIRROR_DIR`. Path B only if a deployment adds image and video tools. |
| Amp (Sourcegraph) | `.agents/skills/scene-machine/` (unverified) ; - | `Bash` (unverified) | C | Listed as supporting the standard by aggregators only. |
| Zed | managed through the agent panel or `/create-skill` (user or project scope) | depends on the connected agent | C | Tool names depend on the agent configured in Zed. |
| Continue | no skill discovery: add SKILL.md as a rule under `.continue/rules/` | `runTerminalCommand` (unverified) | C | The rule must state the absolute `<SKILL_DIR>`. |
| Jules | no documented skill discovery; reference the skill from `AGENTS.md` ; - | VM shell | NONE, or C with configured secrets | A setup script can install prerequisites; no ADC unless the user configures secrets (unverified). |
| Aider | `/read-only <path>/SKILL.md` or a `read:` entry in `.aider.conf.yml` | none (the human runs commands) | C, executed by the human | Aider edits files only: copy the commands from Section C of SKILL.md and run them yourself. |
| Gemini Enterprise web chat | zip upload with `SKILL.md` at the archive root (or one top-level folder named `scene-machine`) | none (`run_skill_script` is air-gapped) | A | `videogen_agent` renders one 8-second clip per turn and ends the turn; put the aspect ratio inside the prompt text (unverified: the agent names in public docs, acceptance of extra frontmatter keys by the upload parser, whether `scripts/` run for uploaded skills). |

## 4. Smoke test (no paid calls)

Prompt, identical for every tool:

> Using the scene-machine skill, tell me which execution path you would take
> here and run only the environment probe; do not generate any media.

A correct answer: the agent loads the skill, runs
`python3 <SKILL_DIR>/scripts/env_probe.py` with its shell tool (or the
generator dry-run), names the path letter together with the capabilities it
found (for example "Path C: shell tool Bash, no media tools, no agent
transfer"), quotes `ready_for_execute` and `next_step` from the probe output,
and makes no paid call. Without network or credentials the answer is "plan
only" (section 5). In Gemini Enterprise web chat the answer is Path A; the
probe cannot run there and the agent says so instead of pretending.

When you re-verify an entry marked unverified, record the product version and
the shell tool name the agent actually used.

## 5. Terminal state without network or credentials (plan only)

Applies to Codex cloud, the Copilot coding agent without configured secrets,
the managed Antigravity agent, Jules without secrets, and any sandbox whose
probe reports `ready_for_execute: false` because credentials or network are
missing.

1. Write `storyboard.json` under the work dir
   (`${SCENE_MACHINE_WORKDIR:-./.scene_machine}`); this needs no network.
2. Run the generator without `--execute`. The dry-run needs no SDK and no
   project; it validates the storyboard and prints the prerequisites block,
   the plan table and `planned_calls`.
3. Deliver both and state plainly: "No video was rendered in this environment
   because network access, credentials or dependencies are missing. Run the printed
   command with `--execute --project <id>` on a machine with ffmpeg, Pillow,
   google-genai and application default credentials to render it."
4. Never invent an output path, never report a duration you did not measure,
   and never run `--execute` with a project the user did not name or
   configure.

## Sources (public documentation, checked 2026-11-20)

- Agent Skills specification: https://agentskills.io/specification
- Claude Code: https://code.claude.com/docs/en/skills
- Antigravity: https://antigravity.google/docs/skills and
  https://codelabs.developers.google.com/getting-started-with-antigravity-skills
- Codex: https://developers.openai.com/codex/skills and
  https://developers.openai.com/codex/cloud
- Gemini CLI: https://geminicli.com/docs/cli/skills/
- Cursor: https://cursor.com/docs/context/skills
- Windsurf: https://docs.windsurf.com/windsurf/cascade/skills
- GitHub Copilot: https://docs.github.com/en/copilot/concepts/agents/agent-skills
  and https://docs.github.com/en/copilot/concepts/agents/coding-agent
- Cline: https://docs.cline.bot/ ; Roo Code: https://docs.roocode.com/ ;
  Kiro: https://kiro.dev/docs/ ; OpenHands: https://docs.all-hands.dev/
- Gemini API managed agent: https://ai.google.dev/gemini-api/docs
- Gemini Enterprise skills: https://docs.cloud.google.com/gemini-enterprise/docs/skills
- Zed: https://zed.dev/docs ; Continue: https://docs.continue.dev ;
  Aider: https://aider.chat/docs ; Amp: https://ampcode.com/manual ;
  Jules: https://jules.google/docs
