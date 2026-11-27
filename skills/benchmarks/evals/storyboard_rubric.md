# Storyboard quality rubric (LLM-judged, advisory)

Scope: cases `storyboard_decomposition` and `german_brief` under `cases/`.
The deterministic pre-checks in `benchmarks/storyboard_checks.py` (schema,
50-65-word voiceover, 4/6/8 s durations, three-clause motion prompts, no copy
or URLs in `visualPrompt`, ASCII music prompt, no emoji) carry pass/fail. The
judge scores only the subjective dimensions below, 0-2 each. A case passes
when every deterministic check passes and the judge mean is >= 1.5. The judge
is not part of CI (no API key in this project); run it manually when needed.

| Dimension | 0 | 1 | 2 |
| :--- | :--- | :--- | :--- |
| abcd_coverage_and_order | stages missing or shuffled | all stages present, order or roles blurred | Attract, Brand, Connect, Proof, Direct in order with the bookend echo in the last shot |
| timing_5x6_or_3x6 | durations not 4/6/8 s or total wrong | legal durations, total not 30.0 / 18.0 s | 5 x 6 s = 30.0 s or 3 x 6 s = 18.0 s exactly |
| voiceover_50_65_words | outside 50-65 words | inside the range but segments do not match the shots | inside the range and per-shot segments concatenate to the script |
| language_matching | copy language differs from the brief | copy matches, camera/lighting text mixed | voiceover/headlines in the brief's language, camera/lighting text in English, `language` BCP-47 with region |
| no_copy_in_visual_prompts | slogans, URLs or CTA text inside `visualPrompt` | only brand name mentioned | clean frames, clean-frame sentence appended, copy only in overlays |
| overlays_carry_copy | no `typoOverlay`/`endcardSpec` copy | partial (no CTA or URL) | headline/subtext per shot where useful, endcard with headline, CTA text and URL |
| motion_prompt_three_clauses | fewer than three clauses | three clauses, generic content | `[VISUAL ANCHOR LOCK]`, one disciplined `[CAMERA TRAJECTORY]`, plausible `[LIGHTING & MICRO-PHYSICS]` per shot |
| palette_threaded | palette ignored | palette only in `brandPalette` | hex codes or their colour names appear in lighting/props of most visual prompts |
| no_emojis | emoji present | - | none anywhere |

Judge prompt (paste the storyboard JSON after it):

```text
You are grading a storyboard.json produced by an agent for a YouTube ABCD ad.
Score each dimension of the rubric table from 0 to 2 using the anchors given.
Return JSON: {"scores": {"<dimension>": <0|1|2>, ...}, "mean": <float>, "notes": "<one paragraph>"}.
Do not reward length. Penalise any slogan, URL or CTA text inside visualPrompt.
```
