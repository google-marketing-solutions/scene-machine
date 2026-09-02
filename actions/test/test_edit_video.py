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

"""Unit tests for edit_video."""

import unittest
from unittest import mock

from actions import edit_video
from actions_lib import omni
import actions_wrapper
from common import Key


class TestEditVideo(unittest.TestCase):
  """Test suite for the edit_video action."""

  def setUp(self):
    super().setUp()
    self.mock_gcs = mock.MagicMock()
    self.mock_gcs.load_text.return_value = 'edit the video'
    self.mock_gcs.get_uri.side_effect = lambda path: 'gs://b/' + path
    self.mock_gcs.get_mime_type.return_value = 'video/mp4'
    self.mock_gcs.get_path_uri.return_value = 'gs://b/edit_video/abc/'
    self.mock_gcs.strip_prefix.side_effect = lambda uri: uri.removeprefix(
        'gs://b/'
    )
    self.mock_workflow_params = {
        Key.GCP_PROJECT.value: 'test-project',
        Key.GCP_LOCATION.value: 'test-location',
    }
    self.video = [{Key.FILE.value: 'generate_video/x/sample_0.mp4'}]
    self.prompt = [{Key.FILE.value: 'path/to/prompt.txt'}]

  @mock.patch('actions.edit_video.omni.edit')
  def test_happy_path_calls_omni_edit_and_returns_edited_video(
      self, mock_omni_edit
  ):
    """omni.edit is called with exactly the expected kwargs."""
    mock_omni_edit.return_value = 'gs://b/edit_video/abc/edited.mp4'

    result = edit_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.video,
        self.prompt,
        'gemini-omni-1.1-flash-preview',
        'global',
    )

    mock_omni_edit.assert_called_once_with(
        gcp_project='test-project',
        gcp_location='global',
        prompt='edit the video',
        video_uri='gs://b/generate_video/x/sample_0.mp4',
        video_mime='video/mp4',
        model='gemini-omni-1.1-flash-preview',
        output_gcs='gs://b/edit_video/abc/',
    )
    self.assertEqual(
        result,
        {'edited_video': [{Key.FILE.value: 'edit_video/abc/edited.mp4'}]},
    )

  @mock.patch('actions.edit_video.omni.edit')
  def test_missing_video_returns_empty_and_skips_omni(self, mock_omni_edit):
    """No video input short-circuits before calling omni.edit."""
    result = edit_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        [],
        self.prompt,
        'gemini-omni-1.1-flash-preview',
        'global',
    )

    self.assertEqual(result, {'edited_video': []})
    mock_omni_edit.assert_not_called()

  @mock.patch('actions.edit_video.omni.edit')
  def test_missing_prompt_returns_empty_and_skips_omni(self, mock_omni_edit):
    """No prompt input short-circuits before calling omni.edit."""
    result = edit_video.execute(
        self.mock_gcs,
        self.mock_workflow_params,
        self.video,
        [],
        'gemini-omni-1.1-flash-preview',
        'global',
    )

    self.assertEqual(result, {'edited_video': []})
    mock_omni_edit.assert_not_called()

  @mock.patch('actions.edit_video.omni.edit')
  def test_wrapper_wires_node_inputs_by_name(self, mock_omni_edit):
    """The wrapper wires video/prompt from input_files via NodeInput.

    A module without `from __future__ import annotations` would silently
    receive no inputs here.
    """
    mock_omni_edit.return_value = 'gs://b/edit_video/abc/edited.mp4'

    result = actions_wrapper._generic_function_caller(
        self.mock_gcs,
        {'video': self.video, 'prompt': self.prompt},
        {
            'model': 'gemini-omni-1.1-flash-preview',
            'gcp_location': 'global',
        },
        self.mock_workflow_params,
        edit_video.execute,
    )

    mock_omni_edit.assert_called_once_with(
        gcp_project='test-project',
        gcp_location='global',
        prompt='edit the video',
        video_uri='gs://b/generate_video/x/sample_0.mp4',
        video_mime='video/mp4',
        model='gemini-omni-1.1-flash-preview',
        output_gcs='gs://b/edit_video/abc/',
    )
    self.assertEqual(
        result,
        {'edited_video': [{Key.FILE.value: 'edit_video/abc/edited.mp4'}]},
    )

  @mock.patch('actions.edit_video.omni.edit')
  def test_omni_error_propagates_unchanged(self, mock_omni_edit):
    """The action does not catch OmniError; the wrapper handles it."""
    mock_omni_edit.side_effect = omni.OmniError('boom')

    with self.assertRaisesRegex(omni.OmniError, 'boom'):
      edit_video.execute(
          self.mock_gcs,
          self.mock_workflow_params,
          self.video,
          self.prompt,
          'gemini-omni-1.1-flash-preview',
          'global',
      )


if __name__ == '__main__':
  unittest.main()
