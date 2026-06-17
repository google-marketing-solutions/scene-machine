<!--
Copyright 2025 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

<a id="readme-top"></a> *Disclaimer: This is not an officially supported Google
product.*

# Scene Machine: Storyboard-Driven Generative AI Video Ad Creation

Scene Machine is a Google Cloud-based, open-source workbench that leverages
generative AI models to facilitate storyboard-driven video ad creation. While
its primary use case is transforming product or service images (such as in
retail, food delivery, or travel) into video ads, it also serves as a robust
video prototyping platform for rapidly sharing and iterating on ideas.

## TL;DR

-   **Production Speed:** Automates and parallelizes scene generation, reducing
    a lengthy asset workflow to minutes.
-   **Target Audience:** Advertisers, developers, and creative teams seeking a
    video generation workbench built natively on Google Cloud.
-   **Key Technology:** Harnesses
    [Gemini](https://deepmind.google/models/gemini/) for intelligent prompt
    design and the [Veo model](https://deepmind.google/models/veo/) for
    high-fidelity, parallel image-to-video generation. The entire workflow is
    orchestrated through a single intuitive web interface.

--------------------------------------------------------------------------------

[How it works](#how-it-works) •
[Technical Requirements](#technical-requirements) • [Deployment](#deployment) •
[Using Scene Machine](#using-scene-machine) •
[Alternatives](#alternatives-to-scene-machine) •
[Developers' Guide](DEVELOPING.md)

--------------------------------------------------------------------------------

## How it Works

[< TL;DR](#tldr) • [Top](#readme-top) •
[Technical Requirements >](#technical-requirements)

> [!TIP]
> For a step-by-step guide with screen recordings, see
> [`docs/walkthrough.md`](./docs/walkthrough.md).

![Scene Machine Promo](./docs/media/00_read_me_scene_machine_promo.gif)

Scene Machine guides users through four core stages to turn a set of static
images into a video asset.

### 1. Setup (Storyboard Generation)

Upload images and business context (such as target audience and brand
guidelines) to have Gemini automatically generate a structured, prompt-driven
storyboard. Users can optionally apply predefined Creative Templates to guide
scene structure, or start with an empty storyboard to build the timeline
manually.

### 2. Storyboard (Video Generation & Scene-by-Scene Iteration)

The backend sends parallel video generation requests to Google's Veo model,
significantly reducing the total time required. Users refine the ad by iterating
on prompts and candidate variations scene-by-scene. The timeline can be expanded
at any point by generating new scenes (via text-to-video or image-to-video) or
by uploading existing video slates. This process is entirely non-destructive,
allowing users to adjust, trim, and reorder assets without losing previously
generated video scenes.

### 3. Composition (Transitions, Audio, and Brand Overlays)

Once scenes are finalized, users can enhance their ad in the Composition stage
by adding transitions between scenes, custom background audio tracks (music or
voice-overs), and precise pixel-positioned image overlays (such as brand logos).

### 4. Output (Rendering & Export)

Users compile all timeline assets by rendering the video, which is then
available for review or direct MP4 download. Crucially, the history panel
preserves all older rendered versions, enabling users to maintain and compare
multiple creative variants (e.g., short vs. long versions) within the same
project.

## Technical Requirements

[< How it Works](#how-it-works) • [Top](#readme-top) •
[Deployment >](#deployment)

To deploy this application, you need a **project on Google Cloud Platform with
billing enabled**.

-   Scene Machine's user interface is an Angular/TypeScript application served,
    together with the `/api` control plane, from the `app` Cloud Run service.
-   The actual processing is performed by **Remix Engine**, a modular Python
    application running on a private `worker` Cloud Run service. See the
    [Developers' Guide](DEVELOPING.md) for details.

Scene Machine sends workflow definitions to Remix Engine, which orchestrates its
functional modules (e.g. turning images into videos) and reports back on
results.

### Google Cloud APIs Used

The following APIs are used by Scene Machine:

-   Agent Platform API ( aiplatform.googleapis.com ): Used for accessing Gemini
    and Veo models for text, image, and video generation.
-   Artifact Registry API ( artifactregistry.googleapis.com ): Used to store the
    Docker container images for the backend service.
-   Cloud Build API ( cloudbuild.googleapis.com ): Used to build the container
    images for Cloud Run.
-   Compute Engine API ( compute.googleapis.com ): Enabled to guarantee the
    default Compute Engine service account exists (used for IAM role bindings
    during deploy).
-   Cloud Tasks API ( cloudtasks.googleapis.com ): Used for managing task queues
    for asynchronous processing (e.g., video generation).
-   Cloud Firestore API ( firestore.googleapis.com ): Used for the database
    storing application state and configurations.
-   Cloud Run API ( run.googleapis.com ): Used to host and run the backend
    service.
-   Identity-Aware Proxy (IAP) API ( iap.googleapis.com ): Used to secure the
    application and manage access.
-   Firebase API ( firebase.googleapis.com ): Used to link the project to
    Firebase and to deploy the Firestore and Storage security rules.
-   Cloud Storage API ( storage.googleapis.com ): Used for storing assets,
    examples, and generated content.
-   Cloud Logging API ( logging.googleapis.com ): Used for application logging
    (referenced in requirements.in ).

*Please note that most of the APIs are enabled automatically when you run the
deployment script. Cloud Storage and Cloud Logging are normally enabled by
default. If your organization disables these APIs, you will need to enable them
manually.*

### Permissions required for the deploying user

`roles/owner` on the target project is sufficient and is the simplest option.

If your organization forbids broad roles like `roles/editor`, the following is
the minimum set of roles required to deploy Scene Machine. Each one maps to
something the deploy actually does, so a narrowly-scoped deployer can be granted
exactly these instead of `editor` or `owner`:

Role | Why it's needed
--- | ---
`roles/serviceusage.serviceUsageAdmin` | Enable the required Google Cloud APIs
`roles/datastore.admin` | Firestore native-mode database creation (`databases.create`)
`roles/artifactregistry.admin` | Create the Artifact Registry repo and push the container image
`roles/cloudbuild.builds.editor` | Build the image (Cloud Build runs `gcloud run deploy --source`)
`roles/run.admin` | Create and configure the `app` and `worker` Cloud Run services
`roles/cloudtasks.admin` | Create and manage the worker task queue
`roles/storage.admin` | Create the GCS buckets and set their CORS
`roles/firebase.admin` | Link the project to Firebase and deploy the Firestore/Storage rules
`roles/iam.roleAdmin` | Create the custom `SceneMachineUser` role
`roles/iam.serviceAccountAdmin` | Service-account-level IAM bindings (e.g. Cloud Tasks to Cloud Run "actAs")
`roles/iam.serviceAccountUser` | actAs the runtime service account during the Cloud Run deploy
`roles/resourcemanager.projectIamAdmin` | Project-level IAM bindings (the `add_iam_binding` calls in `deploy.sh`)
`roles/oauthconfig.editor` | Configure the OAuth consent screen
`roles/compute.viewer` | View the project's services and settings

The single-image front-door deployment no longer uses App Engine or API
Gateway, so the legacy `roles/appengine.*`, `roles/apigateway.*`, and API-key
roles are **not** required.

The deploy also needs `roles/iap.admin` and `roles/iap.settingsAdmin` to enable
and configure IAP (Identity-Aware Proxy) on the `app` Cloud Run service, which is
how the deployed app gates access.

Some organizations forbid granting an **external** account `roles/owner`
outright (`ORG_MUST_INVITE_EXTERNAL_OWNERS`); in that case grant the roles in
this table individually instead of `owner`.

Every user (including you, the deployer) needs the custom
`projects/$PROJECT/roles/SceneMachineUser` role on the `app` service to get in.
See [Adding Users](#adding-users).

## Deployment

[< Technical Requirements](#technical-requirements) • [Top](#readme-top) •
[Adding Users >](#adding-users)

#### How access works

The deployed app is gated by Google's **Identity-Aware Proxy (IAP)**. IAP sits
in front of the `app` Cloud Run service: a person signs in at Google's front
door and is only let through if you have granted them access, so no
unauthenticated request ever reaches the service (the service itself stays
private). You grant someone access by giving them the `SceneMachineUser` role
through IAP — see [Adding Users](#adding-users). `deploy.sh` deploys in IAP mode;
it is the only deployable sign-in mode (there is no public mode).

There is one setup difference depending on your project:

-   **Project in a Google Workspace / Cloud Identity organization** (recommended
    for teams; required for corporate `google.com`-style projects) → IAP uses
    Google's **managed** OAuth client automatically (no client to create) and the
    consent screen can be **Internal**. This is the smoothest path, and it is the
    only option on organizations that enforce Domain Restricted Sharing (a common
    policy that forbids public services) — which IAP satisfies, since the service
    stays private.
-   **Personal project with no organization** (a plain gmail-owned project) → IAP
    still works, but you must **also create a custom OAuth client** once in the
    console (IAP → select the `app` service → Custom OAuth → *Auto-generate
    credentials*) and configure the OAuth consent screen. `deploy.sh` prints these
    one-time steps at the end. Without the custom client, sign-in fails with a
    `502 "Empty OAuth client"`.

> **Just want to develop, not deploy?** There is a local mode that runs the UI
> and backend on your own machine with **no sign-in** at all, for fast
> iteration — you do not need to deploy to work on Scene Machine. See
> [Local Development](DEVELOPING.md) in the Developers' Guide.

Access is enforced at the application's front door, not the data layer: all
Cloud Storage and Firestore work is performed by the app's own service account,
so end users never need direct storage/database permissions.

> [!IMPORTANT]
> **Projects and generated media are shared across everyone who is admitted.**
> Scene Machine is built for a trusted team: any admitted user can see, open,
> edit, and delete every project, and can view any generated media in the app's
> storage bucket. There is no per-user or per-group ownership. Admit only people
> you are comfortable sharing all projects with, and run separate deployments
> for groups whose data should stay separate.

#### Prerequisites

-   **Google Cloud Project**: A project on Google Cloud Platform **with billing
    enabled**.
-   **Permissions**: We recommend having the **Project Owner** role on the
    Google Cloud project to conduct the deployment successfully.
-   **Node.js**: Ensure you have [Node.js](https://nodejs.org/en/download)
    (≥v22) installed.
-   **Git**: Ensure you have `git` installed.
-   **Google Cloud SDK (gcloud)**: Ensure you have the
    [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed and
    initialized.
-   **Firebase Tools**: Install with `npm i -g firebase-tools`.
-   **envsubst**: Ensure you have `envsubst` installed (typically via the
    `gettext` package, e.g., `sudo apt-get install gettext` on Debian/Ubuntu,
    `brew install gettext` on macOS).

#### Sign in first (three separate logins)

The deploy uses **three independent credentials** that sign in — and expire —
separately. `deploy.sh` checks all three before it does any work and stops with
the exact command to run if one is missing, but it is simplest to refresh all
three up front. Run them in this order, signing in with the **same Google
account** each time (each opens a browser window):

```bash
gcloud auth login                       # 1. the gcloud CLI itself
gcloud auth application-default login   # 2. Application Default Credentials (ADC)
firebase login                          # 3. the Firebase CLI (add --reauth if your session expired)
```

-   **#1 `gcloud auth login`** authenticates the gcloud command-line tool.
-   **#2 ADC** is a *separate* credential that the deploy's REST calls use
    (Firestore seeding, Storage, enabling sign-in). It is required even though
    you ran #1: under corporate Certificate-Based Access (CBA) the plain gcloud
    token is rejected by those REST endpoints, so the deploy uses ADC instead.
-   **#3 `firebase login`** is the Firebase CLI's own identity, used to link the
    project and deploy the security rules. If you signed in a while ago, run
    `firebase login --reauth` to refresh the session — an expired (rather than
    absent) Firebase session can otherwise slip past the pre-flight check and
    fail partway through the deploy.

#### Step-by-Step Deployment

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/google-marketing-solutions/scene-machine
    cd scene-machine
    ```

2.  **Configure the Application**

    -   Create `config.txt` from the template:

        ```bash
        cp config.template.txt config.txt
        ```

    -   Edit `config.txt` in your favorite editor (e.g., `nano config.txt`).

    **Variables defined in `config.txt`:** You can check
    [available models and their regions](https://ai.google.dev/gemini-api/docs/models)
    to ensure you are using the most up to date models available in your
    selected region.

    Variable Name          | Description                                                | Recommended Values / Notes
    :--------------------- | :--------------------------------------------------------- | :-------------------------
    `PROJECT`              | Your Google Cloud Platform Project ID.                     | Required
    `REGION`               | Deployment region for various GCP resources.               | e.g., `us-central1`
    `GEMINI_MODEL`         | Text generation model for prompts and analysis.            | `gemini-3.5-flash`
    `GEMINI_REGION`        | Region for model invocation.                               | Check locations availability. Recommended `global`.
    `VEO_MODEL`            | Video generation model.                                    | `veo-3.1-generate-001`
    `VEO_REGION`           | Region for Veo model invocation.                           | Check availability. Recommended `global`.
    `IMAGE_MODEL`          | Image model for outpainting and image generation.          | `gemini-3-pro-image` (Nano Banana Pro), `gemini-3.1-flash-image` (Nano Banana 2)
    `IMAGE_MODEL_REGION`   | Region for image model invocation.                         | Check availability. Recommended `global`.
    `GCS_BUCKET`           | Storage bucket name for storing project images and assets. | Must be globally unique. Auto-generated by default.
    `FIRESTORE_DB`         | Firestore database ID used by the backend modules.         | Defaults to `scene-machine`.
    `FIRESTORE_DB_UI`      | Firestore database ID used by the user interface.          | Defaults to `scene-machine-ui`.
    `ARTIFACT_REPO`        | Artifact Repository ID to store artifacts.                 | Defaults to `scene-machine`.
    `TASKS_QUEUE_PREFIX`   | Prefix for Cloud Task queue names.                         | Max lengths apply. Support letters, hyphen, numbers.
    `BACKEND_SERVICE_NAME` | Service name for the application backend on GCP.           | Defaults to `remix-engine-backend`.
    `APP_MIN_INSTANCES`    | App service warm instances: 0 = scale to zero (default), 1 = keep one warm. | `0` (cold-start) or `1` (no cold start)
    `CUSTOM_DOMAIN`        | Custom domain for the application user interface.          | Optional. e.g., `scene-machine.my-company.com`

    -   **Important Notes for Configuration:**
        -   **Naming:** Use alphanumerical names (with hyphens) for entities
            like databases.
        -   **Storage:** If using an existing bucket, it must use a
            non-hierarchical namespace.
        -   **Locations:** Match model availability (e.g. Veo might not be
            available in all regions). Check
            [Google Cloud AI Platform documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)
            for locations.
        -   **Model Lifespans:** Prefer using current models as older ones are
            discontinued over time. Check
            [Google Cloud AI Platform documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/models)
            for model lifespans.

3.  **Execute Deployment**

-   Run the main deployment script. A single image serves both the UI and the
    `/api` control plane from the `app` Cloud Run service, with a private
    `worker` service for background jobs — there is no separate UI deployment
    step:

    ```bash
       ./deploy.sh
    ```

    -   *Note: The script prints per-phase run times as it goes.*

    -   **Headless / non-interactive runs:** add `--non-interactive` (which
        also implies `--yes`) for automated or agent-driven deploys. Instead of
        waiting at a manual console step, the script fails fast and prints the
        exact console URL and the command to re-run, so an automation can
        surface it and continue once the step is done.

    -   **Faster repeat deploys (opt-in):** a plain `./deploy.sh` always does the
        full, safe deploy. For everyday iteration on an already-set-up project,
        these flags skip work that is safe to skip, and each one logs what it
        skipped:
        -   `--app-only` — build the image and redeploy only the `app` service,
            reusing the live `worker` (use when you did not change the worker).
        -   `--skip-ui-build` (alias `--use-existing-ui-dist`) — reuse the
            already-built `ui/dist` instead of rebuilding the Angular UI (use for
            backend-only changes). The deploy refuses a `ui/dist` that was built
            for local dev, so it can never ship a sign-in-disabled build.
        -   `--no-build-cache` — force a clean image build, ignoring the Docker
            layer cache (use for a release or a dependency refresh).

        The image build also reuses Docker layers from the previous build
        automatically, so the slow dependency install only re-runs when
        `requirements.txt` changes. In practice a cached
        `--app-only --skip-ui-build` re-deploy is roughly twice as fast as a full
        one. To develop with **no deploy at all**, use the local loop in
        [Local Development](DEVELOPING.md).

> [!IMPORTANT]
> **A first-time deploy on a brand-new project needs a few one-time console
> actions.** A fresh project needs a handful of one-time steps in the Google
> Cloud and Firebase consoles that have no API to script: configuring the OAuth
> consent screen, enabling IAP on the `app` service, and — on a project with no
> organization — creating a custom OAuth client. The deploy itself runs
> unattended; it prints each remaining step, with the exact console URL, at the
> end of the run. Once the project has been set up this way, later deploys need
> no console steps at all.

> [!TIP]
> **Troubleshooting Firebase deployment failures:** If `./deploy.sh`
> fails at the Firebase step with an error like `Error: Project not found`, it
> usually means the Firebase CLI cannot access the project or terms have not
> been accepted.
>
> **How to fix it:**
>
> 1.  **Check Login:** Ensure you are logged in by running `firebase login` in
>     your terminal.
> 2.  **Manual Fallback (Accept Terms):** If still failing, go to the
>     [Firebase Console](https://console.firebase.google.com/).
> 3.  Click **Add Project** and select your existing Google Cloud project from
>     the dropdown list.
> 4.  Follow the prompts to add Firebase resources. This process will guide you
>     through accepting the necessary terms of service.
> 5.  Once completed in the console, return to your terminal and re-run
>     `./deploy.sh`.

4.  **Set up OAuth consent screen:**

    -   In your Google Cloud console, go to **API & Services > Credentials >
        OAuth consent screen**.
    -   Click **Get Started**.
    -   Follow the steps to configure the consent screen. Choose a name for the
        application you're creating, e.g. Scene Machine.
    -   You can choose **Internal** for the User Type if only users from your
        organization will use the app.
    -   The OAuth consent screen is a prerequisite for IAP. On a project **with
        no organization** you will also create a custom OAuth client for IAP in
        step 6; in an organization, IAP uses Google's managed client and you do
        not create one.

5.  **Link Storage Bucket to Firebase** — *two sequential actions* are required
    on the same Firebase Storage page.

    -   Open the [Firebase console](https://console.firebase.google.com/) →
        select your project → **Databases & Storage** → **Storage**.

    **(a) Initialize Firebase Storage** (one-time per project): - Click **Get
    started** and walk through the wizard. This creates the project's *default*
    `<project>.firebasestorage.app` bucket, which the Firebase CLI requires;
    without it the storage deploy fails with `Firebase Storage has not been set
    up on project`. - Production mode is fine. - *Note: No-cost locations are
    only available in the USA.*

    **(b) Register your project bucket with Firebase Storage:** - After (a)
    finishes the bucket dropdown appears at the top of the page (it doesn't
    exist until a bucket exists). - Click the dropdown → **+ Add bucket** →
    **Import existing Google Cloud Storage buckets**. - Select your project
    bucket (the one referenced by `GCS_BUCKET` in `config.txt`) → confirm.

6.  **Identity-Aware Proxy (IAP)** — this is the only way the app gates access
    (there is no Firebase sign-in to set up), and the deploy sets most of it up
    for you:
    -   `deploy.sh` enables IAP directly on the `app` Cloud Run service (via the
        `--iap` flag) and grants the IAP service agent the `run.invoker` role.
        If your `gcloud` is too old to support `--iap`, the script prints the
        exact `gcloud run services update app --iap ...` command to finish it.
    -   **On a project with no organization**, also create a custom OAuth client
        for IAP: Google Cloud console → **Security > Identity-Aware Proxy** →
        select the `app` service → **Custom OAuth** → *Auto-generate
        credentials*. Without it, sign-in fails with `502 "Empty OAuth client"`.
        In an organization this step is not needed (IAP uses the managed client).
    -   Finally, grant each user access — see [Adding Users](#adding-users).

Once successfully deployed, `./deploy.sh` will output the URL where Scene
Machine is available. Note this down to open it in your browser.

To help debug problems with the deployment scripts, you can change their top
line `set -eu` to `set -eux`, which will output every single command executed.

## Adding Users

[< Deployment](#deployment) • [Top](#readme-top) •
[Using Scene Machine >](#using-scene-machine)

Each person intending to use Scene Machine needs to be given the "Scene Machine
User" role in the Google Cloud project in which the tool is deployed.
`./deploy.sh`'s final summary outputs a ready-to-paste `gcloud` command for
this; you can also run it directly:

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member="user:USER_EMAIL@example.com" \
  --role="projects/$PROJECT/roles/SceneMachineUser"
```

Or grant it via the
[IAM console](https://console.cloud.google.com/iam-admin/iam) → **+ Grant
Access** → enter user email → role: **Scene Machine User** (under "Custom") →
Save.

## Using Scene Machine

[< Adding Users](#adding-users) • [Top](#readme-top) • [Caveats >](#caveats)

> [!TIP]
> For a step-by-step guide with screen recordings, see
> [`docs/walkthrough.md`](./docs/walkthrough.md).

It covers how to set up a project name and resolution, upload product images,
apply compositional Creative Templates, trim video candidates, and add custom
branding slates, transitions, audio tracks, and image overlays.

### Technical problems

In case the tool does not behave as expected, there are various ways to narrow
down the reason, though some require deep technical understanding to discover or
even fix:

-   In case of an error, a message appears with a link to a graphical view of
    the generation process. Here, red nodes indicate failures, so that clicking
    on the output connectors at the bottom of the topmost failing node might
    given an indication of what went wrong.
-   In your web browser, check for error messages of the UI: in Chrome, for
    example, use the Console view of the Developer Tools.
-   In GCP, you can use
    [Error reporting](https://console.cloud.google.com/errors) or the
    [Logs Explorer](https://console.cloud.google.com/logs/) to look for
    problems. (You may need the latter as some problems are classified as a
    warning rather than an error.)
-   In Firestore, each workflow execution has a collection named after the
    execution ID, which is prefixed by its date and time. Some debugging can
    hence take place by reviewing the content of pertinent entries in the
    database you configured (listed
    [here](https://console.cloud.google.com/firestore/databases)).
-   In Cloud Tasks, you can check if any of the used
    [queues](https://console.cloud.google.com/cloudtasks) are full.

To get more information about the inner workings of the tool, refer to the
[Developers' Guide](DEVELOPING.md).

## Caveats

[< Using Scene Machine](#using-scene-machine) • [Top](#readme-top) •
[Alternatives to Scene Machine >](#alternatives-to-scene-machine)

### Data access

All saved projects are available to all other users of the same instance of
Scene Machine.

### Potential data loss

Projects are auto-saved a few seconds after each modification, but the state of
ongoing generation processes isn't saved. So, if you navigate elsewhere or close
the browser window

-   only a few seconds after a change or
-   while a storyboard or video is being generated,

that change or generation will be lost.

### Storage accrual

By default, the tool does not delete any files from Cloud Storage: input files
are retained because you might reuse them, intermediate content is kept to save
time and cost in case the same input is processed again, and with output it's
unclear until when you might need it. To limit the cost that comes with this
accumulation, you can set up an
[object lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle) rule by
which content can be deleted based on files' relative age or absolute creation
date. Rules can be defined here:

-   https://console.cloud.google.com/storage/edit-bucket/[BUCKET_NAME]

An alternative to deletion is moving to a
[cheaper](https://cloud.google.com/storage/pricing)
[storage class](https://docs.cloud.google.com/storage/docs/storage-classes) that
comes with lower availability and a generally lower price, albeit with a
condition to store them for minimum periods.

Either option is problematic because a file's creation date says nothing about
when it was last used, and there may be input files (like for a logo overlay)
that are written once and needed 'forever'. For files larger than 128kB,
[Autoclass](https://docs.cloud.google.com/storage/docs/autoclass) (which comes
with its own little fee) can be enabled to auto-relegate objects after a period
without *use*. This can be combined with lifecycle rules to actually delete
files that were relegated.

### Quotas

A Google Cloud project has certain throughput limits defined per service and
location. Content-generation requests made more quickly than allowed by that
quota are rejected and need to be retried. Scene Machine attempts to deal with
this by assuming some default quotas and queueing tasks appropriately, the
lowest-throughput class being that for video generation. Check out the
[documentation](https://docs.cloud.google.com/vertex-ai/docs/quotas) of such
quotas to see how to change them. If you do, it would make sense to adapt the
default configuration in `deploy.sh` – just search for "queues" and change the
vaules according to the
[documentation](https://docs.cloud.google.com/tasks/docs/configuring-queues#rate)
of rate limits and retry parameters.

## Alternatives to Scene Machine

[< Caveats](#caveats) • [Top](#readme-top)

There is a vast array of tools to generate video ads automatically, ranging from
animations of static assets with
[Auto-generated video ads for Responsive Search Ads](https://support.google.com/google-ads/answer/9848688?hl=en)
to the creation of generic GenAI video using
[Flow](https://labs.google/fx/tools/flow) or
[Vids](https://docs.google.com/videos). As the capabilities of the tools and the
models they use are in continuous flux, it makes no sense to list them here.

One reason for Scene Machine to exist is for its authors to have a base from
which to derive bespoke tools for individual advertisers. The existence of
others with a similar service proposition, even if more comprehensive or better
supported, will not necessarily mean that work on this one is discontinued.
