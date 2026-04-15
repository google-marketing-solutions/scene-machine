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

"""Tests for copy_web_to_gcs."""

import io
import unittest
from unittest import mock

import PIL.Image
import requests
from actions import copy_web_to_gcs
from common import Key
from util.gcs_wrapper import GCS


class TestCopyWebToGcs(unittest.TestCase):
    """Tests for copy_web_to_gcs."""

    @mock.patch("requests.get")
    @mock.patch("PIL.Image.open")
    def test_execute_success_image(self, mock_image_open, mock_requests_get):
        """Tests successful download of an image."""
        mock_gcs = mock.Mock(spec=GCS)
        mock_gcs.load_text.return_value = "http://example.com/test.png"
        mock_gcs.store.return_value = "gs://bucket/test.png"

        mock_response = mock.Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.content = b"fake image bytes"
        mock_requests_get.return_value = mock_response

        mock_img = mock.Mock()
        mock_img.format = "PNG"
        mock_image_open.return_value = mock_img

        urls_input = [{Key.FILE.value: "path/to/urls.txt"}]

        output = copy_web_to_gcs.execute(
            gcs=mock_gcs, _=None, urls=urls_input
        )

        self.assertEqual(output, {"file": [{Key.FILE.value: "gs://bucket/test.png"}]})
        mock_gcs.store.assert_called_once_with(
            b"fake image bytes", "0_test.png", "image/png"
        )

    @mock.patch("requests.get")
    @mock.patch("PIL.Image.open")
    def test_execute_success_opaque_bytes(
        self, mock_image_open, mock_requests_get
    ):
        """Tests Pillow failure and fallback to header."""
        mock_gcs = mock.Mock(spec=GCS)
        mock_gcs.load_text.return_value = "http://example.com/test"
        mock_gcs.store.return_value = "gs://bucket/test.bin"

        mock_response = mock.Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.content = b"raw bytes"
        mock_response.headers = {"content-type": "application/octet-stream"}
        mock_requests_get.return_value = mock_response

        mock_image_open.side_effect = PIL.UnidentifiedImageError()

        urls_input = [{Key.FILE.value: "path/to/urls.txt"}]

        output = copy_web_to_gcs.execute(
            gcs=mock_gcs, _=None, urls=urls_input
        )

        self.assertEqual(output, {"file": [{Key.FILE.value: "gs://bucket/test.bin"}]})
        # Fallback resolves extension from content type split or raw name
        # Line 73: dot_extension = f'.{content_type.split("/")[-1]}' -> .octet-stream
        mock_gcs.store.assert_called_once_with(
            b"raw bytes", "0_test.octet-stream", "application/octet-stream"
        )

    @mock.patch("requests.get")
    def test_execute_request_exception(self, mock_requests_get):
        """Tests handling of requests exceptions."""
        mock_gcs = mock.Mock(spec=GCS)
        mock_gcs.load_text.return_value = "http://example.com/test.png"

        mock_requests_get.side_effect = requests.RequestException("connection failed")

        urls_input = [{Key.FILE.value: "path/to/urls.txt"}]

        output = copy_web_to_gcs.execute(
            gcs=mock_gcs, _=None, urls=urls_input
        )

        # Should return empty list of files on failure
        self.assertEqual(output, {"file": []})


if __name__ == "__main__":
    unittest.main()
