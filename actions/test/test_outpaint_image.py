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

"""Unit tests for outpaint_image."""

import io
import unittest
from unittest import mock

from actions import outpaint_image
from common import Key
import PIL.Image


class TestOutpaintImage(unittest.TestCase):
  """Test suite for the outpaint_image action."""

  def setUp(self):
    super().setUp()
    self.mock_gcs = mock.Mock()
    self.mock_workflow_params = {
        Key.GCP_PROJECT.value: 'test-project',
        Key.GCP_LOCATION.value: 'test-location'
    }
    self.mock_image = [{
        Key.FILE.value: 'path/to/image.jpg'
    }]

  @mock.patch('actions_lib.outpainter.outpaint_image')
  def test_execute_correct_ratio(self, mock_outpainter_func):
    """Tests that no resizing happens if the ratio is already correct."""
    # Setup
    target_ratio = '16:9'

    original_image = PIL.Image.new('RGB', (160, 90), color='red')
    img_byte_arr = io.BytesIO()
    original_image.save(img_byte_arr, format='PNG')
    input_bytes = img_byte_arr.getvalue()

    self.mock_gcs.load_bytes.return_value = input_bytes
    self.mock_gcs.store.return_value = 'path/to/stored_image.png'
    self.mock_image[0]['image_instruction'] = 'crop'

    # Execute
    outpaint_image.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.mock_image,
        target_ratio,
        'gemini-3.1-flash-image-preview',
        'test-location'
    )

    # Assertions
    # Outpainting should not be called
    mock_outpainter_func.assert_not_called()
    # But image should still be read from GCS
    self.mock_gcs.load_bytes.assert_called_once_with('path/to/image.jpg')
    # And then WRITTEN back to GCS, as per user feedback
    self.mock_gcs.store.assert_called_once_with(
        input_bytes, 'image.jpg_outpainted.png', 'image/png'
    )

  @mock.patch('actions_lib.outpainter.outpaint_image')
  def test_execute_incorrect_ratio_resizes(self, mock_outpainter_func):
    """Tests that resizing happens if the ratio is incorrect."""
    # Setup
    target_ratio = '1:1'

    # Input image with WRONG ratio (to force outpainting)
    input_img = PIL.Image.new('RGB', (160, 90), color='white')
    input_curr = io.BytesIO()
    input_img.save(input_curr, format='PNG')
    self.mock_gcs.load_bytes.return_value = input_curr.getvalue()
    self.mock_image[0]['image_instruction'] = 'outpaint'
    self.mock_gcs.store.return_value = 'path/to/stored_image.png'

    # Let's return a 100x200 image.
    original_image = PIL.Image.new('RGB', (100, 200), color='blue')
    img_byte_arr = io.BytesIO()
    original_image.save(img_byte_arr, format='PNG')
    outpainted_bytes = img_byte_arr.getvalue()

    mock_outpainter_func.return_value = (outpainted_bytes, 'image/png')

    # Execute
    outpaint_image.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.mock_image,
        target_ratio,
        'gemini-3.1-flash-image-preview',
        'test-location'
    )

    # Verify store was called with DIFFERENT bytes (resized)
    self.mock_gcs.store.assert_called_once()
    stored_bytes = self.mock_gcs.store.call_args[0][0]
    self.assertNotEqual(stored_bytes, outpainted_bytes)

    # Verify the stored image has 1:1 ratio
    with io.BytesIO(stored_bytes) as input_stream:
      img = PIL.Image.open(input_stream)
      self.assertEqual(img.width, img.height)

  @mock.patch('actions_lib.outpainter.outpaint_image')
  def test_execute_skips_outpainting_if_ratio_correct(
      self, mock_outpainter_func
  ):
    """Tests that outpainting is skipped if input image has correct ratio."""
    # Setup
    target_ratio = '16:9'
    # 160x90 is exactly 16:9
    original_image = PIL.Image.new('RGB', (160, 90), color='green')
    img_byte_arr = io.BytesIO()
    original_image.save(img_byte_arr, format='PNG')
    input_bytes = img_byte_arr.getvalue()

    self.mock_gcs.load_bytes.return_value = input_bytes

    # Execute
    result = outpaint_image.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.mock_image,
        target_ratio,
        'gemini-3.1-flash-image-preview',
        'test-location'
    )

    # Assertions
    # Outpainting should not be called
    mock_outpainter_func.assert_not_called()
    # Image should not be stored to GCS again
    self.mock_gcs.store.assert_not_called()

    # Needs to return the original file location directly
    self.assertEqual(
        result,
        {'outpainted_image': [{Key.FILE.value: 'path/to/image.jpg'}]}
    )

  def test_execute_invalid_ratio_raises_error(self):
    """Tests that a ValueError is raised for invalid target_ratio."""
    target_ratio = 'invalid_ratio'

    with self.assertRaisesRegex(ValueError, 'Invalid target_ratio'):
      outpaint_image.execute(
          self.mock_gcs,
          self.mock_workflow_params,
          self.mock_image,
          target_ratio,
          'gemini-3.1-flash-image-preview',
          'test-location'
      )

  @mock.patch('actions_lib.outpainter.outpaint_image')
  def test_execute_resizing_for_various_formats(self, mock_outpainter_func):
    """Tests that resizing fallback works for landscape and portrait formats."""
    # (target_ratio, outpainter_mock_dim, expected_resized_dim)
    test_cases = [
        ('16:9', (160, 100), (160, 90)),   # Trim height
        ('9:16', (100, 160), (90, 160)),   # Trim width
    ]

    for ratio, mock_dim, expected_dim in test_cases:
      with self.subTest(ratio=ratio):
        self.mock_gcs.reset_mock()
        mock_outpainter_func.reset_mock()

        # Initial image is just something different to trigger outpainting
        input_img = PIL.Image.new('RGB', (10, 10), color='white')
        input_curr = io.BytesIO()
        input_img.save(input_curr, format='PNG')
        self.mock_gcs.load_bytes.return_value = input_curr.getvalue()
        self.mock_image[0]['image_instruction'] = 'outpaint'
        self.mock_gcs.store.return_value = 'path/to/stored_image.png'

        # Outpainter returns the mocked dimension
        mock_img = PIL.Image.new('RGB', mock_dim, color='cyan')
        img_byte_arr = io.BytesIO()
        mock_img.save(img_byte_arr, format='PNG')
        mock_outpainter_func.return_value = (
            img_byte_arr.getvalue(), 'image/png'
        )

        outpaint_image.execute(
            self.mock_gcs,
            self.mock_workflow_params,
            self.mock_image,
            ratio,
            'gemini-3.1-flash-image-preview',
            'test-location'
        )

        # Assert store was called and check dimensions
        self.mock_gcs.store.assert_called_once()
        stored_bytes = self.mock_gcs.store.call_args[0][0]
        with io.BytesIO(stored_bytes) as input_stream:
          img = PIL.Image.open(input_stream)
          self.assertEqual(
              img.size, expected_dim,
              f'Failed for ratio {ratio}: expected '
              f'{expected_dim}, got {img.size}')


