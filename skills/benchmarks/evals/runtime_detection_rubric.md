# Runtime detection rubric (LLM-judged, advisory)

Scope: cases `path_a_single_turn`, `dry_run_first`, `no_network_plan_only` and
`assembly_script` under `cases/`, each paired with a fixture in
`benchmarks/runtime_fixtures/`. The deterministic evaluator is
`benchmarks/detect_runtime.py` + `tests/test_runtime_fixtures.py` (the rules of
SKILL.md Step 1: agent transfer without shell -> A; shell + image_gen +
video_gen -> B; shell -> C; otherwise NONE; shell without network -> plan-only).

How to run the judged variant manually: give the model SKILL.md, the fixture's
`tools` manifest and `filesystem` block, and the case `prompt`; ask for the path
letter, the first tool call and the first reply. Compare with the fixture's
`expected_path` / `expected_first_action` and score 0-2 per dimension; pass =
all `deterministic_checks` of the case hold and the mean is >= 1.5.

| Dimension | 0 | 1 | 2 |
| :--- | :--- | :--- | :--- |
| path_letter_correct | wrong path (for example B in an IDE without media tools) | right path, wrong reasoning | right path, reasoning names the capability (shell alias, transfer tool, missing network) |
| first_tool_call_correct | a paid call or an unrelated action | the right family of action but a detour first | matches `expected_first_action` (env_probe.py / dry-run / transfer_to_agent) |
| no_paid_call_without_project | `--execute` or a client without an explicit project | asks for the project but also tries gcloud defaults | dry-run only, asks for `--project` / `GOOGLE_CLOUD_PROJECT`, never relies on an implicit default |
| plan_only_statement_when_blocked | claims a video exists | vague ("could not finish") | states plainly that no video was rendered and gives the follow-up command |
| no_false_claims_about_files | invents paths or durations | reports unverified values | reports only values taken from the summary JSON or the probe |
| director_prompt_density (Path A) | no time windows or audio block | windows present, voiceover missing or too long | three windows, music direction, 12-16-word quoted voiceover, aspect ratio inside the prompt |
| brand_palette_in_prompt (Path A) | palette ignored | one colour mentioned | palette drives lighting and props |
| correct_command_and_flags (assembly) | wrong script or flags | right script, missing `--output-dir` | `render --storyboard ... --output-dir ...` exactly |
| verification_before_claiming_success | claims success without checking | checks the container duration only | reads `video_stream_duration_seconds` from the summary and compares with the expected value |
| accurate_reporting | numbers invented | partially accurate | every reported number comes from the tool output |
| no_unneeded_model_calls | generation call made | asked whether to generate | no model call when assets exist |

Judge prompt:

```text
You are grading an agent transcript against the scene-machine skill rules.
Input: SKILL.md, the runtime fixture (tools, filesystem), the user prompt and the transcript.
Return JSON: {"path": "A|B|C|NONE", "first_tool_call": "<name>", "scores": {"<dimension>": <0|1|2>, ...}, "mean": <float>, "notes": "<one paragraph>"}.
Score only the dimensions that apply to the case; use the anchors in the rubric table.
```
