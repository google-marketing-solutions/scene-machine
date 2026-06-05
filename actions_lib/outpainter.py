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

"""Outpaints images.

Provides a function to outpaint an image using Google Gemini. Outpainting is the
act of extending an image to a larger canvas / new aspect ratio, filling the new
area so it looks like the same scene photographed with a wider frame (not a new,
re-imagined image).

The model is handed the source image plus a blank canvas at the target aspect
ratio as a second image -- the model adopts the last image's aspect ratio -- and
is instructed to extend the existing scene into the new area without inventing a
separate image. For models that support it, a high thinking level is requested.

The main entry point is outpaint_image(). It takes the bytes of an image and
returns the outpainted image bytes plus its mime type.
"""

import io
from typing import Tuple

from google import genai
from google.genai import types as gtypes
import PIL.Image

from common import get_api_client_headers
from common import logger
from common import TrackingType

# Outpaint at 2K, stepping up to 4K when the target canvas's long edge is past
# the 2K/4K midpoint -- generate near the intended output resolution without
# paying for 4K on modest expansions. (No 1K: even small sources render at 2K.)
_FOUR_K_LONG_EDGE = 3072
# Reasoning effort for models that support thinking (see _supports_thinking).
_THINKING_LEVEL = gtypes.ThinkingLevel.HIGH
# Fill color of the blank target-ratio canvas handed to the model.
_CANVAS_FILL = (128, 128, 128)

# Outpaint instruction. {target_ratio} is substituted per call.
_OUTPAINT_PROMPT = """You are performing OUTPAINTING: extending one single continuous scene outward so it
fills a larger canvas. This is NOT a collage, diptych, or composite.  The second image defines the target canvas and its exact target aspect ratio of {target_ratio}.

Treat the original photo as a window into a larger real scene. The empty canvas areas are
the SAME physical scene continuing beyond the original frame — the same room, the same
landscape, the same moment, photographed by the same camera. You are revealing what was
just outside the original crop, nothing else.

Preserve the original exactly — highest priority:
- Reproduce the original image pixel-for-pixel: same subject, framing, scale, position,
  lighting, colors, and perspective. Do not redraw, restyle, resize, shift, or re-light it.
- Every person must remain absolutely identical: keep each face, facial features,
  expression, gaze, skin tone, hair, body, pose, and clothing exactly as in the original.
  Do not alter, beautify, regenerate, or "improve" any face. Identity must be preserved
  perfectly.
- Every existing object, product, sign, and piece of text must stay exactly as it is.

Extend the scene into the empty areas — this is the critical part:
- The new areas must be a seamless geometric continuation of the existing scene. Lines,
  surfaces, horizons, floors, walls, and edges that run toward the border MUST continue
  unbroken into the new area at the same angle and perspective.
- Continue the exact same environment, lighting direction, color palette, grain, depth
  of field, and time of day across the whole canvas. There must be no visible seam and no
  point where the content changes character.
- The result must look like one single photograph taken with a wider frame — NOT the
  original image placed beside a different image.

Strictly forbidden:
- Do NOT create a second scene, a separate panel, a border, a frame, a split, or any
  side-by-side composition.
- Do NOT add new people, animals, faces, objects, vehicles, text, logos, or focal points.
- Do NOT duplicate or mirror the original subject.

Output one single seamless photograph at the exact aspect ratio of the second image."""

# model id -> whether it advertises thinking support. Memoized per process so
# the registry lookup happens at most once per model (Cloud Run reuses
# instances across requests).
_THINKING_SUPPORT = {}


def _target_canvas_size(
    orig_w: int, orig_h: int, target_w: int, target_h: int
) -> Tuple[int, int]:
    """Smallest canvas at the target ratio that fully contains the source.

    Preserves the limiting dimension and extends the other, so the source fits
    inside the canvas centered with room to outpaint on the growing axis.

    Raises:
      ValueError: if any source or target dimension is not positive.
    """
    if min(orig_w, orig_h, target_w, target_h) <= 0:
        raise ValueError(
            "Source and target dimensions must be positive; got source "
            f"{orig_w}x{orig_h}, target {target_w}:{target_h}."
        )
    target_ratio = target_w / target_h
    source_ratio = orig_w / orig_h
    if source_ratio < target_ratio:  # narrower than target -> grow width
        return round(orig_h * target_ratio), orig_h
    if source_ratio > target_ratio:  # wider than target -> grow height
        return orig_w, round(orig_w / target_ratio)
    return orig_w, orig_h


