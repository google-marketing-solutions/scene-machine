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

"""Tests for actions/generate_storyboard.py."""

import json
import unittest
from unittest.mock import MagicMock
from unittest.mock import patch

# Target module imports
from actions import generate_storyboard
from common import Dimension
from common import Key


class TestGenerateStoryboard(unittest.TestCase):

  def setUp(self):
    self.mock_gcs = MagicMock()
    self.mock_params = {Key.GCP_PROJECT.value: "test-project"}
    self.mock_images = [
      {
        Dimension.PRODUCT_ID.value: "p1",
        Dimension.IMAGE_ID.value: "i1",
        Key.FILE.value: "path/to/img1.jpg",
      }
    ]
    self.mock_user_prompt = [{Key.FILE.value: "path/to/prompt.txt"}]
    self.gemini_model = "gemini-model"
    self.gemini_model_location = "us-central1"

    # Mock GCS methods
    self.mock_gcs.load_text.return_value = "Optimized user prompt text"
    self.mock_gcs.get_uri.return_value = "gs://bucket/path/to/img1.jpg"
    self.mock_gcs.store.return_value = "gs://bucket/storyboard.json"

  @patch("actions.generate_storyboard.genai.Client")
  def test_execute_success(self, mock_genai_client_class):
    # Setup mock client
    mock_client = MagicMock()
    mock_genai_client_class.return_value = mock_client

    # Setup mock response
    mock_response = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    # Setup mock response candidate
    mock_candidate = MagicMock()
    mock_part = MagicMock()
    mock_part.text = (
      '{"storyboard": [{"image_id": "i1", "product_id": "p1",'
      ' "scene_name": "Scene 1", "video_prompt": "Prompt 1'
      ' list"}]}'
    )
    mock_candidate.content.parts = [mock_part]
    mock_response.candidates = [mock_candidate]

    # Run execute
    result = generate_storyboard.execute(
      self.mock_gcs,
      self.mock_params,
      self.mock_images,
      self.mock_user_prompt,
      self.gemini_model,
      self.gemini_model_location,
    )

    # Verify result
    self.assertEqual(
      result, {"storyboard": [{Key.FILE.value: "gs://bucket/storyboard.json"}]}
    )
    self.mock_gcs.store.assert_called_once()

  @patch("actions.generate_storyboard.genai.Client")
  def test_execute_no_storyboard_in_response(self, mock_genai_client_class):
    mock_client = MagicMock()
    mock_genai_client_class.return_value = mock_client
    mock_response = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    mock_candidate = MagicMock()
    mock_part = MagicMock()
    mock_part.text = "{}"  # Empty JSON
    mock_candidate.content.parts = [mock_part]
    mock_response.candidates = [mock_candidate]

    with self.assertRaises(ValueError) as cm:
      generate_storyboard.execute(
        self.mock_gcs,
        self.mock_params,
        self.mock_images,
        self.mock_user_prompt,
        self.gemini_model,
        self.gemini_model_location,
      )
    self.assertIn("No storyboard found in the response.", str(cm.exception))


if __name__ == "__main__":
  unittest.main()
