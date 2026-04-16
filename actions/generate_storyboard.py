# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Generates storyboard video prompts directly from images and a brief."""

from __future__ import annotations

import dataclasses
import json
import time

from google import genai

from actions_lib.gemini import get_mime_type
from common import ContentType
from common import Dimension
from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS


@dataclasses.dataclass
class Image:
  """Represents an image asset.

  Attributes:
    id: Unique identifier for the image.
    uri: GCS URI of the image.
  """

  id: str
  uri: str


@dataclasses.dataclass
class Product:
  """Represents a product information for which the images are uploaded.

  Attributes:
    id: Unique identifier for the product.
    description: Optional description of the product.
    images: List of images associated with the product.
  """

  id: str
  description: str = ""
  images: list[Image] = dataclasses.field(default_factory=list)


response_schema = {
  "type": "object",
  "properties": {
    "storyboard": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          Dimension.IMAGE_ID.value: {
            "type": "string",
            "description": (
              "User provided image id. Match image_id from input."
            ),
          },
          Dimension.PRODUCT_ID.value: {
            "type": "string",
            "description": (
              "User provided product id. Match product_id from"
              " input."
            ),
          },
          "scene_name": {
            "type": "string",
            "description": (
              "The short, but descriptive name of the scene."
            ),
          },
          "video_prompt": {
            "type": "string",
            "description": (
              "Describe the scene in as much detail as possible,"
              " but keep it concise. You MUST format your"
              " response as a strictly patterned markdown list."
              " Use actual newline characters between list"
              " items.\n\nFollow this EXACT template:\n-"
              " **Cinematography:** <definition>\n- **Subject:**"
              " <definition>\n- **Action:** <definition>\n-"
              " **Context:** <definition>\n- **Style &"
              " ambiance:** <definition>\n- **Audio:**"
              " <definition, or leave blank>\n- **Other:**"
              " <definition, or leave blank>"
            ),
          },
        },
        "required": [
          Dimension.IMAGE_ID.value,
          Dimension.PRODUCT_ID.value,
          "scene_name",
          "video_prompt",
        ],
      },
    }
  },
  "required": ["storyboard"],
}


