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

"""Tests for image_describer."""

import unittest
from unittest import mock

from actions_lib import image_describer


class TestImageDescriber(unittest.TestCase):
  """Tests for image_describer."""

  @mock.patch('actions_lib.gemini.prompt')
  def test_describe_image_with_guidance(self, mock_prompt):
    """Tests describe_image with guidance provided."""
    mock_prompt.return_value = '{"cinematography": {}}'  # Dummy response

    result = image_describer.describe_image(
        image_path='gs://bucket/image.png',
        guidance='a red car',
        gcp_project='test-proj',
        gemini_model='gemini-2.5-flash',
    )

    self.assertEqual(result, '{"cinematography": {}}')
    mock_prompt.assert_called_once()
    args, kwargs = mock_prompt.call_args
    self.assertEqual(kwargs['gcp_project'], 'test-proj')
    self.assertEqual(kwargs['model'], 'gemini-2.5-flash')
    self.assertEqual(kwargs['file_uris'], ['gs://bucket/image.png'])
    self.assertIn(
        'This identifies the focus object of the image: a red car',
        kwargs['text_prompt']
    )

  @mock.patch('actions_lib.gemini.prompt')
  def test_describe_image_without_guidance(self, mock_prompt):
    """Tests describe_image without guidance."""
    mock_prompt.return_value = '{"cinematography": {}}'  # Dummy response

    result = image_describer.describe_image(
        image_path='gs://bucket/image.png',
        guidance='',
        gcp_project='test-proj',
        gemini_model='gemini-2.5-flash',
    )

    self.assertEqual(result, '{"cinematography": {}}')
    mock_prompt.assert_called_once()
    args, kwargs = mock_prompt.call_args
    self.assertEqual(kwargs['gcp_project'], 'test-proj')
    self.assertNotIn(
        'This identifies the focus object of the image',
        kwargs['text_prompt']
    )

if __name__ == '__main__':
  unittest.main()
