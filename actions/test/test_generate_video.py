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

"""Unit tests for generate_video."""

import unittest
from unittest import mock

from actions import generate_video
from common import Key


class TestGenerateVideo(unittest.TestCase):
  """Test suite for the generate_video action."""

  def setUp(self):
    super().setUp()
    self.mock_gcs = mock.MagicMock()
    self.mock_gcs.load_text.return_value = 'a prompt'
    self.mock_gcs.get_uri.return_value = 'gs://b/image.png'
    self.mock_gcs.get_mime_type.return_value = 'image/png'
    self.mock_gcs.get_path_uri.return_value = 'gs://b/generate_video/abc/'
    self.mock_gcs.strip_prefix.side_effect = lambda uri: uri.removeprefix(
        'gs://b/'
    )
    self.mock_workflow_params = {
        Key.GCP_PROJECT.value: 'test-project',
        Key.GCP_LOCATION.value: 'test-location',
    }
    self.prompt = [{Key.FILE.value: 'path/to/prompt.txt'}]

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_veo_family_calls_veo_not_omni(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """A veo-family model calls veo.generate with the current kwargs."""
    mock_load_allowlist.return_value = {
        'models': {
            'veo-x': {'family': 'veo'},
            'omni-x': {'family': 'omni'},
        }
    }
    mock_veo_generate.return_value = [
        'gs://b/generate_video/abc/0.mp4',
        'gs://b/generate_video/abc/1.mp4',
    ]

    result = generate_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.prompt,
        [],
        '16:9',
        8,
        2,
        '',
        '',
        'veo-x',
        False,
        '720p',
    )

    mock_veo_generate.assert_called_once_with(
        gcp_project='test-project',
        gcp_location='test-location',
        prompt='a prompt',
        image_url=None,
        image_type=None,
        duration_seconds=8,
        amount=2,
        aspect_ratio='16:9',
        resolution='720p',
        output_gcs='gs://b/generate_video/abc/',
        model='veo-x',
        generate_audio=False,
    )
    mock_omni_generate.assert_not_called()
    self.assertEqual(
        result,
        {
            'video': [
                {
                    Key.FILE.value: 'generate_video/abc/0.mp4',
                    'video_variant_id': '0',
                },
                {
                    Key.FILE.value: 'generate_video/abc/1.mp4',
                    'video_variant_id': '1',
                },
            ]
        },
    )

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_omni_family_calls_omni_not_veo(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """An omni-family model calls omni.generate, not veo.generate."""
    mock_load_allowlist.return_value = {
        'models': {
            'veo-x': {'family': 'veo'},
            'omni-x': {'family': 'omni'},
        }
    }
    mock_omni_generate.return_value = ['gs://b/generate_video/abc/0.mp4']

    result = generate_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.prompt,
        [],
        '16:9',
        8,
        1,
        '',
        '',
        'omni-x',
        False,
        '720p',
    )

    mock_omni_generate.assert_called_once_with(
        gcp_project='test-project',
        gcp_location='test-location',
        prompt='a prompt',
        image_url=None,
        image_type=None,
        duration_seconds=8,
        amount=1,
        aspect_ratio='16:9',
        resolution='720p',
        output_gcs='gs://b/generate_video/abc/',
        model='omni-x',
    )
    mock_veo_generate.assert_not_called()
    self.assertEqual(
        result,
        {
            'video': [{
                Key.FILE.value: 'generate_video/abc/0.mp4',
                'video_variant_id': '0',
            }]
        },
    )

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_omni_family_with_image_uses_gcs_uri_and_mime(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """An omni-family model with an input image passes its uri and mime."""
    mock_load_allowlist.return_value = {
        'models': {'omni-x': {'family': 'omni'}}
    }
    mock_omni_generate.return_value = ['gs://b/generate_video/abc/0.mp4']
    image = [{Key.FILE.value: 'path/to/image.jpg'}]

    generate_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.prompt,
        image,
        '16:9',
        8,
        1,
        '',
        '',
        'omni-x',
        False,
        '720p',
    )

    self.mock_gcs.get_uri.assert_called_once_with('path/to/image.jpg')
    self.mock_gcs.get_mime_type.assert_called_once_with('path/to/image.jpg')
    self.assertEqual(
        mock_omni_generate.call_args.kwargs['image_url'], 'gs://b/image.png'
    )
    self.assertEqual(
        mock_omni_generate.call_args.kwargs['image_type'], 'image/png'
    )
    mock_veo_generate.assert_not_called()

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_unknown_family_raises_value_error(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """A model missing from the catalog raises ValueError, calls neither."""
    mock_load_allowlist.return_value = {'models': {}}

    with self.assertRaisesRegex(ValueError, 'missing-model'):
      generate_video.execute(
          self.mock_gcs,
          self.mock_workflow_params,
          self.prompt,
          [],
          '16:9',
          8,
          1,
          '',
          '',
          'missing-model',
          False,
          '720p',
      )

    mock_veo_generate.assert_not_called()
    mock_omni_generate.assert_not_called()

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_unsupported_family_raises_value_error(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """A model with an unrecognized family raises ValueError."""
    mock_load_allowlist.return_value = {
        'models': {'gemini-x': {'family': 'gemini'}}
    }

    with self.assertRaisesRegex(ValueError, 'gemini-x'):
      generate_video.execute(
          self.mock_gcs,
          self.mock_workflow_params,
          self.prompt,
          [],
          '16:9',
          8,
          1,
          '',
          '',
          'gemini-x',
          False,
          '720p',
      )

    mock_veo_generate.assert_not_called()
    mock_omni_generate.assert_not_called()

  @mock.patch('actions.generate_video.model_allowlist.load_allowlist')
  @mock.patch('actions.generate_video.omni.generate')
  @mock.patch('actions.generate_video.veo.generate')
  def test_empty_prompt_returns_empty_video_list(
      self, mock_veo_generate, mock_omni_generate, mock_load_allowlist
  ):
    """An empty prompt short-circuits before the catalog or either library."""
    result = generate_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        [],
        [],
        '16:9',
        8,
        1,
        '',
        '',
        'veo-x',
        False,
        '720p',
    )

    self.assertEqual(result, {'video': []})
    mock_load_allowlist.assert_not_called()
    mock_veo_generate.assert_not_called()
    mock_omni_generate.assert_not_called()


if __name__ == '__main__':
  unittest.main()
