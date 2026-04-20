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

"""Used to describe images using gemini."""

from actions_lib import gemini


def describe_image(
    image_path: str,
    guidance: str,
    gcp_project: str,
    gemini_model: str,
) -> str:
  """Describes the given image using Gemini.

  Args:
    image_path: path to the image to be described.
    guidance: extra information about the image to be used in the description.
    gcp_project: the GCP project to be used when calling Gemini.
    gemini_model: the Gemini model to be used.

  Returns:
    a JSON object with a description of the image.
  """
  # print(f"Describing: {image_path} ({guidance})")
  if guidance:
    guidance_prompt = (
        f"\n\nThis identifies the focus object of the image: {guidance}"
    )
  else:
    guidance_prompt = ""
  prompt = f"""
      <PERSONA>
      You are an expert AI-powered Visual Analyst and Cinematographer.
      Your function is to meticulously analyze a still image and describe it with absolute accuracy
      using a structured JSON format. Your primary directive is to report only what is visually present.
      You must not invent, infer, or hallucinate any information, objects, or subjects that are not clearly visible in the image.
      </PERSONA>

      <INSTRUCTIONS>
      You are a meticulous technical image analyst. Your sole purpose is to analyze a given image and populate a JSON object with absolute factual accuracy based on the visual information.
      Absolute Accuracy is Paramount: Your primary goal is to describe the provided image with perfect factual accuracy. Do not add, infer, or hallucinate any information that cannot be directly and unequivocally verified from the image itself.
      Describe Only What You See: Populate JSON fields that describe tangible elements (like scene.location, subject.description, visual_details.props) only with information that is clearly visible. For the props field, provide a comprehensive list of all distinct items visible.
      Mandatory Subject Identification (Critical Rule): You must identify the primary subject of the image.
      If the subject is a person: Describe the person in subject.description, their clothing in subject.wardrobe, and their apparent action (e.g., "sitting," "walking," "looking at the camera") in subject.action.
      If the subject is an object (e.g., a table, a car, a building): Describe the object in subject.description. You MUST then leave both subject.wardrobe and subject.action as empty strings "".
      Action within the Shot: Use the shot.action field to describe the overall event happening within the frame (e.g., "A car is driving down the street," "Rain is falling"). If the scene is static and no discernible event is occurring, leave this field as an empty string "".
      Grounded Technical & Interpretive Analysis: For fields requiring technical analysis (shot, cinematography) or subjective interpretation (mood, tone), your response must be strictly grounded in visual evidence. Interpretive terms (e.g., "Nostalgic," "Soft Light") are acceptable only if they are a direct and logical interpretation of the image's lighting, composition, and color palette.
      Strict Adherence to Schema: You must populate every single field in the provided JSON schema. If information for a field is not present or not applicable (per the rules above), you must use an empty string "". Do not omit any keys from the final JSON output.
      {guidance_prompt}
      </INSTRUCTIONS>
    """
  response_schema = {
      "type": "object",
      "description": (
          "Describes the complete visual and thematic elements of a scene."
      ),
      "required": [
          "cinematography",
          "scene",
          "subject",
          "shot",
          "visual_details",
      ],
      "properties": {
          "cinematography": {
              "type": "object",
              "description": (
                  "Technical details related to the camera and lighting work."
              ),
              "required": [
                  "depth_of_field",
                  "white_balance",
                  "tone",
                  "lighting",
                  "focus",
                  "exposure",
              ],
              "properties": {
                  "depth_of_field": {
                      "type": "string",
                      "description": (
                          "The range of distance that appears acceptably sharp."
                      ),
                      "example": "Deep",
                  },
                  "white_balance": {
                      "type": "string",
                      "description": "The color balance on the image.",
                      "example": "Daylight",
                  },
                  "tone": {
                      "type": "string",
                      "description": "The overall color temperature or feel.",
                      "example": "Warm",
                  },
                  "lighting": {
                      "type": "string",
                      "description": (
                          "The style and quality of light in the scene."
                      ),
                      "example": "Evenly Lit",
                  },
                  "focus": {
                      "type": "string",
                      "description": (
                          "The sharpness or softness of the subject."
                      ),
                      "example": "Sharp Focus",
                  },
                  "exposure": {
                      "type": "string",
                      "description": (
                          "The amount of light per unit area reaching the"
                          " sensor."
                      ),
                      "example": "Properly Exposed",
                  },
              },
          },
          "scene": {
              "type": "object",
              "description": "Details about the setting and environment.",
              "required": ["environment", "time_of_day", "location"],
              "properties": {
                  "environment": {
                      "type": "string",
                      "description": "The immediate surroundings of the scene.",
                      "example": "Indoor dining room",
                  },
                  "time_of_day": {
                      "type": "string",
                      "description": "The time the scene takes place.",
                      "example": "Daytime",
                  },
                  "location": {
                      "type": "string",
                      "description": (
                          "The broader geographical or architectural location."
                      ),
                      "example": "Modern home",
                  },
              },
          },
          "subject": {
              "type": "object",
              "description": "Information about the main focus of the scene.",
              "required": ["description", "wardrobe", "action"],
              "properties": {
                  "description": {
                      "type": "string",
                      "description": (
                          "A textual description of the primary subject."
                      ),
                      "example": (
                          "A modern wooden dining table with a dark finish, set"
                          " with plates and glasses."
                      ),
                  },
                  "wardrobe": {
                      "type": "string",
                      "description": (
                          "Clothing or attire of the subject, if applicable."
                      ),
                      "example": "",
                  },
                  "action": {
                      "type": "string",
                      "description": "Any action the subject is performing.",
                      "example": "",
                  },
              },
          },
          "shot": {
              "type": "object",
              "description": "Details about the camera shot itself.",
              "required": [
                  "composition",
                  "type",
                  "film_grain",
                  "camera_motion",
              ],
              "properties": {
                  "composition": {
                      "type": "string",
                      "description": (
                          "The arrangement of visual elements within the frame."
                      ),
                      "enum": [
                          "",
                          "Wide shot",
                          "Medium shot",
                          "Close-up",
                          "Extreme close-up",
                          "Cowboy shot",
                          "Over-the-shoulder shot",
                          "Bird's-eye view",
                          "Low-angle shot",
                          "Rule of thirds composition, subject on the left",
                          "Rule of thirds composition, subject on the right",
                          "Leading lines composition",
                          "Symmetrical composition",
                          "Shallow depth of field",
                          "Deep depth of field",
                          "Blurred background",
                          "Hard light",
                          "Soft light",
                          "Backlighting",
                      ],
                      "example": "Wide shot",
                  },
                  "type": {
                      "type": "string",
                      "description": (
                          "The functional purpose or editing style of the shot."
                      ),
                      "enum": [
                          "",
                          "Establishing shot",
                          "Reaction shot",
                          "POV shot",
                          "Montage sequence",
                          "Cutaway shot",
                          "Fade in",
                          "Fade out",
                          "Fast cuts",
                          "Slow cuts",
                          "Long shot duration",
                          "Short shot duration",
                          "Eye-level shot",
                          "Subjective camera",
                          "Objective camera",
                      ],
                      "example": "Establishing shot",
                  },
                  "film_grain": {
                      "type": "string",
                      "description": "The visual texture of the image.",
                      "example": "Clean",
                  },
                  "camera_motion": {
                      "type": "string",
                      "description": (
                          "Describes the movement of the camera during the"
                          " shot."
                      ),
                      "enum": [
                          "",
                          "Pan left",
                          "Pan right",
                          "Tilt up",
                          "Tilt down",
                          "Zoom in",
                          "Zoom out",
                          "Tracking shot",
                          "Crane shot",
                          "Handheld camera style",
                          "Slow pan",
                          "Fast pan",
                      ],
                      "example": "",
                  },
              },
          },
          "visual_details": {
              "type": "object",
              "description": "Aesthetic and stylistic elements of the scene.",
              "required": ["style", "color_palette", "mood", "props", "action"],
              "properties": {
                  "style": {
                      "type": "string",
                      "description": "The overall visual style.",
                      "example": "Modern, minimalist",
                  },
                  "color_palette": {
                      "type": "string",
                      "description": "The dominant colors used in the scene.",
                      "example": "Earthy tones, with greens, browns, and black",
                  },
                  "mood": {
                      "type": "string",
                      "description": "The emotional atmosphere of the scene.",
                      "example": "Calm, inviting",
                  },
                  "props": {
                      "type": "string",
                      "description": "A list of objects present in the scene.",
                      "example": (
                          "Dining table, dining chairs, buffet cabinet, pendant"
                          " light, rug, vase with branches, decorative bowl,"
                          " plates, glasses, books, plant, framed artwork."
                      ),
                  },
                  "action": {
                      "type": "string",
                      "description": (
                          "Any background or secondary action occurring."
                      ),
                      "example": "",
                  },
              },
          },
      },
  }
  return gemini.prompt(
      gcp_project=gcp_project,
      text_prompt=prompt,
      response_schema=response_schema,
      file_uris=[image_path],
      model=gemini_model,
  )