def generate_system_prompt(min_scenes: int = 1, max_scenes: int = 3) -> str:
  """Return a system prompt for the generate_storyboard action.

  Returns a system prompt that includes min and max number of scenes to be
  generated in case the user hasn't provided any other indication in their
  prompt. The min number of scenes is determined by the number of products
  (assumption: we should have at least as many scenes as there are products)
  and the max number of scenes is determined by the number of images provided
  (assumption: we should have at most as many scenes as there are images).

  Args:
    min_scenes: Minimum number of scenes to generate.
    max_scenes: Maximum number of scenes to generate.

  Returns:
    A system prompt for the generate_storyboard action.
  """
  return f"""
# The Unified Creative Director Prompt

## Persona

You are a **Senior Performance Creative Lead and Cinematographer**. Your
specialty is high-conversion digital advertising videos.
You are tasked with translating raw assets into a high-precision,
multi-scene script that "stops the scroll" and drives action. You excel at
technical camera direction and cohesive storytelling.

The Framework: Every scene description MUST follow this mandatory formula:
[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]

    - Cinematography: Define shot type (e.g., ECU, MCU, Wide), angle, and
        explicit movement (e.g. "Pan-right", "Fast Dolly-in", "Handheld shake").
    - Subject: The focal point (product, person, or specific detail).
    - Action: What is happening? (e.g. "Slicing the fruit", "Smiling at
        camera").
    - Context: The environment and background.
    - Style & Ambiance: The aesthetic, lighting, and "vibe."
    - Audio: Describe the audio that should accompany the scene (**only** when
        relevant to the scene)
    - Other: Any other details that are relevant to the scene, but don't fit
        into any of the above categories (e.g. overaching style of the story,
        any explicit restrictions like "no humans", etc.).

## Instructions

### Inputs

You will be given the following to inputs to guide your creative direction:

1. Products: Products that need to be advertised. If only a single
    product is provided, you can assume it is the main product **or**
    there is no specific product (e.g. if the product is a service). If
    multiple products are provided, you can assume they are all equally
    important.
    1. [Optional] Description: Description of the advertised product or
        service (e.g. USPs).
    1. List of (product) images: Images that **have to be used** as
        reference for scenes. The images are part of "product", and can
        depict products, people, environments, etc. One image needs to
        be used per scene! If no images are provided, you can assume
        there are no images to use.
1. [Optional] User Prompt: A prompt provided optionally by the user. If one
    is provided, you **must** adhere to it above any other instruction.
    1. [Optional] Ad Description: Description of the overall ad video such
        as overall look and feel, audience, any special features or anything
        to **not** include. If an ad description is provided, you **must**
        adhere to it above any other instruction.
    1. [Optional] Composition Description: Description of the composition
        of the ad video. If a composition description is provided, you
        **must** adhere to it when it **specifically** comes to scene
        construction (number of scenes to generate, shots, lighting etc.)

### Negative Prompts

Please include any negative prompts that are provided by the user or are
otherwise relevant. Some examples include:
    - No Disappearing Elements: Ensure all objects, especially structural elements
      like buildings, cables, or landscape features, remain fully visible and stable
      throughout the entire scene. Nothing should fade, disappear, or pop out of
      existence, particularly near the end of a shot.
    - Anatomical Integrity: Human figures must be anatomically correct and consistent.
      Pay close attention to hands, legs, and faces. These body parts must not become
      blurry, distorted, transparent, unnaturally thin, or pass through other objects
      or body parts. Movement should not cause anatomical features to degrade.
    - Object & Wardrobe Consistency: Objects and clothing (e.g., hats, jackets) must
      not change shape, color, or style within a single scene.
    - No Spontaneous Generation: Elements (like animals or objects) must not appear or
      disappear from thin air. Their presence must be logical within the scene's
      continuity.
    - Avoid Uncanny Valley: Human actions and expressions must appear natural and
      candid. Avoid synchronized movements (like two people turning their heads at
      the same time), prolonged or direct staring at the camera, and any robotic or
      unsettling behavior. If a scene's description could lead to an uncanny result,
      prioritize a more subtle and natural interpretation.
    - Realistic Water and Food: Water must appear natural; focus on subtle ripples
      or gentle currents, avoiding a plastic or overly smooth look. Food items should
      look authentic and appetizing, not synthetic, glossy, or unnaturally perfect.
    - Pacing of Movement: All camera and subject motion must be contained within the
      scene's duration. The movement should begin a moment after the scene starts and
      conclude a moment before it ends. This avoids abrupt motion at the very
      beginning or end of a clip, ensuring a smoother, more cinematic feel. For
      instance, a moving pizza should start its motion after the clip begins, not
      immediately at the start.


### Output

You **must** adhere to the provided output schema, and **not** generate
anything besides that. Unless the user prompt specifies how many scenes to
generate, you should generate {min_scenes} to {max_scenes}
scenes based on the number of products and images provided.

#### Preferences

When specifying the type of a shot, prefer one of the following:
Establishing shot, Reaction shot, POV shot, Montage sequence, Cutaway shot, Fade in,
Fade out, Fast cuts, Slow cuts, Long shot duration, Short shot duration, Eye-level shot,
Subjective camera, Objective camera.

When specifying framing and composition of a shot, prefer one of the following: Wide shot,
Medium shot, Close-up, Extreme close-up, Cowboy shot, Over-the-shoulder shot,
Bird's-eye view, Low-angle shot, Rule of thirds composition, subject on the left,
Rule of thirds composition, subject on the right, Leading lines composition,
Symmetrical composition, Shallow depth of field, Deep depth of field, Blurred background,
Hard light, Soft light, Backlighting,

When specifying the movement of camera, prefer one of the following: Pan left, Pan right,
Tilt up, Tilt down, Zoom in, Zoom out, Tracking shot, Crane shot, Handheld camera style,
Slow pan, Fast pan.
"""


