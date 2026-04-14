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

"""Tests for image_converter."""

import io
import unittest

from actions_lib import image_converter
import PIL


class TestImageConverter(unittest.TestCase):
  """Tests for image_converter."""

  def _create_dummy_image_bytes(self, image_format='PNG'):
    """Helper to create dummy image bytes for testing."""
    img = PIL.Image.new('RGB', (10, 10), color='red')
    byte_arr = io.BytesIO()
    img.save(byte_arr, format=image_format)
    return byte_arr.getvalue()

  def test_convert_avif_to_png(self):
    """Tests successful conversion from AVIF to PNG."""
    avif_bytes = self._create_dummy_image_bytes(image_format='AVIF')
    converted_png_bytes = image_converter.convert(avif_bytes, 'PNG')

    self.assertIsInstance(converted_png_bytes, bytes)
    self.assertGreater(len(converted_png_bytes), 0)

    # Verify the output is a valid PNG
    with io.BytesIO(converted_png_bytes) as f:
      img = PIL.Image.open(f)
      self.assertEqual(img.format, 'PNG')
      img.load()  # Ensure it can be loaded without errors

  def test_convert_same_format(self):
    """Tests converting an image to its own format (e.g., PNG to PNG)."""
    png_bytes = self._create_dummy_image_bytes(image_format='PNG')
    converted_png_bytes = image_converter.convert(png_bytes, 'PNG')

    self.assertIsInstance(converted_png_bytes, bytes)
    self.assertGreater(len(converted_png_bytes), 0)

    # Verify the output is a valid PNG
    with io.BytesIO(converted_png_bytes) as f:
      img = PIL.Image.open(f)
      self.assertEqual(img.format, 'PNG')
      img.load()  # Ensure it can be loaded without errors

  def test_convert_unsupported_output_format_raises_value_error(self):
    """Tests that converting to an unsupported output format raises ValueError."""
    png_bytes = self._create_dummy_image_bytes(image_format='PNG')
    with self.assertRaises(ValueError):
      image_converter.convert(png_bytes, 'UNSUPPORTED')

  def test_convert_invalid_input_image_raises_unidentified_image_error(self):
    """Tests that providing invalid input bytes raises PIL.UnidentifiedImageError."""
    invalid_bytes = b'this is not a valid image file'
    with self.assertRaises(PIL.UnidentifiedImageError):
      image_converter.convert(invalid_bytes, 'PNG')
