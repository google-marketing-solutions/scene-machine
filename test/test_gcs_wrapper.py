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
import threading
from unittest import mock

import pytest

from util import gcs_wrapper
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


def test_get_signed_url_flask_context_caches_client_and_credentials_until_expired():
  mock_client = mock.Mock()
  mock_bucket = mock.Mock()
  mock_blob = mock.Mock()
  mock_client.bucket.return_value = mock_bucket
  mock_bucket.blob.return_value = mock_blob
  mock_blob.generate_signed_url.return_value = 'https://storage.googleapis.com/signed'

  mock_cred = mock.Mock()
  mock_cred.service_account_email = 'sa@example.com'
  future_expiry = datetime.datetime.now() + datetime.timedelta(hours=1)
  mock_cred.expiry = future_expiry
  mock_default = mock.Mock(return_value=(mock_cred, 'project-id'))

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=mock_client
  ) as client_factory, mock.patch(
      'util.gcs_wrapper.default', mock_default
  ), mock.patch(
      'util.gcs_wrapper.iam.Signer'
  ) as signer_factory:
    # First call initializes client and credentials
    url1 = gcs_wrapper.get_signed_url('bucket', 'a.mp4', flask_context=True)
    assert url1 == 'https://storage.googleapis.com/signed'
    assert client_factory.call_count == 1
    assert mock_cred.refresh.call_count == 1
    assert signer_factory.call_count == 1
    assert gcs_wrapper._CACHED_SIGNING_CREDENTIALS.expiry == future_expiry

    # Second call reuses cached client and credentials (not expired)
    url2 = gcs_wrapper.get_signed_url('bucket', 'b.mp4', flask_context=True)
    assert url2 == 'https://storage.googleapis.com/signed'
    assert client_factory.call_count == 1
    assert mock_cred.refresh.call_count == 1

    # Now expire credentials via real expiry; refresh must be called a second time
    gcs_wrapper._CACHED_SIGNING_CREDENTIALS.expiry = (
        datetime.datetime.now() - datetime.timedelta(minutes=5)
    )
    url3 = gcs_wrapper.get_signed_url('bucket', 'c.mp4', flask_context=True)
    assert url3 == 'https://storage.googleapis.com/signed'
    assert client_factory.call_count == 1
    assert mock_cred.refresh.call_count == 2


def test_signing_context_built_once_across_concurrent_callers():
  mock_client = mock.Mock()
  mock_cred = mock.Mock()
  mock_cred.service_account_email = 'sa@example.com'
  mock_cred.expiry = datetime.datetime.now() + datetime.timedelta(hours=1)
  mock_default = mock.Mock(return_value=(mock_cred, 'project-id'))

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=mock_client
  ) as client_factory, mock.patch(
      'util.gcs_wrapper.default', mock_default
  ), mock.patch(
      'util.gcs_wrapper.iam.Signer'
  ) as signer_factory:
    num_threads = 10
    barrier = threading.Barrier(num_threads)
    results = [None] * num_threads

    def worker(idx):
      barrier.wait()
      results[idx] = gcs_wrapper.get_signing_context()

    threads = [
        threading.Thread(target=worker, args=(i,)) for i in range(num_threads)
    ]
    for t in threads:
      t.start()
    for t in threads:
      t.join()

    assert client_factory.call_count == 1
    assert mock_default.call_count == 1
    assert mock_cred.refresh.call_count == 1
    assert signer_factory.call_count == 1

    expected_client, expected_creds = results[0]
    for client, creds in results:
      assert client is expected_client
      assert creds is expected_creds


def test_non_service_account_adc_raises_actionable_error():
  # Simulates an end-user OAuth credential from `gcloud auth application-default login`
  # which has no service_account_email attribute.
  user_cred = mock.NonCallableMock(spec=['token', 'refresh'])
  assert not hasattr(user_cred, 'service_account_email')

  mock_client = mock.Mock()
  mock_default = mock.Mock(return_value=(user_cred, 'project-id'))

  with mock.patch(
      'util.gcs_wrapper.storage.Client', return_value=mock_client
  ) as client_factory, mock.patch(
      'util.gcs_wrapper.default', mock_default
  ):
    # Must raise a clear, actionable RuntimeError, not an unhelpful AttributeError.
    with pytest.raises(RuntimeError) as exc_info:
      gcs_wrapper.get_signed_url('bucket', 'file.mp4', flask_context=True)

    err_msg = str(exc_info.value)
    assert 'service_account_email' in err_msg
    assert 'gcloud auth application-default login' in err_msg
    assert '--impersonate-service-account' in err_msg
    assert 'DEVELOPING.md' in err_msg
    assert client_factory.call_count == 1
    assert mock_default.call_count == 1
