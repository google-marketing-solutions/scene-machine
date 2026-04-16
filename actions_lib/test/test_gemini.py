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

"""Tests for gemini library."""

import json
import unittest
from unittest import mock

from actions_lib import gemini
from google.genai import types


class TestGemini(unittest.TestCase):
    """Tests for gemini."""

    def test_get_mime_type_allowed(self):
        """Tests get_mime_type with allowed extensions."""
        self.assertEqual(gemini.get_mime_type("test.png"), "image/png")
        self.assertEqual(gemini.get_mime_type("test.jpeg"), "image/jpeg")
        self.assertEqual(gemini.get_mime_type("test.jpg"), "image/jpeg")
        self.assertEqual(gemini.get_mime_type("test.mp4"), "video/mp4")

    def test_get_mime_type_unallowed_raises_value_error(self):
        """Tests that unallowed extensions raise ValueError."""
        with self.assertRaises(ValueError):
            gemini.get_mime_type("test.txt")

    def test_remove_md_notation(self):
        """Tests remove_md_notation."""
        self.assertEqual(
            gemini.remove_md_notation('```json{"key": "value"}```'),
            '{"key": "value"}',
        )
        self.assertEqual(
            gemini.remove_md_notation("normal text"), "normal text"
        )

    @mock.patch("google.genai.Client")
    def test_prompt_success(self, mock_client_class):
        """Tests full prompt flow with mock client."""
        mock_client = mock_client_class.return_value
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_part = mock.Mock()
        mock_part.text = "mock response"
        mock_candidate.content.parts = [mock_part]
        mock_response.candidates = [mock_candidate]
        mock_client.models.generate_content.return_value = mock_response

        output = gemini.prompt(
            gcp_project="test-proj", text_prompt="say something"
        )
        self.assertEqual(output, "mock response")

        # Verify interactions
        mock_client_class.assert_called_once_with(
            vertexai=True, project="test-proj", location="us-central1"
        )

    @mock.patch("google.genai.Client")
    def test_prompt_json_schema(self, mock_client_class):
        """Tests prompt when response_schema is provided."""
        mock_client = mock_client_class.return_value
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_part = mock.Mock()
        mock_part.text = '{"result": "success"}'
        mock_candidate.content.parts = [mock_part]
        mock_response.candidates = [mock_candidate]
        mock_client.models.generate_content.return_value = mock_response

        schema = {"type": "OBJECT", "properties": {"result": {"type": "STRING"}}}
        output = gemini.prompt(
            gcp_project="test-proj",
            text_prompt="get json",
            response_schema=schema,
        )
        self.assertEqual(output, {"result": "success"})

        mock_client.models.generate_content.assert_called_once()
        args, kwargs = mock_client.models.generate_content.call_args

        # Verify prompt text is passed correctly in the complex structure
        self.assertEqual(kwargs["contents"][0].parts[0].text, "get json")

        # Verify schema was applied to config
        self.assertEqual(kwargs["config"].response_schema, schema)

    @mock.patch("google.genai.Client")
    def test_prompt_with_files(self, mock_client_class):
        """Tests prompt with file URIs."""
        mock_client = mock_client_class.return_value
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_part = mock.Mock()
        mock_part.text = "analyzed"
        mock_candidate.content.parts = [mock_part]
        mock_response.candidates = [mock_candidate]
        mock_client.models.generate_content.return_value = mock_response

        output = gemini.prompt(
            gcp_project="test-proj",
            text_prompt="look at this",
            file_uris=["gs://bucket/image.png"],
        )
        self.assertEqual(output, "analyzed")


    @mock.patch("google.genai.Client")
    def test_prompt_thinking_config_pro(self, mock_client_class):
        """Tests prompt when model is gemini-2.5-pro."""
        mock_client = mock_client_class.return_value
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_part = mock.Mock()
        mock_part.text = "success"
        mock_candidate.content.parts = [mock_part]
        mock_response.candidates = [mock_candidate]
        mock_client.models.generate_content.return_value = mock_response

        gemini.prompt(
            gcp_project="test-proj",
            text_prompt="hi",
            model="gemini-2.5-pro",
        )

        args, kwargs = mock_client.models.generate_content.call_args
        self.assertEqual(kwargs["config"].thinking_config.thinking_budget, 128)

    @mock.patch("google.genai.Client")
    def test_prompt_thinking_config_flash(self, mock_client_class):
        """Tests prompt when model is gemini-2.5-flash."""
        mock_client = mock_client_class.return_value
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_part = mock.Mock()
        mock_part.text = "success"
        mock_candidate.content.parts = [mock_part]
        mock_response.candidates = [mock_candidate]
        mock_client.models.generate_content.return_value = mock_response

        gemini.prompt(
            gcp_project="test-proj",
            text_prompt="hi",
            model="gemini-2.5-flash",
        )

        args, kwargs = mock_client.models.generate_content.call_args
        self.assertEqual(kwargs["config"].thinking_config.thinking_budget, 0)


if __name__ == "__main__":
    unittest.main()
