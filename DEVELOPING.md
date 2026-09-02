<a id="developing-top"></a>
# Developers' Guide for Remix Engine and its applications

This repository currently comes with a single user interface, Scene Machine, which is designed to accelerate manual work on individual videos. The backend, Remix Engine, is also able to process other media, and scaled workloads. To avoid reinventing the wheel, new use cases could be added to this repository, either by "only" adding a new user interface, or by also adding functional modules should recombining the existing ones not suffice.

[Local dependencies](#local-dependencies) •
[Local Development](#local-development-and-faster-deploys) •
[Creating Applications](#creating-applications) •
[Modules not used by Scene Machine](#modules-not-used-by-scene-machine) •
[When to use Remix Engine](#when-to-use-remix-engine) •
[Known Issues](#known-issues) •
[Applications Architecture](#applications-architecture) •
[Remix Engine Architecture](#remix-engine-architecture) •
[Testing](#testing)

## Local dependencies

[Top](#developing-top) • [Creating Applications >](#creating-applications)

To install Python dependencies (incl. formatter):

- `pip-compile --generate-hashes --no-emit-index-url --output-file=requirements-dev.txt requirements-dev.in`
- `pip install -r requirements-dev.txt --upgrade`

## Local Development and Faster Deploys

[< Local dependencies](#local-dependencies) • [Top](#developing-top) • [Creating Applications >](#creating-applications)

Scene Machine runs as Cloud Run services in production, and `deploy.sh` is the right tool to ship a release. But you should not run a full deploy every time you tweak an Angular component: a deploy renders config, builds the UI, uploads to Cloud Build, builds an image, and rolls out Cloud Run. The local loop below lets you edit the UI and see it reload in seconds while still calling the same `/api` endpoints the deployed app uses.

This local path is for people **building** Scene Machine. People **using** it should use a deployed instance.

### One-time dev setup

Render the two files the UI needs from their templates (run again whenever the templates change):

```
./scripts/dev-setup.sh
```

This writes `ui/src/env.ts` and `ui/definitions/config.json` with `controlPlaneMode: 'none'` (the dev front-door mode: the UI treats you as already signed in and never shows a sign-in gate) and keeps the data plane mediated. Both files are gitignored. The deployed `iap` mode is untouched, and `deploy.sh` refuses to ship a `none` build, so this can never reach production.

Point it at your own dev project with the overrides `SM_DEV_PROJECT`, `SM_DEV_FIRESTORE_DB`, and `SM_DEV_GCS_BUCKET`.

### Seed the local config document (first run only)

The backend serves `/api/config` from the `config/global` Firestore document. A fresh dev database does not have it, so `/api/config` returns `404 Config not seeded`; the UI then falls back to empty defaults (you can browse, but cannot start a generation). Seed it once against your dev database, the same way `deploy.sh` does (model/region values come from `config.txt` — copy `config.template.txt` if you do not have one):

```
set -a; source ./config.txt; set +a   # GEMINI_MODEL, regions, etc.
export PROJECT="${SM_DEV_PROJECT:-scene-machine-local-dev}"
export FIRESTORE_DB_UI="${SM_DEV_FIRESTORE_DB:-scene-machine-ui}"
export GCS_BUCKET="${SM_DEV_GCS_BUCKET:-${PROJECT}-scene-machine}"

curl -s -X PATCH \
  "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/config/global" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  -H "Content-Type: application/json" \
  -d @<(envsubst < ./firestore_config_frontdoor.template.json)

# The model catalog document (config/models), seeded from the repo file the
# same way deploy.sh does it:
python3 scripts/seed_config_models.py convert < ui/definitions/models.json | curl -s -X PATCH \
  "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${FIRESTORE_DB_UI}/documents/config/models" \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "x-goog-user-project: ${PROJECT}" \
  -H "Content-Type: application/json" \
  -d @-
```

This requires a Firestore database to already exist in your dev project (the one `FIRESTORE_DB_UI` names) and ADC with write access to it.

### The local loop (two terminals)

The local backend talks to a real dev GCP project through your Application Default Credentials, so run `gcloud auth application-default login` once first.

**Terminal 1 - local backend (the `/api` server):**

```
ROLE=app AUTH_MODE=none LOCAL_WORKER=1 FIRESTORE_DB_UI=<your-dev-db> PORT=8080 python3 orch.py
```

- `ROLE=app` serves the `/api` front door (not the worker).
- `AUTH_MODE=none` removes the sign-in gate. This is **dev only** (see best practices below).
- `LOCAL_WORKER=1` runs workflow actions in-process instead of scheduling Cloud Tasks, so you do not need a separate worker service or a `WORKER_URL`. It is **dev only** (no retries/backoff) and is only honored when `AUTH_MODE=none`.
- `FIRESTORE_DB_UI` points at a dev Firestore database, and must match the value `dev-setup.sh` used (`scene-machine-ui` by default, or your `SM_DEV_FIRESTORE_DB`).

**Terminal 2 - Angular dev server with the `/api` proxy:**

```
cd ui
npm run dev
```

`npm run dev` runs `dev-setup.sh` and then `ng serve`. The proxy (`ui/proxy.conf.json`, wired into `angular.json`) forwards every `/api` request from the browser to the local backend on `http://localhost:8080`, so the browser keeps calling **relative** `/api/...` URLs exactly as in production, with no CORS setup. Open the printed `http://localhost:4200`; edits under `ui/src` hot-reload. After the first run, plain `cd ui && npm start` works too.

### Running a full workflow locally

By default the backend hands work to Cloud Tasks, which cannot call back into your laptop. For an end-to-end run on your machine, add the dev-only `LOCAL_WORKER=1` to the backend command:

```
ROLE=app AUTH_MODE=none LOCAL_WORKER=1 FIRESTORE_DB_UI=<your-dev-db> PORT=8080 python3 orch.py
```

This runs each backend action in an in-process thread instead of scheduling a Cloud Task (`orchestrator.supply_node(data, None)`). It is honored only when `AUTH_MODE=none`, so it cannot turn on in a deployed service. Caveats: actions run in worker threads inside the single dev process, with no Cloud Tasks retry or backoff, so it is fine for exercising one workflow but not for load. (For a UI-free run there is also `cli.py`; see [Testing](#testing).)

### Local development best practices

- **Relative `/api` only.** Keep the browser calling `/api/...`; the proxy exists so the frontend never needs an absolute backend URL.
- **Auth bypass is dev only.** `AUTH_MODE=none` and `controlPlaneMode: 'none'` remove the sign-in gate, which is fine on localhost and unacceptable in production. `deploy.sh` refuses to build or ship a `none` UI, including via `--skip-ui-build`.
- **Stay close to production.** The local UI is the real app, not a separate local-only page, so what you see is what users get.
- **Real project by default.** The default local path talks to a real dev project through ADC.

### Faster deploys

A full `./deploy.sh` stays the safe default and is what you should run for a release candidate. The options below are opt-in shortcuts for everyday iteration on an already-provisioned project. Each skipped step is logged, so a deploy stays auditable.

- **Docker layer caching (automatic).** `cloudbuild.yaml` reuses unchanged layers from the previously built image, so the slow dependency install only re-runs when `requirements.txt` changes. The first build on a fresh project still works.
- **`--app-only`** builds the image and deploys only the `app` service, reusing the live worker. Good for app or backend changes that do not touch the worker.
- **`--skip-ui-build` / `--use-existing-ui-dist`** reuses the existing `ui/dist` instead of rebuilding the UI. Good for backend-only changes. It reuses the config already baked into that build, so use it when redeploying the **same** project. The deploy refuses a `ui/dist` that was built for local dev (sign-in disabled).
- **`--no-build-cache`** forces a clean cold image build, for a release or a dependency refresh.

### Future considerations: splitting the app and worker images

Today `deploy.sh` builds **one** image and runs it as two Cloud Run services via the `ROLE` env var (`app` serves the UI and `/api`; `worker` runs background jobs). One image keeps deployment simple, but it means the lightweight `app` service still ships inside an image that also carries ffmpeg and the heavier generation dependencies only the `worker` needs, so a UI change rebuilds the large image.

If deploy speed ever becomes the main bottleneck, the two services could be built as separate images: a small `app` image (Flask, `/api`, static UI) and a heavier `worker` image (action execution, ffmpeg, generation libraries). The services already differ only by `ROLE`, so this is mostly a packaging change. It is deferred because it raises operational complexity: two images to build, tag, version, and keep in sync, and more branches in the deploy path. Do it only after the local UI loop and the layer cache, which capture most of the day-to-day speed win at far lower risk.

## Editing the model catalog at runtime

The model catalog — which models exist, their locations and capabilities, and the per-family defaults — lives in the repo at `ui/definitions/models.json` and is written to the `config/models` Firestore document on every deploy. The app service reads the live document on every request, so anyone with Firestore access can change the served catalog without a deploy:

- **Editable live:** the `models` and `defaults` sections — add a model, remove one, fix a location or a capability flag.
- **Not editable live:** the `actions` section. It wires the catalog to `actions.json` parameter names; if the live document's copy differs from the shipped one, the app rejects the whole document and falls back to the shipped file. Change it in the repo.
- **Edits are temporary.** The next deploy overwrites `config/models` from the repo (after showing a diff at the confirmation prompt). To make a change permanent, land it in `ui/definitions/models.json`.
- **A malformed edit is safe but ignored.** The app logs `config/models unusable (...)` and keeps serving the catalog that shipped with the deploy — check the app service logs if an edit doesn't seem to apply.
- **The worker does not see live edits.** Capability flags read at execution time (for example `supports_audio`) come from the shipped file until the next deploy. Live edits change which submissions are accepted immediately; they change execution behavior only after a deploy. (Exception: local dev runs everything in one `ROLE=app` process, so in-process actions there read the live doc.)
- Consider enabling Firestore point-in-time recovery on the UI database as a general safety net for console edits.

**Gemini Omni**: generates one clip per call and always with sound, 3 to 10 seconds long, `global` location only (the dropdown shows it only while `VEO_REGION` is `global`), about $0.10 per output second, generated through `actions_lib/omni.py` via the Interactions API, and the `family` field of the catalog decides which transport `actions/generate_video.py` uses. The edit_video action sends an existing clip plus a prompt back to Omni and stores the edited clip; only models whose catalog entry lists edit_video can run it. In the app, the Edit button on a candidate runs edit_video with the candidate's clip and a prompt; it is shown only when the catalog lists a model with edit_video at the configured video location.

## Creating Applications

[< Local Development](#local-development-and-faster-deploys) • [Top](#developing-top) • [Modules not used by Scene Machine >](#modules-not-used-by-scene-machine)

In the absence of a generic user interface to define workflows, each actual tool built on Remix Engine can be limited to having a fixed workflow plus a user interface that

- allows the selection of inputs,
- allows the definition of all parameters,
- uploads the inputs to GCS and
- submits the workflow definition to the backend.

It could also

- expose intermediate results and
- allow to modify them.

The workflow is triggered by a call to `/supplyNode`, POSTing a JSON string as described in [Workflow Definition](#workflow-definition). This returns a JSON object with a property `executionId`, which can then be used to query the status of the execution via `/getStatus/[executionId]`.

## Modules not used by Scene Machine

[< Creating Applications](#creating-applications) • [Top](#developing-top) • [When to use Remix Engine >](#when-to-use-remix-engine)

As Remix Engine is meant for use by various applications and can also be useful when called on the command line, without any UI, the repository contains action modules that are not referenced by the user interface.

The following are awaiting inclusion in Scene Machine:

- `convert_image.py`
- `convert_video.py`

The following support batch/scaled ad-video generation:

- `generate_arrangement.py`
- `generate_image.py`

The following are used by `demo.json` to test Remix Engine without any complex operations, e.g. for race conditions dealing with Firestore:

- `concat.py`
- `group_concat.py`
- `translate.py`

The following are obsolete:

- `write_products_script.py` (formerly used to generate storyboards based on image descriptions)

## When to use Remix Engine

[< Modules not used by Scene Machine](#modules-not-used-by-scene-machine) • [Top](#developing-top) • [Known Issues >](#known-issues)

The architecture could be used to realise all kinds of workflows:

- Existing workflows can be easily extended.
- Scaling across various data dimensions is built in.
  - New functionality can be added without worrying too much about that aspect.
  - Failures for part of the variants don't let the whole workflow fail.

But it is less suitable for use cases with the following properties:

- The core functionality cannot be reduced to transformations of input on GCS to output on GCS.
- All of the needed functionality requires additional modules.
- Steps of manual intervention cannot be realised in an HTML UI that uploads and shows GCS content.

## Known Issues

[< When to use Remix Engine](#when-to-use-remix-engine) • [Top](#developing-top) • [Applications Architecture >](#applications-architecture)

### Module `combine_video`

- The output video's frame rate is simply the highest of the inputs.
- Audio is added in a way that largely preserves (adds) input volumes and avoids clipping, but that may not satisfy professional requirements.

### Module `convert_image`

- The modules only considers extensions, not actual content, so there may be cases in which the source is left untouched although it is in a format actually incomprehensible for the downstream processors.

### Module `convert_video`

- Like `convert_image`, this only considers extensions rather than actual codecs.

### Module `outpaint_image`

- When an image has a frame, by its very nature, outpainting won't extend the inner image (well).

## Applications Architecture

[< Known Issues](#known-issues) • [Top](#developing-top) • [Remix Engine Architecture >](#remix-engine-architecture)

TO DO

## Remix Engine Architecture

[< Applications Architecture](#applications-architecture) • [Top](#developing-top) • [Testing >](#testing)

Remix Engine is a Cloud Run app in Python serving `/supplyNode`, which initially gets a configuration JSON to process the workflow's root node, and ultimately causes calls to itself to execute successor nodes.

Each node represents an `action`, and they are executed in parallel, using Cloud Tasks, on packets of input data. Those packets result from splitting the whole input in a way fitting the signature of the function to be executed and considering the structure of the input data – see [Input Format](#input-format).

Each packet is processed by a call to another route, `/triggerAction`, which after execution of the action informs the successor node(s) of its results. This is another call to `/supplyNode`, each of which gets aborted until all the needed input is available: the incoming data gets collected in Firestore – see [Firestore Status](#firestore-status) – until the call that sees the input completed proceeds with the actual execution via /triggerAction:

- `/supplyNode`:
  - prepare input
  - if input complete return 200 after queueing task (else 202 and finish):
    - for all input groups
      - call `/triggerAction`
        - return 200 after queueing task:
          - (actual work)
          - for all successors
            - prepare output
            - call `/supplyNode`

> **Note**: If, say, a translation node follows a transcription node, and the input is a list of recordings, the translation could theoretically start on some transcriptions while others are not yet ready. However, to limit complexity, the workflow only proceeds once all predecessor nodes are finished.

> **Note**: "Resource Exhausted" errors in actions are 'bubbled up' until `orch.py` returns HTTP code 429 so that Cloud Tasks retries them. Others (or the former after a certain number of failed retries) are logged but don't as such break the workflow. Of course, downstream nodes can themselves error out if their input is unavailable, which can ultimately be as useless as if the workflow had been stopped at the original error. Also, some 'meta' errors may lead to the error not even being propagated in the first place.

### Actions

Actions are defined in `actions.json` and implemented in the `actions` package in a file named after the action whose main function is called `execute`.

#### Actions Definition

`actions.json` describes what is available and how it operates, mainly the needed inputs and resulting outputs. The keys are the action names, and the values are dictionaries with the following properties:

- `input` and `output` are dictionaries describing the action's argument names and output properties, respectively. Besides naming them, types are provided to allow for compatibility checks and correct encoding/decoding. Optionally, `multi` indicates whether multiple inputs and outputs of this kind are possible, and `dimensions` lists the properties that the action will expect or add – see [Input Format](#input-format)]. Capturing this information 'redundantly' to the actual implementation increases transparency for workflow developers and allows for some automated tests.
- `parameters` is a dictionary listing the argument names to be hard-coded in the workflow definition, along with their types.

The file is accessible to both the UI and the backend.

<details>
<summary>Example</summary>
```javascript
{
    "greet": {
        "input": [{"name": "text", "type": "string"}],
        "parameters": {"salute": {"type": "string"}},
        "output": [{"name": "text", "type": "string"}]
    },
    "concat": {
        "input": [{"name": "text1", "type": "string"}, {"name": "text2", "type": "string"}],
        "output": [{"name": "text", "type": "string"}]
    },
    "group_concat": {
        "input": [{"name": "text", "type": "string", "multi": true}],
        "parameters": {"sorting_key": {"type": "string"}},
        "output": [{"name": "text", "type": "string"}]
    },
    "translate": {
        "input": [{"name": "text", "type": "string"}],
        "parameters": {"source_language": {"type": "string"}, "target_language": {"type": "string"}},
        "output": [{"name": "text", "type": "string", "multi": true, "dimensions": ["language"}]
    }
}
```
</details>

To check whether `actions.json` and the actions' implementation match, you can use this command: `python3 -m test.test_actions_sig`

#### Actions Implementation

The implementation of the actions needs to stick to the following rules, in addition to all names having to match the abstract definition:

- The action function's data arguments are GCS references as described above: dictionaries whose property `value` is an array of GCS URLs, but may have other properties – see [Input Format](#input-format)].
- In addition, there are parameter arguments that are arbitrary dictionaries.
- The return value is a dictionary of GCS references.

### Workflow Definition

Workflows are mainly defined as a set of nodes, each referencing the following information:

- `action` is the name of the action to execute, equalling the name of the function in the code.
- `input` is a dictionary whose keys denote the names of the input arguments of the function and whose values point to the node from which that input is to be sourced, that nodes's action's specific output to be used.
- `parameters` are optional and similar to inputs, the difference being that their values are hard-coded, i.e. would be specified manually in the UI rather than flowing in from an upstream node. Parameters that are arrays will result in the node being executed multiple times for each input: at least once for each element of the array, more often in case other parameters are also arrays.
- `dimensionsConsumed` are also optional, an array of strings identifying the input-data dimensions the node will ignore/flatten/consume – see [Input Grouping](#input-grouping).
- `dimensionsMapping` maps the dimensions that the action operates on (see [Actions Definition](#actions-definition)) to those actually to be used in the given workflow. For example, on the input side, an action might expect a "product_id" to align input texts and input images, where the upstream nodes actually provide a "prod_id". In output, several actions may add a "variant_id" that may require renaming to not cause unintended alignment. Both would be captured by `"dimensionsMapping": {"product_id": "prod_id", "variant_id": "variant_a_id"}}`. The target names of the mapping must be unique.

> **Note**: The action may or may not store the parameter(s) as dimensions in the output. For example, if the action is a translation, then the language parameter will usually be an output dimension that allows alignment by language. As another example, in creative content generation, one may use several "temperature" values to get several variants, and here the developer of the action would usually not have added that as a dimension, leading to a list of outputs that would be provided to downstream nodes.

The workflow definition is accompanied by some additional properties:

- `nodeId` initially denotes the root node to execute, but will vary in downstream executions.
- `workflowId` can be a checksum of the workflow definition and input, serving to store data under a recognisable name and preventing accidental re-execution of the same workflow.
- `inputFiles` is a dictionary whose keys are the names of the node's function's arguments, and whose values are arrays of dictionaries whose main content are file paths on GCS, pointing to the actual input data. Those inner dictionaries may have other properties – see [Input Grouping](#input-grouping) for their purpose.
- `workflowParams` is a dictionary defining workflow-level parameters like a project name or developer token.
- `forceExecution` is a boolean flag allowing the execution of the workflow without relying on results cached in previous runs.

Workflow definitions need to satisfy some 'natural' conditions:

- Node names must be distinct.
- Referenced actions must actually be implemented.
- Inputs and parameters of those actions must fit what they expect. (However, some inputs may be optional.)
- There may be no loops in the flow.

<details>
<summary>Example</summary>
The code comes with examples, [one of which](examples/example1.json) is explained below:

- inputs two texts and
- in separate workflow paths prepends both with two different greetings (at which point there are four texts),
- fake-translates those into two languages (making it eight) and
- concatenates the pairs with distinct greetings (making it four again).
- The paths then merge by concatenating each language's two texts into a long one,
- ultimately outputting two texts, one per language.

```javascript
{
    "workflowDefinition": {
      "root": {
        "action": "pass",
        "input": { "text": null }
    },
      "greet_0": {
        "action": "greet",
        "parameters": { "salute": "Hello" },
        "input": { "text": { "node": "root", "output": "text" } }
    },
      "greet_1": {
        "action": "greet",
        "parameters": { "salute": "Hi" },
        "input": { "text": { "node": "root", "output": "text" } }
    },
      "translate_0": {
        "action": "translate",
        "parameters": { "source_language": "en", "target_language": ["de", "fr"] },
        "input": { "text": { "node": "greet_0", "output": "text" } }
    },
      "translate_1": {
        "action": "translate",
        "parameters": { "source_language": "en", "target_language": ["de", "fr"] },
        "input": { "text": { "node": "greet_1", "output": "text" } }
    },
      "concat_0": {
        "action": "concat",
        "input": {
            "text1": { "node": "translate_0", "output": "text" },
            "text2": { "node": "translate_1", "output": "text" }
          }
      },
      "concat_group_0": {
        "action": "group_concat",
        "parameters": { "sorting_key": "id" },
        "dimensionsConsumed": ["id"],
        "input": { "text": { "node": "concat_0", "output": "text" } }
    },
      "sink": {
        "action": "pass",
        "input": {
            "concat_group_0.text": { "node": "concat_group_0", "output": "text" }
          }
      }
    },
    "nodeId": "root",
    "workflowId": "563456251290359025",
    "inputFiles": { "text": [
      {"file": "remix-input/OldWorld.txt", "id": "1"},
      {"file": "remix-input/NewWorld.txt", "id": "2"}] }
  }
```

</details>

### Input Format

The input data – and that forwarded between nodes – is a dictionary of annotated GCS references, each property representing a type of input to the work function, with the key naming the function argument. The arrays themselves – for simplicity, they are such even if only one element is present – consist of dictionaries that at least contain a key `file` with the actual path on GCS.

> **Note**: The difference between input and output of the action functions is that the input is split into the named named arguments, whereas the output is a single dictionary keyed by output name.

#### Dimensions

The input dictionaries can also have other properties, called "dimensions", which by convention are all strings to allow unambiguous comparisons between values. They can be used by the actions to process the input in a suitable way, but are mostly used to determine which input files belong together, ultimately grouping the input for each execution – see [Input Grouping](#input-grouping).

> **Note**: To ensure that set of inputs are processed separately, they all should have at least one distinct dimension value. For example, if we have three images for two products each that are to be turned into videos and then combined into one video per product, we need some "product_id" dimension to allow for the right groups to be combined, but also what could be called "input_id" (that differs among a product's images), so that the images get individually channeled to the video-creation action.

> **Note**: In the code, there is an ENUM `Dimension` to be used where actions read and write dimensions, so that their spelling can be better checked for identity with those mentioned in actions.json. Across actions, they don't need to align, but it makes sense to keep this simply so that, in the best case, workflow designers don't need to rename dimensions to get actions to collaborate. They also don't need to align with the representation of the corresponding entities inside the action implementation: For example, some actions may input and/or output an `image_id` dimension and also have "image_id" as a key in some intermediate object. The code avoids using the ENUM `Dimension` in those other cases to clarify that this is not the dimension name used as such, and that the name could be different.

<details>
<summary>Example</summary>
As an example, let's assume we have an action with the following inputs to build an ad:

- `celebrityName` is an audience-specific celebrity to feature in the ad.
- `text` is the main language- and country-specific text
- `image` are a audience-specific images that we don't have for all audiences
- `legalese` is a country-specific legal text that has to be in the ad
- `experiments` is a text with campaign settings of which we have two variants to compare their performance

Input for this – either input manually when defining the workflow, or flowing from upstream nodes – could look as follows:

```javascript
{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'},
                      {'file': 'Y.txt', 'audience': 'b'},
                      {'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'},
             {'file': 'H.txt', 'language': 'fr', 'country': 'CH'},
             {'file': 'I.txt', 'language': 'de', 'country': 'CH'},
             {'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'},
                 {'file': 'CH.txt', 'country': 'CH'},
                 {'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'},
                    {'file': 'E2.txt', 'option': '2'}]
}
```

</details>

### Input Grouping

Workflows can be used to process data that is independent from each other, either because it was initially supplied (e.g. a list of videos to be processed identically) or because of in-workflow multiplication (e.g. translations into multiple languages). Hence, whenever a node is given input, it needs to be determined how to split that input into workloads for separate executions. This is done using the non-`file` properties of the inner dictionaries of inputs, "[Dimensions](#dimensions)".

<details>
<summary>Example</summary>
For the previous example, 30 grouped inputs result, 15 of which are shown here – the other half has `option` 2 for the experiment:

```javascript
[{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'a'}],
    'text': [],
    'image': [{'file': 'I1.png', 'audience': 'a'},
              {'file': 'I2.png', 'audience': 'a'}],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'X.txt', 'audience': 'b'}],
    'text': [],
    'image': [],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'G.txt', 'language': 'de', 'country': 'DE'}],
    'image': [],
    'legalese': [{'file': 'DE.txt', 'country': 'DE'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'H.txt', 'language': 'fr', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'I.txt', 'language': 'de', 'country': 'CH'}],
    'image': [],
    'legalese': [{'file': 'CH.txt', 'country': 'CH'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [{'file': 'J.txt', 'language': 'en', 'country': 'GB'}],
    'image': [],
    'legalese': [],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},{
    'celebrityName': [{'file': 'Z.txt', 'audience': 'c'}],
    'text': [],
    'image': [],
    'legalese': [{'file': 'IT.txt', 'country': 'IT'}],
    'experiments': [{'file': 'E1.txt', 'option': '1'}]
},...]
```

</details>

Only non-contradictory data is passed to functions, but the absence of a match is considered okay, as the empty arrays in the example show. It is up to the action to discard inputs it cannot work with, as it can be perfectly normal for some action to not be able to produce certain input and for this then to prevent certain recombinations from being considered downstream. Importantly, the action _must_ still return an empty result in these cases so that the downstream nodes don't eternally wait for it.

#### Dimension 'consumption'

Nodes can be defined as 'consuming' a dimension, if in their case the input should not be split by that. For example, suppose we have a list of scene transcripts with dimension "sceneId": while it makes sense to turn them to speech separately, a downstream node combining those audio snippets sequentially would need to access all of them at once.

#### Dimension addition

As mentioned, data can have dimensions from the initial definition in the UI or due to nodes adding them. For example, a translation node can turn each input text into several output texts, each annotated with their language.

It can also be that a 'consumed' dimension gets added again. One example for this is a node that writes a single story inspired by several input photos of people that may have a "person_id", but also outputs a characterisation for each of these people, which feature their "person_id".

#### Dimension renaming

The `dimensionsMapping` mentioned in [Workflow Definition](#workflow-definition) is applied just before the input grouping to ensure the dimension names match those expected by the action. (With the converse mapping happening after execution.)

### Output–Input Mapping

When a node is done, its output gets mapped to the input of its successors by potentially renaming the dictionary keys.

For example, in the workflow defined previously, we have node `concat_0` with:

```
    "input": {
        "text1": { "node": "translate_0", "output": "text" },
        "text2": { "node": "translate_1", "output": "text" }
    }
```

The outputs of the translation nodes hence need to be renamed from `text` to `text1` and `text2`, respectively before being passed to `concat_0`.

### Firestore Status

As mentioned, nodes only proceed once they have all their input. As that gets provided by independently executed requests, there needs to be a place where this input gets collected and that allows a determination of its completeness. For this, each workflow execution entails the creation of a Firestore collection containing one document per node in the workflow. These documents have the following fields:

- `inputFiles` contains the merged value of all separately provided inputs
- `targetCounts` is a dictionary whose keys are the keys of the `inputFiles` and whose values specify from how many different source executions data will need to be collected.
- `actualCounts` is a similar dictionary, listing how many sources already have contributed to the respective input argument.
- `lastUpdated` is a timestamp for debugging purposes.

Already the first source reporting data knows how many sibling sources it has and which input arguments exist in total, so whenever new data comes in, it can be checked if all these arguments are accounted for with all their respective sources.

### Cloud Storage for storing/caching action output

It is conceivable that workflows will most often be modified in some downstream node to refine the ultimate output. In such a case, it is unnecessary to execute all the upstream actions again, hence Cloud Storage is used to automatically cache results information: Prior to each execution, the existence of a certain file is checked whose name is determined by the action name and a checksum of inputs and parameters. If it does, its contents are used in the action output's stead.

If not, the action gets executed and its output stored in said file. For this, the action is handed an object that allows

- access to the files on Cloud Storage that the input data points to, as well as
- the easy storage of data with a filename of its choice, as name collisions are avoided because the storage automatically and transparently happens in a designated folder that is unique to the action and its input data and parameters (via a checksum).

## Testing

[< Remix Engine Architecture](#remix-engine-architecture) • [Top](#developing-top)

The folder `workflow_examples` contains numerous JSON files that can be used to check if the tool works. They rely on the input files in `workflow_examples/input`, which you upload to the configured GCS bucket's `examples/` prefix yourself before running them (the deploy no longer uploads them). There are two ways of executing the examples:

### Running workflows with endpoint calls

It is possible to call a workflow `demo.json` without relying on the user interface. To do that, we first need to determine the URL to call:

```
source config.txt
export CLOUD_RUN_URL=$(gcloud run services describe worker --region=$REGION --project=$PROJECT --format='value(status.url)')
```

The `worker` service serves `/supplyNode` and `/triggerAction`. It is private, so the identity token below authenticates a caller that holds the Cloud Run Invoker role on it.

Then we can call the actual workflow, here `demo.json`, while substituting some of the values defined in `config.txt`:

```
curl -X POST $CLOUD_RUN_URL/supplyNode -H "Authorization: bearer $(gcloud auth print-identity-token)" -H "Content-Type: application/json" -d @<(envsubst < workflow_examples/demo.json)
```

Among the first lines of the (quite verbose) textual output, you will find an execution ID. Check its status from the graphical view of the generation process described [here](README.md#technical-problems), or with `python3 cli.py --s <EXECUTION ID>` (see [Running workflows with CLI calls](#running-workflows-with-cli-calls) below). The `worker` service has no status endpoint; `/getStatus` is served only by the IAP-gated `app` service as `/api/getStatus`.

### Running workflows with CLI calls

It is also possible to achieve the same as above, but without relying on Cloud Run or Cloud Tasks. The following simply runs the Python code locally:

```
source config.txt
python3 cli.py --e <(envsubst < workflow_examples/image2video.json)
python3 cli.py --bucket $GCS_BUCKET --s <EXECUTION ID>
```

### Other means of testing

There are various Python unit tests in the folders `test`, `actions/test` and `actions_lib/test`.

The UI unit tests run with Angular's test builder from the `ui` folder (Node 22 required):

```
cd ui && npm test
```

In addition, the following calls are available:

- `python3 -m test.test_actions_sig`: This compares the signatures of the modules in the `actions` folder with those defined in `actions.json`.
- `python3 -m test.simulate_workflow`: This conducts a mock run of a workflow (you'd need to change the hard-coded one in the file) to check how the data would flow, especially in terms of the "dimensions" attached.
