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

"""Tests for outpainter.py."""

import unittest
from unittest import mock

from actions_lib import outpainter


class TestOutpainter(unittest.TestCase):
    """Tests for outpainter.py."""

    def setUp(self):
        super().setUp()
        self.mock_image_bytes = b"mock_image_data"
        self.mock_gcp_project = "test-project"
        self.mock_gcp_location = "us-central1"
        self.mock_outpainter_model = "gemini-3.1-flash-image-preview"
        self.mock_target_ratio = "16:9"
        self.mock_description = "a test image"
        self.mock_outpainted_bytes = b"mock_outpainted_image_bytes"

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_success(self, mock_genai_client, mock_pil_open):
        """Tests the outpaint_image function when it is successful and no description is provided."""
        # Mock PIL.Image.open
        mock_image_instance = mock.Mock()
        mock_image_instance.load.return_value = None

        # required as the bytes stream is closed after load() is called.
        def check_stream_and_return_mock(stream):
            self.assertEqual(stream.getvalue(), self.mock_image_bytes)
            return mock_image_instance

        mock_pil_open.side_effect = check_stream_and_return_mock

        # Mock genai.Client and its generate_content method
        mock_client_instance = mock.Mock()
        mock_genai_client.return_value = mock_client_instance

        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_content = mock.Mock()
        mock_part = mock.Mock()

        # Fix: mock_part.inline_data must be an object with data and mime_type
        mock_blob = mock.Mock(data=self.mock_outpainted_bytes, mime_type="image/png")
        mock_part.inline_data = mock_blob
        mock_content.parts = [mock_part]
        mock_candidate.content = mock_content
        mock_response.candidates = [mock_candidate]

        mock_client_instance.models.generate_content.return_value = mock_response

        result = outpainter.outpaint_image(
            self.mock_image_bytes,
            self.mock_gcp_project,
            self.mock_gcp_location,
            self.mock_outpainter_model,
            self.mock_target_ratio,
        )

        # Fix: result is a tuple (bytes, str)
        self.assertEqual(result, (self.mock_outpainted_bytes, "image/png"))
        mock_pil_open.assert_called_once()
        mock_image_instance.load.assert_called_once()
        mock_genai_client.assert_called_once_with(
            vertexai=True,
            project=self.mock_gcp_project,
            location=self.mock_gcp_location,
            http_options=mock.ANY,
        )

        mock_client_instance.models.generate_content.assert_called_once()
        _, kwargs = mock_client_instance.models.generate_content.call_args
        # Fix: IMAGE_MODEL is now private _IMAGE_MODEL
        self.assertEqual(kwargs["model"], self.mock_outpainter_model)
        self.assertIn(
            "Outpaint the image to the required aspect ratio",
            kwargs["contents"][0],
        )
        self.assertEqual(
            kwargs["config"].image_config.aspect_ratio, self.mock_target_ratio
        )


    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_no_candidates(self, mock_genai_client, mock_pil_open):
        """Tests the outpaint_image function when the response from the model does not contain any candidates."""
        mock_pil_open.return_value = mock.Mock(load=mock.Mock())
        mock_client_instance = mock.Mock()
        mock_genai_client.return_value = mock_client_instance
        mock_response = mock.Mock(candidates=[])
        mock_client_instance.models.generate_content.return_value = mock_response

        with self.assertRaisesRegex(ValueError, "did not contain any candidates"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_outpainter_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_no_inline_data(
        self, mock_genai_client, mock_pil_open
    ):
        """Tests the outpaint_image function when the response from the model does not contain any inline data."""
        mock_pil_open.return_value = mock.Mock(load=mock.Mock())
        mock_client_instance = mock.Mock()
        mock_genai_client.return_value = mock_client_instance
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_content = mock.Mock()
        mock_part = mock.Mock()
        mock_part.inline_data = None
        mock_content.parts = [mock_part]
        mock_candidate.content = mock_content
        mock_response.candidates = [mock_candidate]
        mock_client_instance.models.generate_content.return_value = mock_response

        with self.assertRaisesRegex(ValueError, "did not contain any inline data"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_outpainter_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    def test_outpaint_image_pil_error(self, mock_pil_open):
        """Tests that outpaint_image propagates PIL errors."""
        mock_pil_open.side_effect = IOError("Failed to open image")
        with self.assertRaises(IOError):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_outpainter_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_api_error(self, mock_genai_client, mock_pil_open):
        """Tests that outpaint_image propagates GenAI API errors."""
        mock_pil_open.return_value = mock.Mock(load=mock.Mock())
        mock_client_instance = mock.Mock()
        mock_genai_client.return_value = mock_client_instance
        mock_client_instance.models.generate_content.side_effect = Exception("API Error")

        with self.assertRaisesRegex(Exception, "API Error"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_outpainter_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_missing_blob_data(self, mock_genai_client, mock_pil_open):
        """Tests that ValueError is raised when no data is found in the outpainting result."""
        mock_pil_open.return_value = mock.Mock(load=mock.Mock())
        mock_client_instance = mock.Mock()
        mock_genai_client.return_value = mock_client_instance
        mock_response = mock.Mock()
        mock_candidate = mock.Mock()
        mock_content = mock.Mock()
        mock_part = mock.Mock()
        mock_blob = mock.Mock(data=None, mime_type="image/png")
        mock_part.inline_data = mock_blob
        mock_content.parts = [mock_part]
        mock_candidate.content = mock_content
        mock_response.candidates = [mock_candidate]
        mock_client_instance.models.generate_content.return_value = mock_response

        with self.assertRaisesRegex(ValueError, "No data found in the outpainting result"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_outpainter_model,
                self.mock_target_ratio,
            )


if __name__ == "__main__":
    unittest.main()
