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

"""Offline tests for the Omni probe's request shaping."""

from unittest import mock

import pytest
from google.genai.interactions import Interaction
from tools import omni_probe


@pytest.mark.parametrize('bucket', ['bucket', 'gs://bucket', 'gs://bucket/'])
def test_output_prefix_normalizes_gcs_bucket(bucket):
  with mock.patch.object(omni_probe.uuid, 'uuid4') as uuid4:
    uuid4.return_value.hex = 'fixed'
    prefix = omni_probe._output_prefix(bucket)
    assert prefix.startswith('gs://bucket/_omni-probe/')
    assert prefix.endswith('/fixed/')


@pytest.mark.parametrize(
    ('background', 'timeout'),
    [
        (False, omni_probe.POLL_DEADLINE_SECONDS),
        (True, omni_probe.CREATE_TIMEOUT_SECONDS),
    ],
)
def test_edit_uses_matching_create_timeout(background, timeout):
  client = mock.Mock()
  client.interactions.create.return_value = Interaction(
      status='completed',
      steps=[{
          'type': 'model_output',
          'content': [{
              'type': 'video',
              'uri': 'gs://out/clip.mp4',
              'mime_type': 'video/mp4',
          }],
      }],
  )

  with mock.patch.object(omni_probe.uuid, 'uuid4') as uuid4:
    uuid4.return_value.hex = 'fixed'
    result = omni_probe.step4(client, 'bucket', 'gs://in/clip.mp4', background)

  assert result == 'gs://out/clip.mp4'
  assert client.interactions.create.call_args.kwargs['timeout'] == timeout
  assert client.interactions.create.call_args.kwargs.get('background') == (
      True if background else None
  )