def execute(
    gcs: GCS,
    workflow_params: Params,
    images: NodeInput,
    user_prompt: NodeInput,
    gemini_model: str,
    gemini_model_location: str,
) -> NodeOutput:
  """Executes the generate_storyboard action in order to generate storyboard.

  Args:
    gcs: The GCS client.
    workflow_params: Workflow parameters.
    images: Input images.
    user_prompt: User prompt.
    gemini_model: The Gemini model to use.
    gemini_model_location: The model's location.

  Returns:
    A NodeOutput object containing the storyboard.
  """

  user_prompt_text = None
  if user_prompt:
    user_prompt_text = gcs.load_text(user_prompt[0][Key.FILE.value])

  # Parts that will make up the final prompt.
  prompt_parts = []

  # Group images by product ID to build context
  products: dict[str, Product] = {}

  for img_obj in images:
    product_id = str(img_obj.get(Dimension.PRODUCT_ID.value, "1"))
    product_description = str(img_obj.get("product_description", None))
    if product_id not in products:
      products[product_id] = Product(product_id, product_description)

    product = products[product_id]
    image = Image(
        id=str(img_obj.get(Dimension.IMAGE_ID.value, "1")),
        uri=gcs.get_uri(img_obj[Key.FILE.value]),
    )
    product.images.append(image)

  # Add products and images
  prompt_parts.append(genai.types.Part.from_text(text="### Products & Images:\n\n"))
  for product in products.values():

    prompt_parts.append(
        genai.types.Part.from_text(text=f"#### product_id: '{product.id}'\n\n")
    )
    if product.description:
      prompt_parts.append(
          genai.types.Part.from_text(
              text=f"**Product description:** '{product.description}'\n\n"
          )
      )
    if product.images:
      prompt_parts.append(
          genai.types.Part.from_text(text="**Images:**\n\n")
      )
    for image in product.images:
      prompt_parts.append(
          genai.types.Part.from_text(text=f"- image_id: '{image.id}'\n")
      )
      prompt_parts.append(
          genai.types.Part.from_uri(
              file_uri=image.uri,
              mime_type=get_mime_type(image.uri),
          )
      )
      prompt_parts.append(genai.types.Part.from_text(text="\n\n"))

  # Add user prompt.
  if user_prompt_text:
    prompt_parts.append(
        genai.types.Part.from_text(text="### User Prompt:\n\n")
    )
    prompt_parts.append(genai.types.Part.from_text(text=user_prompt_text))

  client = genai.Client(
      vertexai=True,
      project=workflow_params[Key.GCP_PROJECT.value],
      location=gemini_model_location,
  )

  config = genai.types.GenerateContentConfig(
      system_instruction=generate_system_prompt(
          len(products.keys()), len(images)
      ),
      temperature=0.7,
      top_p=0.2,
      response_schema=response_schema,
      response_mime_type=ContentType.JSON.value,
      safety_settings=[
          genai.types.SafetySetting(
              category=genai.types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
              threshold=genai.types.HarmBlockThreshold.OFF,
          ),
          genai.types.SafetySetting(
              category=genai.types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
              threshold=genai.types.HarmBlockThreshold.OFF,
          ),
          genai.types.SafetySetting(
              category=genai.types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
              threshold=genai.types.HarmBlockThreshold.OFF,
          ),
          genai.types.SafetySetting(
              category=genai.types.HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold=genai.types.HarmBlockThreshold.OFF,
          ),
      ],
  )

  start_time = time.time()
  response = client.models.generate_content(
      model=gemini_model,
      contents=prompt_parts,
      config=config,
  )
  end_time = time.time()
  logger.info(
      "Gemini API request completed in %.2f seconds.", end_time - start_time
  )

  segments = []
  if (
      response.candidates
      and response.candidates[0].content
      and response.candidates[0].content.parts
  ):
    parts = list(response.candidates[0].content.parts)
    for part in parts:
      if hasattr(part, "text"):
        segments.append(part.text)
  json_result = json.loads("".join(segments))

  if not json_result.get("storyboard"):
    raise ValueError("No storyboard found in the response.")

  valid_scenes = []

  for scene in json_result["storyboard"]:
    image_id = scene.get(Dimension.IMAGE_ID.value)
    product_id = scene.get(Dimension.PRODUCT_ID.value)
    video_prompt = scene.get("video_prompt")
    scene_name = scene.get("scene_name")
    if not image_id or not product_id or not video_prompt or not scene_name:
      continue
    valid_scenes.append(
        {
            Dimension.IMAGE_ID.value: image_id,
            Dimension.PRODUCT_ID.value: product_id,
            "video_prompt": video_prompt,
            "scene_name": scene_name,
        }
    )
  file_path = gcs.store(
      json.dumps({"storyboard": valid_scenes}),
      "storyboard.json",
      ContentType.JSON.value,
  )

  return {"storyboard": [{Key.FILE.value: file_path}]}
