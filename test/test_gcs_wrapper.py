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
