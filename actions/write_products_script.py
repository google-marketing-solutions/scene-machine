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

"""Writes a video script to present the given products."""

from __future__ import annotations
import json
import typing
from typing import Any

from actions_lib import gemini
from common import ContentType
from common import Dimension
from common import Key
from common import logger
from common import NodeInput
from common import NodeOutput
from common import Params
from util.gcs_wrapper import GCS

PROMPT_OVERWRITE = "SYSTEM_PROMPT_OVERWRITE"


def execute(
    gcs: GCS,
    workflow_params: Params,
    briefing: NodeInput,
    product_description: NodeInput,
    image_description: NodeInput,
    story_variant_quantity: int,
    gemini_model: str,
    gemini_model_location: str,
) -> NodeOutput:
  """Executes the action in order to generate a video script.

  Args:
    gcs: The GCS client.
    workflow_params: Workflow parameters.
    briefing: The style briefing.
    product_description: The product descriptions.
    image_description: The image descriptions.
    story_variant_quantity: The number of variants to generate.
    gemini_model: The Gemini model to use.
    gemini_model_location: The model's location.

  Returns:
    A NodeOutput object containing the ad script.

  Raises:
    RuntimeError: For repeated invalid outputs.
  """
  briefing_text = (
      gcs.load_text(briefing[0][Key.FILE.value])
      if briefing
      else "Show the product(s) in an appropriate way"
  )
  if briefing_text.startswith(PROMPT_OVERWRITE):
    text_prompt = briefing_text[len(PROMPT_OVERWRITE) :]
  else:
    text_prompt = f"""
You are a highly skilled Creative Director and Scriptwriter. Your task is to write a full script for a short ad (e.g., 30-60 seconds total), based on the provided inputs. The script will consist of multiple sequential "Detailed Draft Scene Descriptions."

**Your Goal:**
Generate a sequence of DETAILED draft scene descriptions that form a cohesive and compelling visual narrative for the ad. Each description should be rich enough for a director to visualize the shot, including specific cues for camera work, composition, and mood.

**Inputs You Will Use:**

#GENERAL_BRIEFING#:
    (This defines the ad's objective, target audience, key message, and the product(s) to be featured.)
{briefing_text}

**Key Instructions for Generating DETAILED Draft Scene Descriptions:**

1.  **Overall Ad Concept (Internal Thought Process):**
    * **Core Narrative Arc:** Based on the `#GENERAL_BRIEFING#`, conceptualize a simple, relatable story or theme for the entire ad.
    * **Human Interaction Strategy:** Decide if and how people will be featured, aligning with the products and `#GENERAL_BRIEFING#`.
    * **Scene Sequence Outline:** Mentally outline a sequence of scenes using principles like: Intrigue & Detail, Product in Action/Context & Benefit, (Optional) Branding, and CTA/Lasting Impression. Ensure a logical flow between scenes, considering how camera movements might transition or contrast.

2.  **For EACH Scene in Your Outline, Write a DETAILED Draft Scene Description Including:**

    * **Scene Setting & Core Subject(s):** Clearly describe the environment and the main subject(s) of the scene (product, person, etc.), drawing details from `#PRODUCT_IMAGE_DESCRIPTIONS#` and `#PRODUCT_DETAILS#`.
    * **Key Action(s):** What is the subject doing? What is happening in the scene?
    * **Specific Camera Shot Type/Framing:** Define the composition (e.g., Extreme Close-Up (ECU) on product texture, Medium Shot (MS) of a person using the product, Wide Shot (WS) of the environment, Point-of-View (POV) shot).
    * **Specific Camera Movement:** Describe the camera's movement clearly (e.g., "Static shot," "Slow pan left to reveal...", "Gentle track-in towards the subject," "Pedestal up to show product height," "Dynamic orbiting shot around the product," "Drone shot flying smoothly forward over landscape," "Subtle handheld feel for realism"). *Consider how this movement connects to the previous or next scene.*
    * **Lighting Style & Ambiance Cues:** Describe the desired lighting and mood (e.g., "Bright, natural morning light," "Warm golden hour glow," "Moody, low-key lighting with deep shadows," "Vibrant and energetic with colorful highlights," "Serene and minimalist").
    * **Pacing Indication (Optional):** Note if the scene should feel quick, lingering, energetic, calm, etc.
    * **Audio/Sound Cues (Optional, for context only, will be stripped by Veo optimizer):** Briefly mention key sounds if they are integral to understanding the action or mood (e.g., "sound of gentle waves," "upbeat music starts"). *Acknowledge these are for directorial context and not for Veo.*


**Example of ONE Detailed Draft Scene Description (Illustrative):**

*(This is NOT part of your output, just an example)*
"INT. COZY CAFE - MORNING. A steaming ceramic mug of ARTISANAL COFFEE (Product ID: C001) sits on a rustic wooden table, beside a half-read book. Bright, natural morning light streams through a large window, illuminating the rich brown liquid and delicate latte art. MEDIUM SHOT, initially static, focusing on the coffee mug. After a beat, the camera performs a very SLOW PUSH-IN towards the mug, subtly increasing focus on the intricate latte art and the rising steam. The ambiance is calm, warm, and inviting.
**Output Requirements:**

* Provide the final script as a sequence of these "Detailed Draft Scene Descriptions."
* Each scene description should be its own paragraph.
* Do NOT include scene numbers (e.g., "Scene 1:").
* Do NOT include any explanations, preambles, titles, or any text other than the detailed scene descriptions themselves, one after another.
"""
  product_descriptions_map = {
      pd[Dimension.PRODUCT_ID.value]: gcs.load_text(pd[Key.FILE.value])
      for pd in product_description
  }
  products = {}
  for image_desc_obj in image_description:
    product_id = str(image_desc_obj[Dimension.PRODUCT_ID.value])
    image_id = str(image_desc_obj[Dimension.IMAGE_ID.value])
    image_desc = gcs.load_text(image_desc_obj[Key.FILE.value])
    if product_id not in products:
      products[product_id] = {
          "images": {},
          "description": product_descriptions_map.get(product_id, ""),
      }
    products[product_id]["images"][image_id] = {"description": image_desc}

  text_prompt += """\n\n
    Important note: The "post_production" field in the response schema is only to be populated if the prompt explicitly asks for transitions or durations shorter than 4 seconds.
    \n\n
    #PRODUCT_DETAILS#:
    (These are detailed JSON descriptions of the specific products to be featured, including names, features, materials, etc. Correlate with `#PRODUCT_IMAGE_DESCRIPTIONS#` if applicable.
    Most importantly, this clarifies which images belong to which product. Don't come up with scenes that attempt to use images from other products.)
  """

  valid_product_image_combinations = {}
  for product_id, product in products.items():
    if product_id not in valid_product_image_combinations:
      valid_product_image_combinations[product_id] = set()
    product_desc = product["description"]
    text_prompt += f"\nProduct ID: {product_id}"
    text_prompt += f"\nProduct: {product_desc}"
    text_prompt += "\n\n#PRODUCT_IMAGE_DESCRIPTIONS#"
    for image_id, image in product["images"].items():
      text_prompt += f"\nImage ID {image_id}: {image['description']}"
      valid_product_image_combinations[product_id].add(image_id)

  style_paths = []
  script_paths = []
  post_production_paths = []
  response_schema = {
      "type": "object",
      "properties": {
          "style": {"type": "string"},
          "scenes": {
              "type": "array",
              "items": {
                  "type": "object",
                  "properties": {
                      Dimension.PRODUCT_ID.value: {"type": "string"},
                      Dimension.IMAGE_ID.value: {"type": "string"},
                      "scene": {"type": "string"},
                      "post_production": {
                          "type": "object",
                          "description": (
                              "Only to be populated if the prompt explicitly"
                              " asks for transitions or durations shorter than"
                              " 4 seconds."
                          ),
                          "properties": {
                              "duration": {
                                  "type": "number",
                                  "description": (
                                      "Duration in seconds. Maximum 8 seconds."
                                  ),
                              },
                              "video_transition": {
                                  "type": "string",
                                  "description": "Transition into this scene.",
                                  "enum": [
                                      "fade",
                                      "dissolve",
                                      "wipebl",
                                      "slideleft",
                                  ],
                              },
                          },
                      },
                  },
                  "required": [
                      Dimension.PRODUCT_ID.value,
                      Dimension.IMAGE_ID.value,
                      "scene",
                  ],
              },
          },
      },
      "required": ["style", "scenes"],
  }
  logger.debug("Prompt: %s", text_prompt)
  for story_variant_id in range(story_variant_quantity):
    result = None
    for _ in range(4):  # 1 initial call + 3 retries
      candidate_result = typing.cast(
          dict[str, Any],
          gemini.prompt(
              gcp_project=workflow_params[Key.GCP_PROJECT.value],
              text_prompt=text_prompt,
              response_schema=response_schema,
              model=gemini_model,
              location=gemini_model_location,
          ),
      )
      is_valid = True
      if "scenes" not in candidate_result:
        is_valid = False
      else:
        for scene in candidate_result["scenes"]:
          product_id = scene.get(Dimension.PRODUCT_ID.value)
          image_id = scene.get(Dimension.IMAGE_ID.value)
          if (
              product_id not in valid_product_image_combinations
              or image_id
              not in valid_product_image_combinations.get(product_id, set())
          ):
            is_valid = False
            logger.warning(
                "Invalid scene from Gemini: product_id=%s, image_id=%s",
                product_id,
                image_id,
            )
            break  # This scene is invalid, so the whole result is.
      if is_valid:
        result = candidate_result
        break
    if not result:
      raise RuntimeError(
          "Gemini repeatedly scripted invalid image/product combinations"
      )

    style_path = gcs.store(
        result["style"], f"style_{story_variant_id}.txt", ContentType.TEXT.value
    )
    style_paths.append({
        Key.FILE.value: style_path,
        Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
    })
    for scene_id, script in enumerate(result["scenes"]):
      file_id = f"{story_variant_id}_{scene_id}_{script[Dimension.PRODUCT_ID.value]}_{script[Dimension.IMAGE_ID.value]}"
      filename = f"script_{file_id}.txt"
      script_path = gcs.store(script["scene"], filename, ContentType.TEXT.value)
      script_paths.append({
          Key.FILE.value: script_path,
          Dimension.PRODUCT_ID.value: script[Dimension.PRODUCT_ID.value],
          Dimension.IMAGE_ID.value: script[Dimension.IMAGE_ID.value],
          Dimension.SCENE_ID.value: str(scene_id),
          Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
      })
      filename = f"post_production_{file_id}.json"
      post_production = script.get("post_production", {})
      if post_production:
        gcs_path = gcs.store(
            json.dumps(post_production), filename, "application/json"
        )
        post_production_paths.append({
            Key.FILE.value: gcs_path,
            Dimension.PRODUCT_ID.value: script["product_id"],
            Dimension.IMAGE_ID.value: script["image_id"],
            Dimension.SCENE_ID.value: str(scene_id),
            Dimension.STORY_VARIANT_ID.value: str(story_variant_id),
        })

  return {
      "script": script_paths,
      "style": style_paths,
      "post_production": post_production_paths,
  }
