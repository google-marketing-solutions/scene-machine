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

"""Tests for veo.py."""

import unittest
from unittest import mock

from actions_lib import veo


def _done_operation_with_video(uri='gs://test-bucket/output.mp4'):
  """A completed operation carrying one generated video."""
  video = mock.Mock()
  video.uri = uri
  entry = mock.Mock()
  entry.video = video
  operation = mock.Mock()
  operation.done = True
  operation.result = mock.Mock(generated_videos=[entry])
  return operation


class TestVeo(unittest.TestCase):
  """Tests for veo.py."""

  def setUp(self):
    super().setUp()
    self.gcp_project = 'test-project'
    self.gcp_location = 'test-location'
    self.prompt = 'A test video prompt'
    self.image_url = 'gs://test-bucket/image.jpg'
    self.image_type = 'image/jpeg'

  def _generate(self, mock_genai_client, model, **kwargs):
    """Runs veo.generate with a mocked client that returns one video."""
    client = mock.Mock()
    mock_genai_client.return_value = client
    client.models.generate_videos.return_value = _done_operation_with_video()
    uris = veo.generate(
        self.gcp_project,
        self.gcp_location,
        self.prompt,
        self.image_url,
        self.image_type,
        model=model,
        **kwargs,
    )
    config = client.models.generate_videos.call_args.kwargs['config']
    return uris, config, client

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_generate_success(self, mock_genai_client, mock_sleep):
    """Returns the video URI without polling."""
    uris, _, client = self._generate(
        mock_genai_client, model='veo-3.1-generate-001')
    self.assertEqual(uris, ['gs://test-bucket/output.mp4'])
    client.models.generate_videos.assert_called_once()
    mock_sleep.assert_not_called()

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_generate_polling_success(self, mock_genai_client, mock_sleep):
    """Polls until the operation is done, then returns the URI."""
    client = mock.Mock()
    mock_genai_client.return_value = client
    pending = mock.Mock(done=False)
    client.models.generate_videos.return_value = pending
    client.operations.get.return_value = _done_operation_with_video()

    uris = veo.generate(
        self.gcp_project, self.gcp_location, self.prompt,
        self.image_url, self.image_type, model='veo-3.1-generate-001')

    self.assertEqual(uris, ['gs://test-bucket/output.mp4'])
    mock_sleep.assert_called_once_with(5)
    client.operations.get.assert_called_once_with(pending)

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_generate_error(self, mock_genai_client, mock_sleep):
    """Raises with the operation's error message when nothing is generated."""
    client = mock.Mock()
    mock_genai_client.return_value = client
    operation = mock.Mock(done=True, result=None, error={'message': 'boom'})
    client.models.generate_videos.return_value = operation

    with self.assertRaisesRegex(RuntimeError, 'No videos generated: boom'):
      veo.generate(
          self.gcp_project, self.gcp_location, self.prompt,
          self.image_url, self.image_type, model='veo-3.1-generate-001')

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_veo31_locks_prompt_and_enables_audio(self, mock_genai_client, _):
    """veo-3.1 is allowlisted with enhance_prompt_locked + supports_audio:
    enhance_prompt is forced True even when False is passed, and generate_audio
    is applied."""
    _, config, _ = self._generate(
        mock_genai_client, model='veo-3.1-generate-001',
        enhance_prompt=False, generate_audio=True)
    self.assertTrue(config.enhance_prompt)
    self.assertTrue(config.generate_audio)

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_veo31_audio_false_is_preserved(self, mock_genai_client, _):
    """supports_audio is set, but a passed generate_audio=False stays False
    (the flag enables the param; it doesn't force audio on)."""
    _, config, _ = self._generate(
        mock_genai_client, model='veo-3.1-generate-001',
        enhance_prompt=True, generate_audio=False)
    self.assertFalse(config.generate_audio)

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_string_false_capability_flags_do_not_enable(self, mock_genai_client, _):
    """A hand-edited catalog can hold "false" (a truthy string) instead of a
    boolean; neither behavior may switch on."""
    with mock.patch.object(
        veo, '_model_capabilities',
        return_value={'enhance_prompt_locked': 'false',
                      'supports_audio': 'false'}):
      _, config, _ = self._generate(
          mock_genai_client, model='veo-3.1-generate-001',
          enhance_prompt=False, generate_audio=True)
    self.assertFalse(config.enhance_prompt)
    self.assertIsNone(getattr(config, 'generate_audio', None))

  @mock.patch('actions_lib.veo.time.sleep')
  @mock.patch('actions_lib.veo.genai.Client')
  def test_unlisted_model_has_no_capability_overrides(
      self, mock_genai_client, _):
    """A model not in the allowlist gets no capability flags: enhance_prompt is
    preserved as passed and generate_audio is never set."""
    _, config, _ = self._generate(
        mock_genai_client, model='veo-2.0-preview',
        enhance_prompt=False, generate_audio=True)
    self.assertFalse(config.enhance_prompt)
    self.assertIsNone(config.generate_audio)


def test_allowlist_generate_video_models_carry_capability_flags():
  """veo.py drives enhance-prompt lock + audio from these flags for any model
  that SERVES generate_video (it keys on the model ID, not on family). So the
  invariant must cover every generate_video model, not just family=='veo' --
  otherwise an entry checked in with a mistyped family and empty capabilities
  escapes the net and silently fails open."""
  from util.model_allowlist import load_allowlist
  video_models = {
      mid: m for mid, m in load_allowlist()['models'].items()
      if 'generate_video' in m.get('actions', [])}
  assert video_models, 'no generate_video models in the allowlist'
  for mid, m in video_models.items():
    caps = m.get('capabilities', {})
    # Real booleans, not merely present: veo.generate applies them with
    # `is True`, so a string "false" would silently disable the behavior.
    assert isinstance(caps.get('supports_audio'), bool), (
        f'{mid}: supports_audio must be a boolean')
    assert isinstance(caps.get('enhance_prompt_locked'), bool), (
        f'{mid}: enhance_prompt_locked must be a boolean')


if __name__ == '__main__':
  unittest.main()
