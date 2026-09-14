---
name: document-user-facing-change
description: Documents a verified user-facing or administrator-facing Scene Machine change in the correct canonical files. Use when a feature changes UI behavior, setup, permissions, costs, operator workflow, or public capability wording.
---

# Document a user-facing change

Use this skill for a feature that changes what a user or administrator sees,
does, configures, or pays for. Start with the repository map in
[documentation.md](../../documentation.md).

## Workflow

1. Identify the affected audience: end user, administrator, deployer, or
   developer. Separate their instructions.
2. Collect the explicit base/target commits and dirty diff, target build URL
   or artifact, and matching-version evidence; record an explicit evidence gap
   when any input is unavailable.
3. Inspect the target implementation and tests. Record the exact behavior,
   model/catalog names, permissions, cost surface, and known limits. Do not
   infer a release or claim a private feature is shipped.
4. Choose the smallest canonical edit: README capability/teaser,
   `docs/walkthrough.md` step, `CHANGELOG.md` `## Unreleased` entry, or a feature
   document. If none is needed, record that decision in the handover.
5. If visuals are needed, reuse a truthful existing GIF or capture one or two
   real states from the target build. Keep viewport/theme consistent and write
   meaningful alt text and captions. Never fabricate UI or expose private data.
6. Write `Benefit`, 3–5 UI actions, `Expected result`, one important
   `Caveat`, and one or two screenshots only when useful. Resolve media paths
   relative to the Markdown file containing each link: use `media/` inside
   `docs/*.md`, and `docs/media/` from root-level Markdown. Verify
   links/anchors, rendered Markdown, and adjacent outdated text.
7. State what was verified and what was not tested. Keep wording literal:
   experimental, unreleased, and shipped are different states.

## Prompt

“Document this change from base `<base>` through target `<target>`. Check the
dirty diff and matching-version build evidence (or state the gap), then make
the smallest canonical edits with Benefit, 3–5 actions, Expected result,
Caveat, and useful real screenshots. Verify links/rendered Markdown and report
any documentation decision or missing evidence.”
