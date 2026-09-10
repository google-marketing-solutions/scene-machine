---
name: test-ui-change
description: Runs a bounded, evidence-based browser smoke check for a Scene Machine UI change. Use when reviewing or validating Angular UI changes, responsive layouts, dialogs, focus, loading/error states, or user flows.
---

# Test UI change

Use the canonical [contributor UI testing guide](../../testing.md). Do not
copy its viewport matrix into this skill.

## Invocation

1. Read the guide and the changed UI flow.
2. Run the existing automated checks relevant to the change, using the
   non-watch command (`cd ui && npm test -- --watch=false`); use the complete
   setup/build recipe in the guide when a clean checkout is needed.
3. Start the documented local loop only when a browser check needs `/api`.
4. In an isolated browser session, verify 100% zoom and check the guide's
   baseline viewports proportionate to the changed layout.
5. Exercise real clicks, keyboard focus, typing, scrolling, dialogs, and the
   relevant empty/loading/success/error or race states.
6. Do not trigger paid provider generation by default. Use controlled data or
   existing automated mocks; mark unavailable live checks `NOT TESTED`.
7. Report the guide's evidence template and sanitize identifiers, assets, and
   signed URLs.

## Example prompt

“Validate this Angular dialog change using `docs/testing.md`. Run the relevant
automated checks with `npm test -- --watch=false`, then use Chrome Responsive
mode at the smallest relevant baseline viewport. Open the dialog, paste long
text, scroll down and back, verify keyboard focus, type a correction, click
Cancel, reopen to confirm it was not saved, and navigate back. Do not click any
generation control. Report passed, failed, and `NOT TESTED` states with the
exact commit, dirty-diff status, viewport, and sanitized evidence.”
