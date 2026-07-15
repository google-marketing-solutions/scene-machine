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

"""Tests for the Cloud Storage wrapper."""

import datetime
from unittest import mock

import pytest

from util.gcs_wrapper import GCS


def test_store_file_preserves_destination_ttl_and_content_type(tmp_path):
  storage_client = mock.Mock()
  bucket = storage_client.bucket.return_value
  blob = bucket.blob.return_value
  source = tmp_path / 'result.mp4'
  source.write_bytes(b'video')

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=storage_client
  ):
    gcs = GCS('combine_video', 'checksum', 'bucket', ttl_days=3)
    result = gcs.store_file(str(source), 'output.mp4', 'video/mp4')

  assert result == 'combine_video/checksum/output.mp4'
  bucket.blob.assert_called_once_with('combine_video/checksum/output.mp4')
  blob.upload_from_filename.assert_called_once_with(
      str(source), content_type='video/mp4'
  )
  expiry = datetime.datetime.fromisoformat(blob.metadata['timeToDelete'])
  remaining = expiry - datetime.datetime.now(datetime.timezone.utc)
  assert datetime.timedelta(days=2, hours=23) < remaining
  assert remaining <= datetime.timedelta(days=3)


def test_get_size_and_generation_reads_object_metadata():
  storage_client = mock.Mock()
  bucket = storage_client.bucket.return_value
  blob = bucket.blob.return_value
  blob.size = 1234
  blob.generation = 17

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=storage_client
  ):
    gcs = GCS('combine_video', 'checksum', 'bucket')
    result = gcs.get_size_and_generation('clips/input.mp4')

  assert result == (1234, 17)
  bucket.blob.assert_called_once_with('clips/input.mp4')
  blob.reload.assert_called_once_with()


@pytest.mark.parametrize(
    'generation', [None, False, 0], ids=['missing', 'boolean', 'zero']
)
def test_get_size_and_generation_rejects_invalid_generation(generation):
  storage_client = mock.Mock()
  blob = storage_client.bucket.return_value.blob.return_value
  blob.size = 1
  blob.generation = generation

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=storage_client
  ):
    gcs = GCS('combine_video', 'checksum', 'bucket')
    with pytest.raises(ValueError, match='generation is unavailable'):
      gcs.get_size_and_generation('clips/input.mp4')


def test_save_locally_pins_the_measured_generation(tmp_path):
  storage_client = mock.Mock()
  bucket = storage_client.bucket.return_value
  blob = bucket.blob.return_value
  destination = tmp_path / 'input.mp4'

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=storage_client
  ):
    gcs = GCS('combine_video', 'checksum', 'bucket')
    gcs.save_locally(
        'clips/input.mp4', str(destination), if_generation_match=17
    )

  bucket.blob.assert_called_once_with('clips/input.mp4', generation=17)
  blob.reload.assert_not_called()
  blob.download_to_file.assert_called_once_with(
      mock.ANY, if_generation_match=17
  )
