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

"""Tests for omni.py.

Offline only: every test drives a real `genai.Client` over
`httpx.MockTransport`, so assertions see the SDK's actual request bodies and
raise the SDK's actual exception classes -- nothing here is hand-built.
"""

import json
import unittest
from unittest import mock

import httpx
from actions_lib import omni
from google import genai
from google.auth import credentials
from google.genai import types
from util import errors


class _StaticCredentials(credentials.Credentials):
  """Fake credentials so the client never touches real auth."""

  def __init__(self):
    super().__init__()
    self.token = 'fake-token'

  def refresh(self, request):
    del request  # Unused.
    self.token = 'fake-token'

  @property
  def expired(self):
    return False

  @property
  def valid(self):
    return True


class _Handler:
  """Records every request and answers with the next queued response.

  A queued response is a `(status, payload)` pair, or a callable that takes
  the request's parsed JSON body and returns one -- used to build a
  `completed` reply whose `gcs_uri` matches whatever the request just sent.
  """

  def __init__(self):
    self.requests = []
    self._responses = []

  def queue(self, status, payload):
    self._responses.append(lambda _body: (status, payload))

  def queue_completed_from_request(self, interaction_id='int-done'):
    """Answers a create with `completed` under the request's own gcs_uri."""

    def _respond(body):
      gcs_uri = body['response_format']['gcs_uri']
      return (
          200,
          {
              'id': interaction_id,
              'status': 'completed',
              'output_video': {
                  'type': 'video',
                  'uri': gcs_uri + 'clip.mp4',
                  'mime_type': 'video/mp4',
              },
          },
      )

    self._responses.append(_respond)

  def __call__(self, request):
    body = json.loads(request.content) if request.content else None
    self.requests.append({
        'method': request.method,
        'body': body,
        'timeout': request.extensions.get('timeout'),
    })
    status, payload = self._responses.pop(0)(body)
    return httpx.Response(status, json=payload, request=request)

  @property
  def posts(self):
    return [r for r in self.requests if r['method'] == 'POST']

  @property
  def gets(self):
    return [r for r in self.requests if r['method'] == 'GET']


def _completed_payload(prefix, interaction_id='int-done', suffix='clip.mp4'):
  """A `completed` body whose video URI lives under `prefix`."""
  return {
      'id': interaction_id,
      'status': 'completed',
      'output_video': {
          'type': 'video',
          'uri': prefix + suffix,
          'mime_type': 'video/mp4',
      },
  }


