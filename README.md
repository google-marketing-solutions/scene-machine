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

_Disclaimer: This is not an officially supported Google product._

# ⚠️ Don't use – code is still being populated.

# Scene Machine

**Scene Machine** is a tool allowing the creation of ad videos from product images: in a graphical interface, the user is guided through the following steps:

1. upload of product images
2. generation of a suitable sequence of scenes
3. generation of those individual scenes
4. composition of the complete ad video with superimposed logos, background music etc.

In the generation steps, the user has full control, but can also rely on the tool's recommendations.

[Technical Requirements](#requirements) •
[Deployment](#deployment) •
[Using Scene Machine](#using-scene-machine) •
[Alternatives](#alternatives) •
[Developers' Guide](DEVELOPING.md)

## Technical Requirements

To deploy this application, you need a **project on Google Cloud Platform without any existing App Engine apps**.

- Scene Machine's user interface is implemented as an Angular/TypeScript application running on App Engine.
- The actual processing is performed by **Remix Engine**, a modular Python application on Cloud Run. See the [Developers' Guide](DEVELOPING.md) for details.

Scene Machine sends workflow definitions to Remix Engine, which orchestrates its functional modules (e.g. turning images into videos) and reports back on results.

## Deployment

#### Prerequisites

- **Google Cloud Project**: A project on Google Cloud Platform **with billing enabled** and ideally without any existing App Engine apps. _(Note: If an App Engine app already exists, deployment will proceed but will overwrite the `default` service, and you will not be able to change the region.)_
- **Permissions**: We recommend having the **Project Owner** role on the Google Cloud project to conduct the deployment successfully.
- **Node.js**: Ensure you have [Node.js](https://nodejs.org/en/download) (≥v22) installed.
- **Git**: Ensure you have `git` installed.
- **Google Cloud SDK (gcloud)**: Ensure you have the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed and initialized.
- **Firebase Tools**: Install with `npm i -g firebase-tools`.
- **Firebase Login**: Run `firebase login` to authenticate before beginning deployment.
- **envsubst**: Ensure you have `envsubst` installed (typically via the `gettext` package, e.g., `sudo apt-get install gettext` on Debian/Ubuntu, `brew install gettext` on macOS).

#### Step-by-Step Deployment

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/google-marketing-solutions/scene-machine
    cd scene-machine
    ```

2.  **Configure the Application**
    - Create `config.txt` from the template:
      ```bash
      cp config.template.txt config.txt
      ```
    - Edit `config.txt` in your favorite editor (e.g., `nano config.txt`).

    **Variables defined in `config.txt`:**

    | Variable Name          | Description                                                | Recommended Values / Notes                           |
    | :--------------------- | :--------------------------------------------------------- | :--------------------------------------------------- |
    | `PROJECT`              | Your Google Cloud Platform Project ID.                     | Required                                             |
    | `REGION`               | Deployment region for various GCP resources.               | e.g., `us-central1`                                  |
    | `GEMINI_MODEL`         | Text generation model for prompts and analysis.            | `gemini-2.5-pro`, `gemini-3.1-pro-preview`           |
    | `GEMINI_REGION`        | Region for model invocation.                               | Check locations availability. Recommended `global`.  |
    | `VEO_MODEL`            | Video generation model.                                    | `veo-3.1-generate-001`                               |
    | `VEO_REGION`           | Region for Veo model invocation.                           | Check availability. Recommended `global`.            |
    | `OUTPAINTER_MODEL`     | Image outpainting model for borders or fill.               | `gemini-2.5-flash-image`                             |
    | `OUTPAINTER_REGION`    | Region for outpainter model.                               | Check availability. Recommended `global`.            |
    | `API_GATEWAY_REGION`   | Region for API Gateway deployment.                         | Supported: `us-central1`, `europe-west1`, etc.       |
    | `APP_ENGINE_REGION`    | Region for App Engine application.                         | Supported locations listed in config.                |
    | `GCS_BUCKET`           | Storage bucket name for storing project images and assets. | Must be globally unique. Auto-generated by default.  |
    | `FIRESTORE_DB`         | Firestore database ID used by the backend modules.         | Defaults to `scene-machine`.                         |
    | `FIRESTORE_DB_UI`      | Firestore database ID used by the user interface.          | Defaults to `scene-machine-ui`.                      |
    | `ARTIFACT_REPO`        | Artifact Repository ID to store artifacts.                 | Defaults to `scene-machine`.                         |
    | `API_GATEWAY`          | API Gateway ID for the application endpoint.               | Defaults to `scenemachine-api-gateway`.              |
    | `TASKS_QUEUE_PREFIX`   | Prefix for Cloud Task queue names.                         | Max lengths apply. Support letters, hyphen, numbers. |
    | `BACKEND_SERVICE_NAME` | Service name for the application backend on GCP.           | Defaults to `remix-engine-backend`.                  |
    - **Important Notes for Configuration:**
      - **Naming:** Use alphanumerical names (with hyphens) for entities like databases.
      - **Storage:** If using an existing bucket, it must use a non-hierarchical namespace.
      - **Locations:** Match model availability (e.g. Veo might not be available in all regions). Check [Google Cloud AI Platform documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations) for locations.
      - **Model Lifespans:** Prefer using current models as older ones are discontinued over time. Check [Google Cloud AI Platform documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/models) for model lifespans.

3.  **Execute Deployment**
    - Run the main deployment script:
      ```bash
      ./deploy.sh
      ```
    - _Note: The script outputs estimates regarding run times._
    - _Note: You might be prompted to run the UI deployment script immediately at the end._

    > [!TIP]
    > **Troubleshooting Firebase deployment failures:**
    > If `./deploy.sh` fails at the Firebase step with an error like `Error: Project not found`, it usually means the Firebase CLI cannot access the project or terms have not been accepted.
    > 
    > **How to fix it:**
    > 1. **Check Login:** Ensure you are logged in by running `firebase login` in your terminal.
    > 2. **Manual Fallback (Accept Terms):** If still failing, go to the [Firebase Console](https://console.firebase.google.com/).
    > 3. Click **Add Project** and select your existing Google Cloud project from the dropdown list.
    > 4. Follow the prompts to add Firebase resources. This process will guide you through accepting the necessary terms of service.
    > 5. Once completed in the console, return to your terminal and re-run `./deploy.sh`.

4.  **Set up OAuth consent screen:**
    - In your Google Cloud console, go to **API & Services > Credentials > OAuth consent screen**.
    - Click **Get Started**.
    - Follow the steps to configure the consent screen. Choose a name for the application you're creating, e.g. Scene Machine.
    - You can choose **Internal** for the User Type if only users from your organization will use the app.

5.  **Add Firebase Sign-In Provider**
    - Go to the [Firebase console](https://console.firebase.google.com/), select your project then click **Authentication > Sign-in method**.
    - Click **Add new provider**, choose **Google** then enable and save it.

6.  **Deploy UI**
    - Run `./deploy-ui.sh` (if you skipped it during backend deployment).
    - If requested, perform any required manual steps indicated by the script (e.g. linking buckets or configuring OAuth).

7.  **Set up Identity-Aware Proxy**:
    - In the [App Engine settings](https://console.cloud.google.com/appengine/settings?serviceId=default), under "Identity-Aware Proxy" select "Configure Now".
    - Turn on Identity-Aware Proxy for "App Engine app".
    - In the ⋮ menu, select "Settings", then "Custom OAuth", then "Auto-generate credentials".

Once successfully deployed, `./deploy-ui.sh` will output the URL where Scene Machine is available. Note this down to open it in your browser.

To help debug problems with the deployment scripts, you can change their top line `set -eu` to `set -eux`, which will output every single command executed.

## Adding Users

Each person intending to use Scene Machine needs to be given the "Remix Engine user" role in the Google Cloud project in which the tool is deployed.

## Using Scene Machine

Scene Machine is started by calling the web address that the deployment script outputs. On the first page, the user can deal with _Projects_ or _Creative Templates_:

- Projects are the main container for turning images into videos. They can be deleted here directly, while creating or loading an existing one moves to the other views described below.
- Creative Templates contain instructions how to derive a storyboard from images. The view to manage those allows their viewing, creation and editing.

### Setup

In the Setup step, the user can do the following:

- At the top, name the project and configure parameters, like the desired aspect ratio for the videos to be generated. These can be left at their defaults. Note that the aspect ratio cannot be changed if videos already exist in the project.
- Below, define the input to be used for the automatic storyboard generation. The types of input should be self-explanatory. Alternatively, selecting _Manually create_ omits the generation, directly skipping to the _Storyboard_ step.

Once _Generate Storyboard_ is clicked, the uploaded images are analysed for how they match the configured aspect ratio, and the user may be asked how to deal with drastic deviations: the main options are:

- _Crop_: symmetrically cut the shorter sides of the images
- _Outpaint_: symmetrically add at the longer sides of the images
- _Use as is_: essentially leave it up to the Video model, which can have different results every time

#### Review Storyboard

If/once everything is fine or confirmed, a storyboard suggestion is derived from the input, which may take in the order of a minute.

Once ready, the user is shown a storyboard showing the proposed scenes in terms of their starting images (potentially modified to suit the aspect ratio) and the planned animation prompt, or script. They can discard the whole board (and retry with changed inputs), delete individual scenes or edit the prompts.

Once they are happy with the proposal, they can click _Generate Videos_ to proceed to the next step. This will remove any existing scenes, should some have been generated already.

### Storyboard

In this view, the user needs to wait for the generation of the videos, but can already change the order of the scenes or add new ones – especially if they skipped here by opting to _Manually create_ at the _Setup_ step.

The scenes can be optionally re-generated (_Generate Candidates_) with changed prompt or parameters, and the version to be used can be selected. Obsolete versions can be 'archived' to avoid visual clutter.

#### Trimming

To omit parts of a scene video near its beginning and/or end, you can specify times at which it should start or end, respectively. These can be manually entered into the respective boxes, or determined as follows:

1. Play the video until (or, in the progress bar, click on) the point in time at which the desired part starts or ends.
2. Click on the corresponding clock symbol for the start or end time, respectively.

It is okay to select both times, only one, or none. You can remove a trim marker simply by deleting the contents of the text field showing the time index.

Once satisfied with the result, the user can move to the next view:

### Composition

This shows a preview of how the (potentially trimmed) scenes would appear in sequence. The video player essentially jumps from scene to scene, so it may stutter a bit.

This view also serves to add

- non-generative video scenes (like an outro),
- audio tracks (like music or voice-overs),
- visual overlays (like logos) and
- transitions between the scenes (e.g. fading).

Each addition may have its own parameters and dialog. Note that the time index at which you are positioning audio or overlays will not be automatically updated when you change the scenes, their ordering or their transitions, and should hence always be corrected as the last step.

The additional elements are not currently part of the preview, so to see their effect – or simply get the actual video without any such additions –, the user needs to click _Render Video_.

### Output

Here, the rendered video appears to be viewed or downloaded. It is also possible to watch older renderings, and download the videos constituent scenes.

### Technical problems

In case the tool does not behave as expected, there are various ways to narrow down the reason, though some require deep technical understanding to discover or even fix:

- In case of an error, a message appears with a link to a graphical view of the generation process. Here, red nodes indicate failures, so that clicking on the output connectors at the bottom of the topmost failing node might given an indication of what went wrong.
- In your web browser, check for error messages of the UI: in Chrome, for example, use the Console view of the Developer Tools.
- In GCP, you can use [Error reporting](https://console.cloud.google.com/errors) or the [Logs Explorer](https://console.cloud.google.com/logs/) to look for problems. (You may need the latter as some problems are classified as a warning rather than an error.)
- In Firestore, each workflow execution has a collection named after the execution ID, which is prefixed by its date and time. Some debugging can hence take place by reviewing the content of pertinent entries in the database you configured (listed [here](https://console.cloud.google.com/firestore/databases)).
- In Cloud Tasks, you can check if any of the used [queues](https://console.cloud.google.com/cloudtasks) are full.

To get more information about the inner workings of the tool, refer to the [Developers' Guide](DEVELOPING.md).

## Caveats

### Data access

All saved projects are available to all other users of the same instance of Scene Machine.

### Potential data loss

Projects are auto-saved a few seconds after each modification, but the state of ongoing generation processes isn't saved. So, if you navigate elsewhere or close the browser window

- only a few seconds after a change or
- while a storyboard or video is being generated,

that change or generation will be lost.

### Storage accrual

By default, the tool does not delete any files from Cloud Storage: input files are retained because you might reuse them, intermediate content is kept to save time and cost in case the same input is processed again, and with output it's unclear until when you might need it. To limit the cost that comes with this accumulation, you can set up an [object lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle) rule by which content can be deleted based on files' relative age or absolute creation date. Rules can be defined here:

- https://console.cloud.google.com/storage/edit-bucket/[BUCKET_NAME]

An alternative to deletion is moving to a [cheaper](https://cloud.google.com/storage/pricing) [storage class](https://docs.cloud.google.com/storage/docs/storage-classes) that comes with lower availability and a generally lower price, albeit with a condition to store them for minimum periods.

Either option is problematic because a file's creation date says nothing about when it was last used, and there may be input files (like for a logo overlay) that are written once and needed 'forever'. For files larger than 128kB, [Autoclass](https://docs.cloud.google.com/storage/docs/autoclass) (which comes with its own little fee) can be enabled to auto-relegate objects after a period without _use_. This can be combined with lifecycle rules to actually delete files that were relegated.

### Quotas

A Google Cloud project has certain throughput limits defined per service and location. Content-generation requests made more quickly than allowed by that quota are rejected and need to be retried. Scene Machine attempts to deal with this by assuming some default quotas and queueing tasks appropriately, the lowest-throughput class being that for video generation. Check out the [documentation](https://docs.cloud.google.com/vertex-ai/docs/quotas) of such quotas to see how to change them. If you do, it would make sense to adapt the default configuration in `deploy.sh` – just search for "queues" and change the vaules according to the [documentation](https://docs.cloud.google.com/tasks/docs/configuring-queues#rate) of rate limits and retry parameters.

## Alternatives to Scene Machine

There is a vast array of tools to generate video ads automatically, ranging from animations of static assets with [Auto-generated video ads for Responsive Search Ads](https://support.google.com/google-ads/answer/9848688?hl=en) to the creation of generic GenAI video using [Flow](https://labs.google/fx/tools/flow) or [Vids](https://docs.google.com/videos). As the capabilities of the tools and the models they use are in continuous flux, it makes no sense to list them here.

One reason for Scene Machine to exist is for its authors to have a base from which to derive bespoke tools for individual advertisers. The existence of others with a similar service proposition, even if more comprehensive or better supported, will not necessarily mean that work on this one is discontinued.
