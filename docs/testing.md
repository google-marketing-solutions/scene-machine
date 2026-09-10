# Contributor UI testing

Use this guide for browser checks when changing the Angular UI. These checks
complement, rather than replace, the automated checks in the repository.

## Before you start

For a fresh checkout, run setup from the repository root. The order is
intentional: `dev-setup.sh` generates the ignored UI files before `npm ci`,
whose `prepare` hook runs `npm run compile`.

```bash
git clone https://github.com/google-marketing-solutions/scene-machine.git
cd scene-machine
# Replace REF_TO_TEST with the fetched branch or SHA under test.
git switch --detach REF_TO_TEST
git status --short
git rev-parse HEAD
node --version                 # Node 22.x
npm --version                  # packageManager: npm@10.9.3
command -v envsubst            # required by dev-setup.sh
./scripts/dev-setup.sh        # run before npm ci
cd ui
npm ci                         # install in this worktree; do not regenerate the lockfile
npm run compile
npm run lint
npm run typecheck:spec
npm test -- --watch=false
node remix-engine-status-viewer/callBackend.spec.js
npm run build -- --configuration production
```

If `envsubst` is missing, rerun setup after installing gettext; the script
prints the platform-specific hint (Homebrew on macOS, `apt-get install
gettext` on Debian/Ubuntu). Node 22 is required by the UI tests. Install
dependencies separately in each worktree; do not reuse a sibling
`node_modules` directory or run a lockfile-generating command.

The repository CI always runs the status-viewer check as
`node remix-engine-status-viewer/callBackend.spec.js` from `ui`. It is not a
substitute for the UI checks below. The production build uses the generated
local `none` configuration for validation; never deploy that build.

The existing local loop is documented in
[DEVELOPING.md](../DEVELOPING.md#local-development-and-faster-deploys).

Run the local backend and `npm run dev` as described there when a browser
check needs `/api`. The local path uses a real dev Google Cloud project. Do
not assume it is a free simulator, and do not click a generation control by
default. Prefer existing controlled projects, saved examples, harmless
sample scenes, or existing media. Provider-backed proof is an explicit,
separately reported check; if the required live API is unavailable, record
`NOT TESTED` rather than substituting an unverified claim.

Keep each check in an isolated browser session. Confirm the browser reports
100% zoom and the CSS viewport dimensions before testing.

For a harmless manual session, open a controlled dev project and use an
existing saved scene or the repository's small assets under
`docs/media/example_assets`. If you need a fresh project to exercise setup,
create it with those existing assets and stop before provider-backed
generation. Do not upload customer media or invent a fixture service.

Before opening the browser, record the exact commit and whether the worktree
has a dirty diff. Ensure the browser shows the matching application build,
not another agent's tab or an older local server. Use one isolated tab per
check; do not let two drivers or agents control the same session. If multiple
local servers are needed, give them unique ports.

`AUTH_MODE=none` and local `controlPlaneMode: 'none'` are for localhost only
and must never be exposed publicly. The local backend can still write to real
GCP resources, upload files, and incur provider or storage costs. Keep the
session on controlled data and do not click generation unless live-provider
proof is explicitly required and separately authorized.

## Baseline viewport checks

For a changed responsive flow, check the smallest relevant set from this
baseline. Use all four when layout or shared navigation is affected:

| Device class | CSS viewport (width x height) |
| --- | --- |
| Phone portrait | 375 x 812 |
| Tablet portrait | 768 x 1024 |
| Tablet/desktop landscape | 1024 x 768 |
| Desktop | 1440 x 900 |

These are CSS viewport dimensions at 100% browser zoom, not screenshot pixel
dimensions. Verify the viewport after resizing; browser chrome and device
pixel ratio do not count toward the values.

## What to exercise

### Chrome manual setup

Open Chrome DevTools, choose **Toggle device toolbar**, select **Responsive**,
and enter the width and height from the matrix. Keep browser zoom at 100%. If
dimensions are in doubt, inspect `window.innerWidth` and `window.innerHeight`
in the Console. Device emulation is useful for CSS layout, but is not proof on
a real phone or tablet; test a real device when the change depends on
microphone, touch, mobile keyboard, or browser-specific behavior.

Follow the affected user flow with real interactions, not screenshots alone:

- click controls and type representative text;
- reach controls with keyboard focus and Tab, and check visible focus;
- scroll the page and relevant panels; open and close dialogs;
- check wrapping, clipping, hit-target overlap, and horizontal overflow;
- check relevant empty, loading/in-flight, success, and recoverable-error
  states, including a refresh or navigation race when the change touches
  persisted or asynchronous state.

Keep state checks proportionate to the touched flow. Do not perform paid
generation merely to fill a checklist. Use automated tests and existing mocks
where available for generated success/failure paths; manual live generation is
optional evidence.

### Example interaction script

For a dialog or long-form setup change, run one concrete script:

1. Open an existing candidate's Edit dialog and enter representative long text
   in **Describe your edit**.
2. Scroll inside the dialog to the bottom and back to the top.
3. Use Tab to move through the buttons and confirm focus remains visible;
   do not activate **Generate**.
4. Type a small correction, click **Cancel**, and confirm the dialog closes
   without saving.
5. Reopen it and confirm the unsaved text is gone; navigate back and confirm
   the page remains usable.

Do not click a generation control for this script. Report unavailable loading,
error, or provider-backed states as `NOT TESTED`.

## Evidence

Copy this into the PR or review note and remove irrelevant rows:

```text
Commit:
Dirty diff:
Changed flow:
Commands: (for example: cd ui && npm test -- --watch=false)
Browser/build:
Viewport/zoom: 375x812, 768x1024, 1024x768, 1440x900 at 100% (list those run)
Passed:
Failed:
Not tested: (including unavailable live/provider checks)
Notes:
```

Attach a screenshot or recording only when it demonstrates a result or
failure. Sanitize project/user identifiers, customer assets, signed media
URLs, tokens, and other private data before sharing evidence.