def _pick_image_size(canvas_w: int, canvas_h: int) -> str:
    """Chooses "2K" or "4K" output based on the target canvas long edge.

    4K when the outpainted canvas is large (long edge past the 2K/4K midpoint),
    else 2K -- so we generate close to the intended output resolution without
    paying for 4K on modest expansions.
    """
    return "4K" if max(canvas_w, canvas_h) > _FOUR_K_LONG_EDGE else "2K"


def _supports_thinking(client: genai.Client, model: str) -> bool:
    """Whether `model` advertises thinking support, per the model registry.

    Cached per model id. Fails closed (returns False) if the lookup errors, so
    a model without thinking can never hard-error on the thinking config; a
    skip is logged so it is observable rather than silent.
    """
    if model not in _THINKING_SUPPORT:
        try:
            _THINKING_SUPPORT[model] = bool(client.models.get(model=model).thinking)
        except Exception:  # pylint: disable=broad-except
            logger.warning("Could not query thinking support for %s", model)
            _THINKING_SUPPORT[model] = False
        if not _THINKING_SUPPORT[model]:
            logger.info("Thinking not enabled for model %s", model)
    return _THINKING_SUPPORT[model]


def outpaint_image(
    image_bytes: bytes,
    gcp_project: str,
    gcp_location: str,
    image_model: str,
    target_ratio: str,
) -> Tuple[bytes, str]:
    """Outpaints the given image to the target aspect ratio using Gemini.

    Args:
      image_bytes: the bytes of the image to outpaint. Must be a JPEG or PNG.
      gcp_project: the Google Cloud project to use with the model.
      gcp_location: the Google Cloud location to use with the model.
      image_model: the image model to use for outpainting.
      target_ratio: the target aspect ratio as "width:height" (e.g. "16:9").

    Returns:
      A tuple of the outpainted image bytes and its mime type.

    Raises:
      ValueError: if the response from the model doesn't contain image data.
    """
    with io.BytesIO(image_bytes) as input_bytes:
        image = PIL.Image.open(input_bytes)
        image.load()

    target_w, target_h = map(int, target_ratio.split(":"))
    canvas_size = _target_canvas_size(image.width, image.height, target_w, target_h)
    blank_canvas = PIL.Image.new("RGB", canvas_size, _CANVAS_FILL)
    prompt = _OUTPAINT_PROMPT.replace("{target_ratio}", target_ratio)

    http_options = gtypes.HttpOptions(
        headers=get_api_client_headers(TrackingType.IMAGE)
    )
    client = genai.Client(
        vertexai=True,
        project=gcp_project,
        location=gcp_location,
        http_options=http_options,
    )

    config_kwargs = {
        "response_modalities": ["IMAGE"],
        "image_config": gtypes.ImageConfig(
            aspect_ratio=target_ratio,
            image_size=_pick_image_size(*canvas_size),
        ),
    }
    if _supports_thinking(client, image_model):
        config_kwargs["thinking_config"] = gtypes.ThinkingConfig(
            thinking_level=_THINKING_LEVEL
        )
    generate_config = gtypes.GenerateContentConfig(**config_kwargs)

    # The blank canvas is the second image: it sets the target aspect ratio.
    contents = [prompt, image, blank_canvas]
    outpaint_response = client.models.generate_content(
        model=image_model, contents=contents, config=generate_config
    )

    if not outpaint_response.candidates:
        raise ValueError(
            "The response from the model did not contain any candidates."
        )
    candidate = outpaint_response.candidates[0]
    if not candidate.content or not candidate.content.parts:
        raise ValueError(
            "The first candidate from the model did not contain any content or"
            " parts."
        )
    part = candidate.content.parts[0]
    # The part may be a text part with an error message, so we check for data.
    if not hasattr(part, "inline_data") or not part.inline_data:
        raise ValueError(
            "The first part of the first candidate from the model did not contain"
            f" any inline data: {part}"
        )

    outpaint_blob = part.inline_data
    if not outpaint_blob.data or not outpaint_blob.mime_type:
        raise ValueError("No data found in the outpainting result")

    return outpaint_blob.data, outpaint_blob.mime_type
