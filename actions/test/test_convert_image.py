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

"""Tests for convert_image action."""

import io
import unittest
from unittest import mock

import PIL.Image

from actions import convert_image
from common import Key
from util.gcs_wrapper import GCS


class TestConvertImage(unittest.TestCase):
  """Test cases for the convert_image action."""

  def setUp(self):
    """Set up the test environment."""
    super().setUp()
    self.mock_gcs = mock.create_autospec(GCS, instance=True)
    self.mock_image = mock.create_autospec(PIL.Image.Image, instance=True)
    self.mock_image.format = "JPEG"

    # Create some dummy image bytes
    buffer = io.BytesIO()
    PIL.Image.new("RGB", (10, 10)).save(buffer, "jpeg")
    self.image_bytes = buffer.getvalue()

  @mock.patch("PIL.Image.open")
  def test_execute_no_conversion_needed(self, mock_image_open):
    """Tests that no conversion is done if image is already in a target format."""
    mock_image_open.return_value = self.mock_image
    self.mock_gcs.load_bytes.return_value = self.image_bytes

    input_path = "test/image.jpg"
    file_input = [{Key.FILE.value: input_path}]
    output_mime_types = "image/jpeg, image/png"

    result = convert_image.execute(
        self.mock_gcs, {}, file_input, output_mime_types
    )

    self.mock_gcs.load_bytes.assert_called_once_with(input_path)
    mock_image_open.assert_called_once()
    self.mock_gcs.store.assert_not_called()
    self.assertEqual(result["image"][0][Key.FILE.value], input_path)

  @mock.patch("actions_lib.image_converter.convert")
  @mock.patch("PIL.Image.open")
  def test_execute_conversion_needed(self, mock_image_open, mock_convert):
    """Tests that conversion is done when the image is not in a target format."""
    self.mock_image.format = "GIF"
    mock_image_open.return_value = self.mock_image
    self.mock_gcs.load_bytes.return_value = self.image_bytes
    mock_convert.return_value = b"converted_bytes"
    converted_path = "test/image_converted.png"
    self.mock_gcs.store.return_value = converted_path

    input_path = "test/image.gif"
    file_input = [{Key.FILE.value: input_path}]
    output_mime_types = "image/png, image/jpeg"

    result = convert_image.execute(
        self.mock_gcs, {}, file_input, output_mime_types
    )

    self.mock_gcs.load_bytes.assert_called_once_with(input_path)
    mock_image_open.assert_called_once()
    mock_convert.assert_called_once_with(self.image_bytes, "png")
    self.mock_gcs.store.assert_called_once_with(
        b"converted_bytes", "image.gif_converted.png", "image/png"
    )
    self.assertEqual(result["image"][0][Key.FILE.value], converted_path)

  @mock.patch("actions_lib.image_converter.convert")
  @mock.patch("PIL.Image.open")
  def test_execute_single_output_format(self, mock_image_open, mock_convert):
    """Tests conversion with a single output format."""
    self.mock_image.format = "GIF"
    mock_image_open.return_value = self.mock_image
    self.mock_gcs.load_bytes.return_value = self.image_bytes
    mock_convert.return_value = b"converted_bytes"
    converted_path = "test/image_converted.bmp"
    self.mock_gcs.store.return_value = converted_path

    input_path = "test/image.gif"
    file_input = [{Key.FILE.value: input_path}]
    output_mime_types = "image/bmp"

    result = convert_image.execute(
        self.mock_gcs, {}, file_input, output_mime_types
    )

    self.mock_gcs.load_bytes.assert_called_once_with(input_path)
    mock_image_open.assert_called_once()
    mock_convert.assert_called_once_with(self.image_bytes, "bmp")
    self.mock_gcs.store.assert_called_once_with(
        b"converted_bytes", "image.gif_converted.bmp", "image/bmp"
    )
    self.assertEqual(result["image"][0][Key.FILE.value], converted_path)

  @mock.patch("actions_lib.image_converter.convert")
  @mock.patch("PIL.Image.open")
  def test_execute_unsupported_pil_type(self, mock_image_open, mock_convert):
    """Tests that a ValueError is raised for unsupported types."""
    self.mock_image.format = "GIF"
    mock_image_open.return_value = self.mock_image
    self.mock_gcs.load_bytes.return_value = self.image_bytes
    mock_convert.side_effect = ValueError("Unsupported format")

    input_path = "test/image.gif"
    file_input = [{Key.FILE.value: input_path}]
    output_mime_types = "image/unsupported"

    with self.assertRaises(ValueError):
      convert_image.execute(self.mock_gcs, {}, file_input, output_mime_types)

  def test_execute_malformed_mime_type(self):
    """Tests that an IndexError is raised for a malformed mime type string."""
    input_path = "test/image.jpg"
    file_input = [{Key.FILE.value: input_path}]
    output_mime_types = "invalid-mime-type"

    with self.assertRaises(IndexError):
      convert_image.execute(self.mock_gcs, {}, file_input, output_mime_types)


if __name__ == "__main__":
  unittest.main()
