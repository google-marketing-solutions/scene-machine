_Disclaimer: This is not an officially supported Google product._

# Scene Machine Video Generation Walkthrough

This walkthrough demonstrates how to use **Scene Machine** to leverage generative AI models for storyboard-driven video ad creation, transforming product or service images into video ads on Google Cloud Platform. Follow these step-by-step instructions to navigate the four main stages of the application: **Setup**, **Storyboard**, **Composition**, and **Output**.

> [!NOTE]
> **Prerequisites:** Before using the tool, ensure you have successfully completed the GCP setup and application deployment as described in the [README quickstart](../README.md#deployment).

## Contents
- [Step 1: Initiating a New Project from the Homepage](#step-1-initiating-a-new-project-from-the-homepage)
- [Step 2: Configuring Project Settings and Assets](#step-2-configuring-project-settings-and-assets)
- [Step 3: Uploading Product Assets and Preparing Storyboard Context](#step-3-uploading-product-assets-and-preparing-storyboard-context)
- [Step 4: Applying Creative Templates to Standardize Composition](#step-4-applying-creative-templates-to-standardize-composition)
- [Step 5: Generating and Reviewing the Visual Storyboard](#step-5-generating-and-reviewing-the-visual-storyboard)
- [Step 6: Organizing and Supplementing the Video Timeline](#step-6-organizing-and-supplementing-the-video-timeline)
- [Step 7: Generating, Reviewing, and Trimming Video Candidates](#step-7-generating-reviewing-and-trimming-video-candidates)
- [Step 8: Composing and Enhancing with Transitions, Audio, and Overlays](#step-8-composing-and-enhancing-with-transitions-audio-and-overlays)
- [Step 9: Rendering and Reviewing the Final Video Ad](#step-9-rendering-and-reviewing-the-final-video-ad)

---

## Step 1: Initiating a New Project from the Homepage
< previous step | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-2-configuring-project-settings-and-assets)
### Overview
The Homepage serves as your central dashboard for managing all Scene Machine projects. From here, you can view existing projects and initiate new ones.

> [!NOTE]
> Scene Machine projects are stored in Firebase and assets on Google Cloud Storage, scoped to your specific Google Cloud project.
> - **Permissions:** Users with access to the SM deployment can manage (create, edit, delete) all projects within that instance, including those created by others.
> - **Data Isolation:** All project data remains strictly within the hosting Google Cloud project and is not shared externally.

<video src="media/00_new_project.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **View Projects**: Your projects are displayed by default.
- **Filter Projects**: Use the `My projects only` toggle to filter out projects created by other users within your current deployment.
- **Create a Project**: Click `New Project` to start a new storyboard session.

---

## Step 2: Configuring Project Settings and Assets
[< previous step](#step-1-initiating-a-new-project-from-the-homepage) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-3-uploading-product-assets-and-preparing-storyboard-context)
### Overview
The Setup stage defines the foundational settings for your project, including aspect ratio, resolution, and generative AI parameters. From here, you can either utilize the `Generate with AI` flow (recommended) to create a storyboard automatically or choose `Manually create` to start with an empty storyboard.

The `Generate with AI` flow leverages Gemini’s multimodal capabilities to create a storyboard and corresponding prompts based on your specific requirements.

To use this flow:
- **Upload Images**: Provide at least one product image. **Tip:** You can find example assets in [media/example_assets](media/example_assets).
- **Add Details (optional)**: Enter product descriptions and specify your target audience, market, video style, and composition preferences.
- **Generate**: Scene Machine automatically sequences these inputs into a storyboard.
- **Create Video**: Once the storyboard is ready, use the Veo model to execute Image-to-Video generation.

> [!NOTE]
> **Project Settings:** Configure these parameters before generating scenes (recommended).
> - **Project Name**: Assign a descriptive name to your project.
> - **Aspect Ratio & Resolution**: Select your desired format. Note: These are locked once scenes are generated to ensure compatibility.
> - **Video Model**: Select the specific Veo model enabled for your deployment.
> - **Number of Candidates**: Define how many video variations Veo generates per scene.
> - **Candidate Duration**: Set the length (in seconds) for each generated video.
> - **Generate Audio**: Toggle to enable or disable audio generation for your scenes.

<video src="media/01_create_new_project.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Configure Settings**: Enter your Project Name, and set your desired `Aspect Ratio` and `Resolution`.
- **Select Model**: Choose the Veo Model for your deployment (we recommend fast/lite for quick demonstrations).
- **Manually Create (Optional)**: To bypass the Generate with AI flow, select `Manually create` and click Proceed to Storyboard to navigate directly to the Storyboard stage.

> [!IMPORTANT]
> Aspect ratio and resolution settings are locked once videos have been generated to ensure compatibility when rendering the final video.

---

## Step 3: Uploading Product Assets and Preparing Storyboard Context
[< previous step](#step-2-configuring-project-settings-and-assets) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-4-applying-creative-templates-to-standardize-composition)
### Overview
Upload your product or service images to begin. For this demo, we use three images of a couch as our input. Scene Machine uses these images - along with any optional descriptions - to generate a storyboard and create a sequence of video scenes. 

**Tip:** You can find example assets in [media/example_assets](media/example_assets).

<video src="media/02_upload_images.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Upload Assets**: Drag and drop your product or service images into the "Drag & drop images here" zone. **Tip:** You can find example assets in [media/example_assets](media/example_assets).
- **Add Descriptions (Optional)**: Provide additional details for your images to guide the generation process.
- **Add Details (Optional)**: Input specific information into the Audience, Market, or Style fields to help Gemini tailor the storyboard and prompts to your requirements.

> [!TIP]
> If your uploaded images do not match the project's aspect ratio, Scene Machine marks them. Later in the flow, you must choose how to proceed with these images.

---

## Step 4: Applying Creative Templates to Standardize Composition
[< previous step](#step-3-uploading-product-assets-and-preparing-storyboard-context) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-5-generating-and-reviewing-the-visual-storyboard)
### Overview
The Composition step guides the structure and flow of your storyboard. While Scene Machine generates results with minimal input, providing detailed compositional instructions ensures consistent, repeatable outcomes. Use Creative Templates to standardize your scene patterns. Scene Machine includes pre-installed templates to help you get started. 

For example, the [Single Product - 3 Scenes](../creative_templates/single_product_3_scenes.json) template structures your ad as follows:
- Scene 1: Wide Shot (Pulling In)
- Scene 2: Extreme Close-Up (Tracking Right)
- Scene 3: Medium Shot (Pulling Out)

<video src="media/03_add_description_audience_market_and_composition.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Select Template**: Choose your desired template, such as `Single Product - 3 Scenes`.
- **Generate Storyboard**: Click `Generate Storyboard` to initiate the AI generation process.
- **Open Editor (Optional)**: Click `Creative Templates` to access the template editor. Use this to create, view, update, or delete templates.

> [!TIP]
> **Template Editor:** Click `Creative Templates` to access the template editor. Use this to create, view, update, or delete templates. Use the `<- back` button to go back to the Setup stage.
> 
> Templates are shared across all users with access to your Scene Machine deployment.

---

## Step 5: Generating and Reviewing the Visual Storyboard
[< previous step](#step-4-applying-creative-templates-to-standardize-composition) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-6-organizing-and-supplementing-the-video-timeline)
### Overview
Scene Machine is now sending your inputs to Gemini to craft a cohesive visual storyboard and corresponding prompts. We included this review step so you can verify the storyboard and prompts before Veo begins video generation, as generation is billed per second for each candidate.

Review the generated storyboard. Scene Machine has mapped your input images to scene descriptions and created corresponding Veo prompts to animate them. Once you are satisfied with the sequence, proceed to video generation. (optional): When reviewing, you can make changes to the storyboard. You can edit the prompts or delete a scene from being generated.

<video src="media/04_generate_review_change_visual_storyboard.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Wait**: The generation process typically takes ~1 minute.
- **Review**: Scroll down to view the storyboard scenes and their associated prompts.
- **Edit (Optional)**: Modify the prompt text for any scene to refine the output.
- **Generate**: Click `Generate Videos` to begin the video generation process.

> [!NOTE]
> **Aspect Ratio Mismatch:** If your input images do not match the project’s aspect ratio, Scene Machine prompts you to choose an adjustment method to ensure compatibility with Veo:
> 
> - **Use as is**: Retains the original aspect ratio (the Veo model's default behavior applies).
> - **Crop**: Crops the image to the target aspect ratio, starting from the top-left.
> - **Outpaint**: Uses Nano Banana to generate an outpainted version that matches the target aspect ratio.

---

## Step 6: Organizing and Supplementing the Video Timeline
[< previous step](#step-5-generating-and-reviewing-the-visual-storyboard) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-7-generating-reviewing-and-trimming-video-candidates)
### Overview
You have arrived at the Storyboard stage, where you can generate and manage video candidates scene-by-scene. Use the central timeline to reorder scenes or click the (+) button to add new content, such as an existing end slate. Scene Machine sends video generation requests to Veo in parallel, which significantly reduces the total time required for all scenes to be generated. While a single video generation by Veo typically takes 1–3 minutes, your actual experience may vary based on your chosen model, resolution, duration, and current system load.

<video src="media/05_storyboard_drag_scenes_in_timeline.mp4" controls autoplay loop muted playsinline>
</video>
<video src="media/06_add_new_scene_from_video.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Reorder**: Drag and drop scenes directly in the timeline.
- **Add Scenes**: Click the `(+)` button to add new scenes. You can also upload existing videos, such as an end slate, to integrate them into your project. **Tip:** You can find example assets in [media/example_assets](media/example_assets).

> [!NOTE]
> Concurrent requests are processed via Cloud Tasks queue settings, meaning requests run in parallel to significantly decrease overall generation time.

---

## Step 7: Generating, Reviewing, and Trimming Video Candidates
[< previous step](#step-6-organizing-and-supplementing-the-video-timeline) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-8-composing-and-enhancing-with-transitions-audio-and-overlays)
### Overview
Let’s examine a specific scene. On the left, you will see a list of candidate videos generated by Veo. Hover over any candidate to preview it at 2x speed without sound. Click a candidate to load it in the central workspace for detailed review and trimming. 

**Note** All generated candidates are immutable. When you select a candidate, Scene Machine loads the prompt and settings used for its creation. You can update these parameters and click `Generate Candidates` to create a new run of variations in the left panel; your original candidate remains unchanged. 

Generation typically takes 1–3 minutes, but you can navigate to different scenes to continue working effectively while the generation runs. Once you find your preferred candidate, click it in the left panel to set it as the final scene video. 


<video src="media/08_generate_candidates.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Preview**: Hover over a candidate to view a quick preview at 2x speed without sound.
- **Review & Trim**: Click a candidate to play it in the central view. Use the trim controls in the video timeline to adjust the duration.
- **Iterate**: Modify the prompt and click `Generate Candidates`. Set your desired number of candidates and run the generation again.
- **Set as Scene Candidate**: Click your preferred candidate in the left panel to set it as the scene video.
- **Proceed**: Click `Compose` in the left navigation panel once all scenes are finalized.



> [!NOTE]
> **Trimming Candidates (Optional):** You can trim your candidates using the video timeline. Drag the handles, or use the `Trim start` and `Trim end` fields and controls to set precise timestamps.
> 
> <video src="media/07_trim_candidate.mp4" controls autoplay loop muted playsinline></video>
---

## Step 8: Composing and Enhancing with Transitions, Audio, and Overlays
[< previous step](#step-7-generating-reviewing-and-trimming-video-candidates) | [Top](#scene-machine-video-generation-walkthrough) | [next step >](#step-9-rendering-and-reviewing-the-final-video-ad)
### Overview
Once your storyboard scenes are finalized, proceed to the Compose stage to assemble your full video. If you do not select a specific candidate for a scene, Scene Machine defaults to the first one. Use the central workspace to preview the full sequence; if you need to reorder scenes or adjust trimming, return to the Storyboard stage. Enhance your video by adding transitions between scenes, custom audio tracks, and visual overlays. Please note that these additions do not have a live preview in this view; you must click Render Video to combine and review the final result.

> [!NOTE]
> - **Transitions**: Review available options on the [FFmpeg xfade wiki (external link)](https://trac.ffmpeg.org/wiki/Xfade).
> - **Audio Tracks**: Add multiple files and specify exact start and end times.
>   - *Tip:* Click inside the `Start Time` or `End Time` fields to select a specific scene's start time as your timestamp. To play audio for the duration of a specific scene, select that scene for both the start and end times.
> - **Visual Overlays**: Upload images or GIFs, specify their visibility duration, and set their position in pixels from the top-left.
> - **Demo Assets**: Need demo assets? You can find them in [media/example_assets](media/example_assets).

<video src="media/09_compose_transitions_audio_track_overlays_render_video.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Add Transitions**: Click the `(+)` icon between scenes in the timeline and select a transition (e.g., Fade Black).
- **Add Assets**: Use the right-side menu to open the `Add Audio Track` and `Add Image Overlay` modals. **Tip:** You can find example audio files in [media/example_assets](media/example_assets).
- **Render**: Click `Render Video` on the right-side menu and wait 30-60 seconds.
- **Proceed**: Once the Output stage icon displays a (1) bubble, click `Output` to view your final video.

---

## Step 9: Rendering and Reviewing the Final Video Ad
[< previous step](#step-8-composing-and-enhancing-with-transitions-audio-and-overlays) | [Top](#scene-machine-video-generation-walkthrough) | next step >
### Overview
In the Output stage, review your final rendered video, which incorporates all scenes, transitions, audio, and overlays. 

The right-side panel displays a history of all your rendered versions. If you make adjustments in the Compose or Storyboard stages and re-render, Scene Machine saves a new entry to this list. 

You can also download the full video or individual scenes as MP4 files for post-production or external use. 

This concludes the Scene Machine demo.
Thank you!

<video src="media/10_output_review_rendered_video.mp4" controls autoplay loop muted playsinline>
</video>

### Actions:
- **Play**: Play the rendered video in the central view.
- **Download**: Download the full video or individual scenes as MP4 files.

---

## Next Steps
- Refer to the [Technical Requirements](../README.md#technical-requirements) section in the README for a general start.
- See the [Deployment](../README.md#deployment) section in the README for how to deploy Scene Machine.
- Read the [Developers' Guide](../DEVELOPING.md) to understand the Scene Machine backend.
- Check the [Caveats](../README.md#caveats) section in the README for important considerations.

[< previous step](#step-8-composing-and-enhancing-with-transitions-audio-and-overlays) | [Top](#scene-machine-video-generation-walkthrough) | [go to readme >](../README.md)


[def]: #step-1-initiating-a-new-project-from-the-homepage