# Documentation workflow

This is the source-of-truth map for user-facing and release documentation.
Keep public prose evergreen, evidence-based, and useful to a person operating
the current application.

## Canonical locations

- `README.md` explains the product, capabilities, deployment, requirements,
  caveats, and a short latest-shipped teaser. Keep capability descriptions
  evergreen; do not turn the README into a release diary.
- `CHANGELOG.md` is the canonical human-readable history of shipped changes.
  This repository may not have the file yet. Create it with only `## Unreleased`
  when the first user-facing change needs a note; do not invent a shipped
  entry, date, tag, or version. Promote it to a dated release only after the
  release state is verified. Do not publish links to a file that does not
  exist.
- `docs/walkthrough.md` is the existing nine-step user journey. Update the
  relevant step in place when behavior or UI changes. Preserve the sequence;
  do not append a new chronological step for every feature.
- `docs/media/` holds real screenshots/GIFs used by the walkthrough. Reuse an
  existing GIF when it accurately demonstrates the behavior; otherwise capture
  a real UI state with a neutral, non-sensitive fixture.
- Feature-specific documents such as `docs/homepage-announcement.md` explain
  a bounded contract and administrator workflow. They do not replace the
  README, walkthrough, or changelog.

## Feature documentation checklist

Before calling a user-facing change documented, decide explicitly whether it
needs a documentation change. Record either the changed canonical document or
why no public wording is needed.

Collect these inputs before editing: the explicit base and target commits (and
any dirty diff), the target build URL or artifact, matching-version evidence
for the UI being described, and an explicit gap if that evidence is missing.

For a change that needs docs:

1. Describe the user or administrator benefit, not the commit structure.
2. Split user actions from administrator/deployment actions.
3. Name exact model/catalog/config terms only when verified in the target
   source or deployment; do not infer a version from `0.0.0` or a package
   placeholder.
4. Use real UI evidence from the target build: one or two meaningful states,
   matching viewport and theme, with concise captions and useful alt text.
5. Keep screenshots free of personal data, credentials, project IDs, and
   provider secrets. Never fabricate screenshots or generated UI.
6. State permissions, cost/billing exposure, and important untested limits.
7. Mark work as experimental, unreleased, or shipped literally. Do not imply
   private or unmerged work is part of the public product.

Use this compact output shape:

```text
Benefit: [human outcome]
Actions: 1) [action] 2) [action] 3) [action]
Expected result: [what the user sees]
Caveat: [permission, cost, compatibility, or untested limit]
Evidence: [one or two real screenshots, if useful]
```

For visuals, paths are relative to the Markdown file containing the link. Use
stable descriptive names and replace illustrative placeholders with a real
captured asset before publishing. For example, inside `docs/walkthrough.md`:

```md
![Announcement banner above the project list](media/homepage-announcement-banner.png)
_Homepage, 1440px wide, light theme; the dismiss control remains visible._
```

The filename above is illustrative only; do not publish it until that captured
asset exists under `docs/media/`. From a root-level Markdown file such as
`README.md`, the equivalent path would begin `docs/media/`.

Verify links and anchors, render the changed Markdown, and scan adjacent text
for outdated instructions before reporting the documentation complete.

## Release documentation checklist

Prepare a release from an explicit merged release base and target commit. If
there is no previous release tag, the maintainer supplies the comparison base;
never infer one from a package `0.0.0` or branch name. Use the included diff to
identify user-visible changes; do not rely on package versions. An unreleased
draft may add `## Unreleased` only. Promote it to a dated version only when the
approved release state is verified. Keep release notes focused on human
benefits, compatibility, permissions, costs, and known limits rather than a
commit dump.

Illustrative changelog draft (not a claim about this repository's release):

```md
## Unreleased

- Added a dismissible homepage announcement so operators can share a short
  update without interrupting project work.
```

The GitHub Release, if requested, repeats the same canonical changelog entry.
Documentation work must not silently push, tag, publish a release, request
reviews, or write announcement/banner data. Those are separate explicitly
authorized actions.

See [document-user-facing-change](skills/document-user-facing-change/SKILL.md)
and [prepare-user-release](skills/prepare-user-release/SKILL.md) for compact
execution checklists.