class TestOmni(unittest.TestCase):
  """Tests for omni.py."""

  def setUp(self):
    super().setUp()
    self.gcp_project = 'test-project'
    self.gcp_location = 'global'
    self.model = 'gemini-omni-1.1-flash-preview'
    self.output_gcs = 'gs://out-bucket/omni'
    self.prompt = 'a red fox running through snow'

  def _client_for(self, handler):
    """A real client wired to `handler` in place of the network."""
    return genai.Client(
        vertexai=True,
        project=self.gcp_project,
        location=self.gcp_location,
        credentials=_StaticCredentials(),
        http_options=types.HttpOptions(
            httpx_client=httpx.Client(transport=httpx.MockTransport(handler)),
            retry_options=types.HttpRetryOptions(
                attempts=2, http_status_codes=[429]
            ),
        ),
    )

  def _patched(self, handler, hexes=('fixedhex',)):
    """Patches `_client` to `handler`'s client, `uuid4` to `hexes` in
    order, and `time.sleep` (a no-op, returned for assertions)."""
    client = self._client_for(handler)
    hex_iter = iter(hexes)
    return (
        mock.patch('actions_lib.omni._client', return_value=client),
        mock.patch(
            'actions_lib.omni.uuid.uuid4',
            side_effect=lambda: mock.Mock(hex=next(hex_iter)),
        ),
        mock.patch('actions_lib.omni.time.sleep'),
    )

  # -- 1. text_to_video body -------------------------------------------

  def test_text_to_video_body(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          duration_seconds=8,
          aspect_ratio='16:9',
          resolution='720p',
          output_gcs=self.output_gcs,
      )
    body = handler.posts[0]['body']
    self.assertEqual(body['model'], self.model)
    self.assertEqual(
        body['input'],
        [{
            'type': 'user_input',
            'content': [{'type': 'text', 'text': self.prompt}],
        }],
    )
    self.assertIs(body['background'], True)
    self.assertEqual(
        body['generation_config']['video_config']['task'], 'text_to_video'
    )
    response_format = body['response_format']
    self.assertEqual(response_format['delivery'], 'uri')
    self.assertEqual(response_format['duration'], '8s')
    self.assertEqual(response_format['aspect_ratio'], '16:9')
    self.assertEqual(response_format['resolution'], '720p')
    self.assertTrue(response_format['gcs_uri'].startswith(self.output_gcs))
    self.assertTrue(response_format['gcs_uri'].endswith('/'))
    self.assertEqual(uris, [response_format['gcs_uri'] + 'clip.mp4'])

  # -- 2. image_to_video body -------------------------------------------

  def test_image_to_video_body(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          'gs://in-bucket/cat.jpg',
          'image/jpeg',
          self.model,
          output_gcs=self.output_gcs,
      )
    body = handler.posts[0]['body']
    self.assertEqual(
        body['generation_config']['video_config']['task'], 'image_to_video'
    )
    parts = body['input'][0]['content']
    self.assertEqual(
        parts[1],
        {
            'type': 'image',
            'uri': 'gs://in-bucket/cat.jpg',
            'mime_type': 'image/jpeg',
        },
    )

  # -- 3. edit body -------------------------------------------------------

  def test_edit_body(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      uri = omni.edit(
          self.gcp_project,
          self.gcp_location,
          'make the sky purple',
          'gs://in-bucket/clip.mp4',
          'video/mp4',
          self.model,
          self.output_gcs,
      )
    body = handler.posts[0]['body']
    self.assertEqual(body['generation_config']['video_config']['task'], 'edit')
    parts = body['input'][0]['content']
    self.assertEqual(
        parts[1],
        {
            'type': 'video',
            'uri': 'gs://in-bucket/clip.mp4',
            'mime_type': 'video/mp4',
        },
    )
    response_format = body['response_format']
    self.assertNotIn('aspect_ratio', response_format)
    self.assertNotIn('duration', response_format)
    self.assertNotIn('resolution', response_format)
    self.assertEqual(uri, response_format['gcs_uri'] + 'clip.mp4')

  def test_edit_body_with_resolution(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      omni.edit(
          self.gcp_project,
          self.gcp_location,
          'make the sky purple',
          'gs://in-bucket/clip.mp4',
          'video/mp4',
          self.model,
          self.output_gcs,
          resolution='720p',
      )
    response_format = handler.posts[0]['body']['response_format']
    self.assertEqual(response_format['resolution'], '720p')
    self.assertNotIn('aspect_ratio', response_format)
    self.assertNotIn('duration', response_format)

  def test_edit_bad_resolution_makes_no_request(self):
    handler = _Handler()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaises(omni.OmniError):
        omni.edit(
            self.gcp_project,
            self.gcp_location,
            'make the sky purple',
            'gs://in-bucket/clip.mp4',
            'video/mp4',
            self.model,
            self.output_gcs,
            resolution='480p',
        )
    self.assertEqual(handler.requests, [])

  # -- 4. clamps ------------------------------------------------------

  def test_duration_clamped_above_range(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          duration_seconds=12,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(
        handler.posts[0]['body']['response_format']['duration'], '10s'
    )

  def test_duration_clamped_below_range(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          duration_seconds=1,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(
        handler.posts[0]['body']['response_format']['duration'], '3s'
    )

  def test_amount_clamped_to_four_creates(self):
    handler = _Handler()
    for _ in range(4):
      handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(
        handler, hexes=('h1', 'h2', 'h3', 'h4')
    )
    with p_client, p_uuid, p_sleep:
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          amount=6,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(len(handler.posts), 4)
    self.assertEqual(len(uris), 4)

  def test_bad_resolution_makes_no_request(self):
    handler = _Handler()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaises(omni.OmniError):
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            resolution='480p',
            output_gcs=self.output_gcs,
        )
    self.assertEqual(handler.requests, [])

  # -- 5. unique prefixes -----------------------------------------------

  def test_unique_prefixes_per_candidate(self):
    handler = _Handler()
    handler.queue_completed_from_request('int-1')
    handler.queue_completed_from_request('int-2')
    p_client, p_uuid, p_sleep = self._patched(handler, hexes=('aaa', 'bbb'))
    with p_client, p_uuid, p_sleep:
      omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          amount=2,
          output_gcs=self.output_gcs,
      )
    gcs_uris = [p['body']['response_format']['gcs_uri'] for p in handler.posts]
    self.assertEqual(len(gcs_uris), 2)
    self.assertNotEqual(gcs_uris[0], gcs_uris[1])

  # -- 6. poll --------------------------------------------------------

  def test_poll_success(self):
    handler = _Handler()
    prefix = f'{self.output_gcs}/fixedhex/'
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    handler.queue(200, _completed_payload(prefix))
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep as mock_sleep:
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(uris, [prefix + 'clip.mp4'])
    self.assertEqual(len(handler.posts), 1)
    self.assertEqual(len(handler.gets), 2)
    mock_sleep.assert_called_with(omni.POLL_INTERVAL_SECONDS)

  # -- 7. poll 429 ------------------------------------------------------

  def test_poll_429_is_swallowed(self):
    handler = _Handler()
    prefix = f'{self.output_gcs}/fixedhex/'
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    # retry_options gives 3 raw sends per net `get` call; 4 net 429s here
    # cost 12 raw 429 responses before the 5th net call succeeds.
    for _ in range(12):
      handler.queue(429, {'error': {'message': 'throttled'}})
    handler.queue(200, _completed_payload(prefix))
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep as mock_sleep:
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(uris, [prefix + 'clip.mp4'])
    self.assertEqual(len(handler.posts), 1)
    self.assertEqual(len(handler.gets), 13)
    # Filter out the SDK's own jittered backoff sleeps: only this module's
    # poll-interval sleep is ever called with exactly POLL_INTERVAL_SECONDS.
    poll_sleeps = [
        c
        for c in mock_sleep.call_args_list
        if c.args == (omni.POLL_INTERVAL_SECONDS,)
    ]
    self.assertEqual(len(poll_sleeps), 5)

  def test_poll_503_is_swallowed(self):
    """503 is not in the SDK's own retry codes, so each net `get` call
    costs exactly one raw send here (unlike the 429 case above)."""
    handler = _Handler()
    prefix = f'{self.output_gcs}/fixedhex/'
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    handler.queue(503, {'error': {'message': 'unavailable'}})
    handler.queue(503, {'error': {'message': 'unavailable'}})
    handler.queue(200, _completed_payload(prefix))
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep as mock_sleep:
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(uris, [prefix + 'clip.mp4'])
    self.assertEqual(len(handler.posts), 1)
    self.assertEqual(len(handler.gets), 3)
    poll_sleeps = [
        c
        for c in mock_sleep.call_args_list
        if c.args == (omni.POLL_INTERVAL_SECONDS,)
    ]
    self.assertEqual(len(poll_sleeps), 3)

  # -- 8. poll deadline -------------------------------------------------

  def test_poll_deadline_exceeded(self):
    handler = _Handler()
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    p_client, p_uuid, p_sleep = self._patched(handler)
    monotonic_values = iter([0, 999999])
    with p_client, p_uuid, p_sleep as mock_sleep, mock.patch(
        'actions_lib.omni.time.monotonic',
        side_effect=lambda: next(monotonic_values),
    ):
      with self.assertRaisesRegex(omni.OmniError, 'int-1'):
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            output_gcs=self.output_gcs,
        )
    self.assertEqual(len(handler.posts), 1)
    self.assertEqual(len(handler.gets), 0)
    mock_sleep.assert_not_called()

  # -- 9. failed status -------------------------------------------------

  def test_failed_status_raises(self):
    handler = _Handler()
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    handler.queue(
        200,
        {
            'id': 'int-1',
            'status': 'failed',
            'errors': [{'message': 'boom'}],
        },
    )
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaisesRegex(omni.OmniError, 'failed'):
        try:
          omni.generate(
              self.gcp_project,
              self.gcp_location,
              self.prompt,
              None,
              None,
              self.model,
              output_gcs=self.output_gcs,
          )
        except omni.OmniError as exc:
          self.assertIn('boom', str(exc))
          raise
    self.assertEqual(len(handler.posts), 1)

  # -- 10. create 429 persistent ----------------------------------------

  def test_create_429_persistent_propagates_and_is_retryable(self):
    handler = _Handler()
    for _ in range(3):
      handler.queue(429, {'error': {'message': 'throttled'}})
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaises(Exception) as ctx:
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            output_gcs=self.output_gcs,
        )
    self.assertNotIsInstance(ctx.exception, omni.OmniError)
    self.assertTrue(errors.is_retryable(ctx.exception))
    self.assertEqual(len(handler.posts), 3)

  # -- 11. create 500 ----------------------------------------------------

  def test_create_500_propagates_and_is_not_retryable(self):
    handler = _Handler()
    handler.queue(500, {'error': {'message': 'boom'}})
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaises(Exception) as ctx:
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            output_gcs=self.output_gcs,
        )
    self.assertNotIsInstance(ctx.exception, omni.OmniError)
    self.assertFalse(errors.is_retryable(ctx.exception))
    self.assertEqual(len(handler.posts), 1)

  def test_later_create_failure_is_wrapped_and_terminal(self):
    """Once one candidate is accepted, a later create's failure must never
    look retryable: it is wrapped as an `OmniError`, which carries no
    `code` or `status_code`, so `is_retryable` is False and the clip
    already bought is never regenerated."""
    handler = _Handler()
    handler.queue_completed_from_request('int-1')
    for _ in range(3):
      handler.queue(429, {'error': {'message': 'throttled'}})
    p_client, p_uuid, p_sleep = self._patched(handler, hexes=('h1', 'h2'))
    with p_client, p_uuid, p_sleep:
      with self.assertRaisesRegex(
          omni.OmniError, 'create 2 of 2 failed after 1 accepted'
      ):
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            amount=2,
            output_gcs=self.output_gcs,
        )
    self.assertEqual(len(handler.posts), 4)

  # -- 12. USE_BACKGROUND=False ------------------------------------------

  def test_use_background_false_skips_polling(self):
    handler = _Handler()
    handler.queue_completed_from_request()
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep, mock.patch(
        'actions_lib.omni.USE_BACKGROUND', False
    ):
      uris = omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(len(handler.gets), 0)
    self.assertEqual(len(handler.posts), 1)
    self.assertIs(handler.posts[0]['body']['background'], False)
    self.assertEqual(
        uris,
        [handler.posts[0]['body']['response_format']['gcs_uri'] + 'clip.mp4'],
    )

  # -- timeouts -----------------------------------------------------------

  def test_create_and_get_carry_explicit_timeouts(self):
    handler = _Handler()
    handler.queue(200, {'id': 'int-1', 'status': 'in_progress'})
    handler.queue(200, _completed_payload(f'{self.output_gcs}/fixedhex/'))
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      omni.generate(
          self.gcp_project,
          self.gcp_location,
          self.prompt,
          None,
          None,
          self.model,
          output_gcs=self.output_gcs,
      )
    self.assertEqual(handler.posts[0]['timeout']['read'], 120.0)
    self.assertEqual(handler.gets[0]['timeout']['read'], 60.0)

  # -- missing interaction id ---------------------------------------------

  def test_create_without_id_raises_before_any_poll(self):
    handler = _Handler()
    handler.queue(200, {'status': 'in_progress'})
    p_client, p_uuid, p_sleep = self._patched(handler)
    with p_client, p_uuid, p_sleep:
      with self.assertRaisesRegex(omni.OmniError, 'no interaction id'):
        omni.generate(
            self.gcp_project,
            self.gcp_location,
            self.prompt,
            None,
            None,
            self.model,
            output_gcs=self.output_gcs,
        )
    self.assertEqual(len(handler.posts), 1)
    self.assertEqual(len(handler.gets), 0)


if __name__ == '__main__':
  unittest.main()
