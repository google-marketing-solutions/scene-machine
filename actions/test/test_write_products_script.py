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

"""Tests for write_products_script."""

import unittest
from unittest import mock

from actions import write_products_script
from common import Dimension
from common import Key


class TestWriteProductsScript(unittest.TestCase):
  """Tests for write_products_script."""

  @mock.patch('actions_lib.gemini.prompt')
  def test_execute_success(self, mock_prompt):
    """Tests successful execution."""
    mock_gcs = mock.Mock()
    mock_gcs.load_text.side_effect = [
        "Test briefing",  # for briefing
        "Product 1 desc",  # for product description
        "Image 1 desc",  # for image description
    ]
    mock_gcs.store.return_value = "gs://bucket/file.txt"

    mock_prompt.return_value = {
        "style": "Test style",
        "scenes": [
            {
                Dimension.PRODUCT_ID.value: "P001",
                Dimension.IMAGE_ID.value: "I001",
                "scene": "Scene 1 description",
            }
        ],
    }

    workflow_params = {Key.GCP_PROJECT.value: "test-proj"}
    briefing = [{Key.FILE.value: "gs://bucket/briefing.txt"}]
    product_description = [
        {Dimension.PRODUCT_ID.value: "P001", Key.FILE.value: "gs://bucket/p1.txt"}
    ]
    image_description = [
        {
            Dimension.PRODUCT_ID.value: "P001",
            Dimension.IMAGE_ID.value: "I001",
            Key.FILE.value: "gs://bucket/i1.txt",
        }
    ]

    result = write_products_script.execute(
        gcs=mock_gcs,
        workflow_params=workflow_params,
        briefing=briefing,
        product_description=product_description,
        image_description=image_description,
        story_variant_quantity=1,
        gemini_model="gemini-2.5-flash",
        gemini_model_location="us-central1",
    )

    self.assertIn("script", result)
    self.assertIn("style", result)
    self.assertEqual(len(result["script"]), 1)
    self.assertEqual(result["script"][0][Key.FILE.value], "gs://bucket/file.txt")

  @mock.patch('actions_lib.gemini.prompt')
  def test_execute_retry_on_invalid_combination(self, mock_prompt):
    """Tests that action retries on invalid product/image combination."""
    mock_gcs = mock.Mock()
    mock_gcs.load_text.return_value = "dummy"
    mock_gcs.store.return_value = "gs://bucket/file.txt"

    # First call returns invalid combination, second returns valid
    mock_prompt.side_effect = [
        {
            "style": "Style",
            "scenes": [
                {
                    Dimension.PRODUCT_ID.value: "P001",
                    Dimension.IMAGE_ID.value: "I999",  # Invalid
                    "scene": "Scene",
                }
            ],
        },
        {
            "style": "Style",
            "scenes": [
                {
                    Dimension.PRODUCT_ID.value: "P001",
                    Dimension.IMAGE_ID.value: "I001",  # Valid
                    "scene": "Scene",
                }
            ],
        },
    ]

    workflow_params = {Key.GCP_PROJECT.value: "test-proj"}
    briefing = []
    product_description = [
        {Dimension.PRODUCT_ID.value: "P001", Key.FILE.value: "gs://bucket/p1.txt"}
    ]
    image_description = [
        {
            Dimension.PRODUCT_ID.value: "P001",
            Dimension.IMAGE_ID.value: "I001",
            Key.FILE.value: "gs://bucket/i1.txt",
        }
    ]

    result = write_products_script.execute(
        gcs=mock_gcs,
        workflow_params=workflow_params,
        briefing=briefing,
        product_description=product_description,
        image_description=image_description,
        story_variant_quantity=1,
        gemini_model="gemini-2.5-flash",
        gemini_model_location="us-central1",
    )

    self.assertEqual(mock_prompt.call_count, 2)
    self.assertEqual(len(result["script"]), 1)

  @mock.patch('actions_lib.gemini.prompt')
  def test_execute_raises_runtime_error(self, mock_prompt):
    """Tests that action raises RuntimeError after repeated failures."""
    mock_gcs = mock.Mock()
    mock_gcs.load_text.return_value = "dummy"

    # All calls return invalid combination
    mock_prompt.return_value = {
        "style": "Style",
        "scenes": [
            {
                Dimension.PRODUCT_ID.value: "P001",
                Dimension.IMAGE_ID.value: "I999",
                "scene": "Scene",
            }
        ],
    }

    workflow_params = {Key.GCP_PROJECT.value: "test-proj"}
    briefing = []
    product_description = [
        {Dimension.PRODUCT_ID.value: "P001", Key.FILE.value: "gs://bucket/p1.txt"}
    ]
    image_description = [
        {
            Dimension.PRODUCT_ID.value: "P001",
            Dimension.IMAGE_ID.value: "I001",
            Key.FILE.value: "gs://bucket/i1.txt",
        }
    ]

    with self.assertRaises(RuntimeError):
      write_products_script.execute(
          gcs=mock_gcs,
          workflow_params=workflow_params,
          briefing=briefing,
          product_description=product_description,
          image_description=image_description,
          story_variant_quantity=1,
          gemini_model="gemini-2.5-flash",
          gemini_model_location="us-central1",
      )


if __name__ == '__main__':
  unittest.main()
