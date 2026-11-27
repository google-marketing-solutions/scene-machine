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
"""Pins the google-genai attribute surface the adapters and the fake rely on.

Imports the REAL installed SDK (no client is ever constructed, nothing is
called) and checks signatures and pydantic fields, so that a dependency bump
that changes the surface fails here instead of silently drifting away from
``tests/fake_genai.py``. Skipped when google-genai is not installed.
"""

from __future__ import annotations

import importlib
import inspect
import sys
from typing import Any

import pytest

import fake_genai


@pytest.fixture
def real_sdk(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any]:
  """The installed google.genai, imported past the fakes that conftest installs."""
  for name in list(sys.modules):
    if name == "google" or name.startswith("google."):
      monkeypatch.delitem(sys.modules, name, raising=False)
  try:
    genai = importlib.import_module("google.genai")
    types = importlib.import_module("google.genai.types")
  except ImportError:
    pytest.skip("google-genai is not installed in this interpreter")
  return genai, types


def fields(cls: Any) -> set[str]:
  mf = getattr(cls, "model_fields", None)
  assert mf is not None, f"{cls} is not a pydantic model"
  return set(mf)


def test_client_signature(real_sdk: tuple[Any, Any]) -> None:
  genai, _ = real_sdk
  params = inspect.signature(genai.Client.__init__).parameters
  assert "project" in params and "location" in params
  assert "enterprise" in params or "vertexai" in params


def test_models_methods(real_sdk: tuple[Any, Any]) -> None:
  genai, _ = real_sdk
  models = importlib.import_module("google.genai.models").Models
  assert "source" in inspect.signature(models.generate_videos).parameters
  assert "config" in inspect.signature(models.generate_videos).parameters
  assert {"model", "prompt", "config"} <= set(inspect.signature(models.generate_images).parameters)
  assert {"model", "contents", "config"} <= set(
    inspect.signature(models.generate_content).parameters
  )
  operations = importlib.import_module("google.genai.operations").Operations
  assert "operation" in inspect.signature(operations.get).parameters


def test_config_fields(real_sdk: tuple[Any, Any]) -> None:
  _, types = real_sdk
  assert {
    "duration_seconds",
    "aspect_ratio",
    "enhance_prompt",
    "generate_audio",
    "resolution",
    "number_of_videos",
  } <= fields(types.GenerateVideosConfig)
  assert {"add_watermark", "aspect_ratio", "number_of_images"} <= fields(types.GenerateImagesConfig)
  assert {"response_modalities", "speech_config", "image_config"} <= fields(
    types.GenerateContentConfig
  )
  assert "aspect_ratio" in fields(types.ImageConfig)
  assert {"language_code", "voice_config"} <= fields(types.SpeechConfig)
  assert "prebuilt_voice_config" in fields(types.VoiceConfig)
  assert "voice_name" in fields(types.PrebuiltVoiceConfig)
  assert {"prompt", "image"} <= fields(types.GenerateVideosSource)


def test_response_shapes(real_sdk: tuple[Any, Any]) -> None:
  _, types = real_sdk
  assert isinstance(getattr(types.GenerateContentResponse, "parts", None), property)
  assert "candidates" in fields(types.GenerateContentResponse)
  assert {"text", "inline_data"} <= fields(types.Part)
  assert {"data", "mime_type"} <= fields(types.Blob)
  assert {"done", "error", "response", "result", "name"} <= fields(types.GenerateVideosOperation)
  assert "generated_videos" in fields(types.GenerateVideosResponse)
  assert "video_bytes" in fields(types.Video) and "uri" in fields(types.Video)
  assert "image_bytes" in fields(types.Image)
  assert "generated_images" in fields(types.GenerateImagesResponse)
  assert "location" in inspect.signature(types.Image.from_file).parameters


def test_error_classes(real_sdk: tuple[Any, Any]) -> None:
  errors = importlib.import_module("google.genai.errors")
  assert issubclass(errors.APIError, Exception)
  assert hasattr(errors, "ClientError") and hasattr(errors, "ServerError")
  assert "code" in inspect.signature(errors.APIError.__init__).parameters


def test_fake_matches_pinned_surface(
  real_sdk: tuple[Any, Any], fake_media_bytes: dict[str, Any]
) -> None:
  """The fake must expose at least what the real SDK exposes for the used calls."""
  genai, types = real_sdk
  rec = fake_genai.Recorder(dict(fake_media_bytes))
  fake = fake_genai.build_fake_modules(rec)
  fake_params = set(inspect.signature(fake["google.genai"].Client.__init__).parameters)
  assert {"enterprise", "vertexai", "project", "location"} <= fake_params
  real_params = set(inspect.signature(genai.Client.__init__).parameters)
  assert {"project", "location"} <= real_params
  for name in (
    "GenerateContentConfig",
    "SpeechConfig",
    "VoiceConfig",
    "PrebuiltVoiceConfig",
    "GenerateImagesConfig",
    "GenerateVideosSource",
    "GenerateVideosConfig",
    "ImageConfig",
    "Image",
  ):
    assert hasattr(types, name) and hasattr(fake["google.genai.types"], name), name
  fake_models = fake["google.genai"].Client(enterprise=True, project="p", location="global").models
  for method in ("generate_content", "generate_images", "generate_videos"):
    assert callable(getattr(fake_models, method))
  assert "source" in inspect.signature(fake_models.generate_videos).parameters
