---
name: prepare-user-release
description: Prepares evidence-backed Scene Machine release documentation from an explicit merged base to a target commit. Use when drafting a changelog, README shipped teaser, walkthrough update, or matching GitHub Release notes.
---

# Prepare a user release

Use this skill only for release preparation; it does not publish anything. Read
[documentation.md](../../documentation.md) first.

## Workflow

1. Resolve an explicit merged release base and target commit supplied by the
   maintainer. If there is no prior tag, use that supplied base; never infer a
   comparison from `0.0.0`, a branch name, or a private PR. Inspect the dirty
   diff and tests; require matching-version build evidence or record the gap.
2. Classify each user-visible change as shipped, experimental, or unreleased.
   Record compatibility, migration, permissions, billing, and untested limits.
3. Create or update the canonical `CHANGELOG.md` when a user-facing note is
   needed. If it does not exist, `## Unreleased` alone is valid; do not invent
   a shipped entry, date, tag, or version. Promote it only after approved
   release state is verified.
4. Update the README only for evergreen capability text and a short latest-
   shipped teaser. Update the relevant existing walkthrough step in place;
   do not append a chronological feature diary.
5. Write release notes as user benefits and operator impact, not a commit dump.
   A GitHub Release, if separately authorized, must repeat the same changelog
   entry rather than inventing a second account of the release.
6. Verify links/anchors, rendered Markdown, exact names, screenshots, alt text,
   adjacent outdated text, and test claims. Report missing evidence instead of
   filling gaps with assumptions.

## Safety boundary

Do not automatically push, tag, create a GitHub Release, request reviews,
deploy, or write announcement/banner data. Those actions require separate
explicit authorization.

## Prompt

“Prepare a release draft from maintainer-supplied merged base `<base>` through
target `<target>`. Check the dirty diff and matching-version evidence, record
any gap, summarize human benefits and limits, update canonical docs only where
justified, and leave promotion/publishing untouched.”
