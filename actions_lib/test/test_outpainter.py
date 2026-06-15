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

from google.genai.types import ThinkingLevel

from actions_lib import outpainter


class TestOutpainter(unittest.TestCase):
    """Tests for outpainter.py."""

    def setUp(self):
        super().setUp()
        outpainter._THINKING_SUPPORT.clear()  # isolate the per-model cache
        self.mock_image_bytes = b"mock_image_data"
        self.mock_gcp_project = "test-project"
        self.mock_gcp_location = "global"
        self.mock_image_model = "gemini-3-pro-image"
        self.mock_target_ratio = "16:9"
        self.mock_outpainted_bytes = b"mock_outpainted_image_bytes"

    def _mock_image(self, width=1024, height=768):
        img = mock.Mock()
        img.load.return_value = None
        img.width = width
        img.height = height
        return img

    def _mock_client(self, thinking=True):
        client = mock.Mock()
        client.models.get.return_value.thinking = thinking
        return client

    def _success_response(self):
        blob = mock.Mock(data=self.mock_outpainted_bytes, mime_type="image/png")
        part = mock.Mock()
        part.inline_data = blob
        content = mock.Mock()
        content.parts = [part]
        candidate = mock.Mock()
        candidate.content = content
        response = mock.Mock()
        response.candidates = [candidate]
        return response

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_success(self, mock_genai_client, mock_pil_open):
        """Builds the Vertex request correctly and returns the image."""
        mock_image = self._mock_image()

        # The byte stream is closed after load(), so assert it during open().
        def check_stream_and_return_mock(stream):
            self.assertEqual(stream.getvalue(), self.mock_image_bytes)
            return mock_image

        mock_pil_open.side_effect = check_stream_and_return_mock

        mock_client = self._mock_client(thinking=True)
        mock_genai_client.return_value = mock_client
        mock_client.models.generate_content.return_value = self._success_response()

        result = outpainter.outpaint_image(
            self.mock_image_bytes,
            self.mock_gcp_project,
            self.mock_gcp_location,
            self.mock_image_model,
            self.mock_target_ratio,
        )

        self.assertEqual(result, (self.mock_outpainted_bytes, "image/png"))
        mock_image.load.assert_called_once()
        mock_genai_client.assert_called_once_with(
            vertexai=True,
            project=self.mock_gcp_project,
            location=self.mock_gcp_location,
            http_options=mock.ANY,
        )
        mock_client.models.get.assert_called_once_with(model=self.mock_image_model)

        mock_client.models.generate_content.assert_called_once()
        _, kwargs = mock_client.models.generate_content.call_args
        self.assertEqual(kwargs["model"], self.mock_image_model)

        # contents = [prompt, source image, blank target-ratio canvas]
        contents = kwargs["contents"]
        self.assertEqual(len(contents), 3)
        self.assertIn("OUTPAINTING", contents[0])
        self.assertIn(self.mock_target_ratio, contents[0])
        self.assertNotIn("{target_ratio}", contents[0])  # token substituted
        self.assertIs(contents[1], mock_image)
        self.assertIsInstance(contents[2], outpainter.PIL.Image.Image)
        self.assertEqual(
            contents[2].size, outpainter._target_canvas_size(1024, 768, 16, 9)
        )

        config = kwargs["config"]
        self.assertEqual(config.image_config.aspect_ratio, self.mock_target_ratio)
        # 1024x768 -> 16:9 canvas (~1365x768), long edge < 3072 -> 2K
        self.assertEqual(config.image_config.image_size, "2K")
        self.assertEqual(
            config.thinking_config.thinking_level, ThinkingLevel.HIGH
        )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_thinking_skipped_when_unsupported(
        self, mock_genai_client, mock_pil_open
    ):
        """No thinking_config is sent when the model lacks thinking support."""
        mock_pil_open.return_value = self._mock_image()
        mock_client = self._mock_client(thinking=None)
        mock_genai_client.return_value = mock_client
        mock_client.models.generate_content.return_value = self._success_response()

        outpainter.outpaint_image(
            self.mock_image_bytes,
            self.mock_gcp_project,
            self.mock_gcp_location,
            self.mock_image_model,
            self.mock_target_ratio,
        )

        _, kwargs = mock_client.models.generate_content.call_args
        self.assertIsNone(kwargs["config"].thinking_config)

    def test_supports_thinking_failure_not_cached(self):
        """A lookup error returns False but is not memoized, so the next call retries."""
        client = mock.Mock()
        client.models.get.side_effect = [
            Exception("transient"),
            mock.Mock(thinking=True),
        ]

        self.assertFalse(
            outpainter._supports_thinking(client, self.mock_image_model)
        )
        self.assertTrue(
            outpainter._supports_thinking(client, self.mock_image_model)
        )
        self.assertEqual(client.models.get.call_count, 2)

    def test_supports_thinking_falsy_result_cached(self):
        """A successful no-thinking result is cached, so there is no re-query."""
        client = mock.Mock()
        client.models.get.return_value.thinking = None

        self.assertFalse(
            outpainter._supports_thinking(client, self.mock_image_model)
        )
        self.assertFalse(
            outpainter._supports_thinking(client, self.mock_image_model)
        )
        client.models.get.assert_called_once_with(model=self.mock_image_model)

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_no_candidates(self, mock_genai_client, mock_pil_open):
        """Raises when the response contains no candidates."""
        mock_pil_open.return_value = self._mock_image()
        mock_client = self._mock_client()
        mock_genai_client.return_value = mock_client
        mock_client.models.generate_content.return_value = mock.Mock(candidates=[])

        with self.assertRaisesRegex(ValueError, "did not contain any candidates"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_image_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_no_inline_data(
        self, mock_genai_client, mock_pil_open
    ):
        """Raises when the first part has no inline data."""
        mock_pil_open.return_value = self._mock_image()
        mock_client = self._mock_client()
        mock_genai_client.return_value = mock_client
        response = self._success_response()
        response.candidates[0].content.parts[0].inline_data = None
        mock_client.models.generate_content.return_value = response

        with self.assertRaisesRegex(ValueError, "did not contain any inline data"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_image_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_missing_blob_data(
        self, mock_genai_client, mock_pil_open
    ):
        """Raises when the inline data carries no bytes."""
        mock_pil_open.return_value = self._mock_image()
        mock_client = self._mock_client()
        mock_genai_client.return_value = mock_client
        response = self._success_response()
        response.candidates[0].content.parts[0].inline_data = mock.Mock(
            data=None, mime_type="image/png"
        )
        mock_client.models.generate_content.return_value = response

        with self.assertRaisesRegex(
            ValueError, "No data found in the outpainting result"
        ):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_image_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    def test_outpaint_image_pil_error(self, mock_pil_open):
        """Propagates PIL errors raised while opening the image."""
        mock_pil_open.side_effect = IOError("Failed to open image")
        with self.assertRaises(IOError):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_image_model,
                self.mock_target_ratio,
            )

    @mock.patch("actions_lib.outpainter.PIL.Image.open")
    @mock.patch("actions_lib.outpainter.genai.Client")
    def test_outpaint_image_api_error(self, mock_genai_client, mock_pil_open):
        """Propagates errors raised by the GenAI API call."""
        mock_pil_open.return_value = self._mock_image()
        mock_client = self._mock_client()
        mock_genai_client.return_value = mock_client
        mock_client.models.generate_content.side_effect = Exception("API Error")

        with self.assertRaisesRegex(Exception, "API Error"):
            outpainter.outpaint_image(
                self.mock_image_bytes,
                self.mock_gcp_project,
                self.mock_gcp_location,
                self.mock_image_model,
                self.mock_target_ratio,
            )


    def test_pick_image_size(self):
        """2K for modest canvases, 4K past the midpoint; never 1K."""
        self.assertEqual(outpainter._pick_image_size(2752, 1548), "2K")
        self.assertEqual(outpainter._pick_image_size(3072, 1728), "2K")  # boundary
        self.assertEqual(outpainter._pick_image_size(4892, 2752), "4K")

    def test_target_canvas_size_rejects_nonpositive(self):
        """Non-positive dimensions raise instead of dividing by zero."""
        with self.assertRaises(ValueError):
            outpainter._target_canvas_size(1024, 0, 16, 9)


if __name__ == "__main__":
    unittest.main()
