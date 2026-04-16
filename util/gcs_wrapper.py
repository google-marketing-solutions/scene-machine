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

"""Encapsulates Cloud Storage functionality with standardised paths.

To hide implementation details on GCS storage from action functions, this
provides standardised access.
"""

import datetime
import io
from typing import Union

from common import logger
from google.auth import compute_engine
from google.auth import default
from google.auth.transport import requests as transport_requests
from google.cloud import storage

SIGNED_URL_TTL_HOURS = 24


def get_signed_url(
    gcs_bucket_name: str, blob_name: str, flask_context: bool = False
) -> str:
  """Generates a signed URL for downloading a blob from GCS.

  Args:
    gcs_bucket_name: Name of bucket containing the file.
    blob_name: Name of the file.
    flask_context: whether this is executed with Flask.

  Returns:
    A signed URL to the input file.
  """
  storage_client = storage.Client()
  bucket = storage_client.bucket(gcs_bucket_name)
  blob = bucket.blob(blob_name)

  if flask_context:
    auth_request = transport_requests.Request()
    cred, _ = default()
    cred.refresh(auth_request)  # pyright: ignore[reportAttributeAccessIssue]
    signing_credentials = compute_engine.IDTokenCredentials(
        auth_request, '', service_account_email=cred.service_account_email  # pyright: ignore[reportAttributeAccessIssue], pylint: disable=linetoolong
    )
    return blob.generate_signed_url(
        version='v4',
        expiration=datetime.timedelta(hours=SIGNED_URL_TTL_HOURS),
        method='GET',
        credentials=signing_credentials,
    )
  else:
    return blob.generate_signed_url(
        version='v4',
        expiration=datetime.timedelta(hours=SIGNED_URL_TTL_HOURS),
        method='GET',
    )


class GCS:
  """Encapsulates Cloud Storage functionality with standardised paths."""

  def __init__(
      self, action: str, checksum: str, bucket_name: str, ttl_days: int = 14
  ):
    """Initialises the class based on the current action context.

    Args:
        action: The action using this class.
        checksum: The checksum of the input values, defining the data location.
        bucket_name: The name of the GCS bucket in which to store all data.
        ttl_days: The number of days after which to remove data.
    """
    storage_client = storage.Client()
    self.gcs_bucket = storage_client.bucket(bucket_name)
    self.path = f'{action}/{checksum}/'
    self.ttl_days = ttl_days

  def store(self, data: Union[str, bytes], name: str, content_type: str) -> str:
    """Stores data at the default location.

    Args:
        data: The data to be stored.
        name: The filename to be used.
        content_type: The type of the data to be stored.

    Returns:
        The path to the file written.
    """
    filepath = self.path + name
    file = self.gcs_bucket.blob(filepath)
    metadata = {
        'timeToDelete': (
            (
                datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(days=self.ttl_days)
            ).isoformat()
        )
    }
    file.metadata = metadata
    file.upload_from_string(data, content_type=content_type)
    return filepath

  def load_text(self, filepath: str) -> str:
    """Load text from the named location.

    Args:
        filepath: The GCS path to the file to be read.

    Returns:
        The contents of the read file.
    """
    gcs_blob = self.gcs_bucket.blob(filepath)
    gcs_blob.reload()
    destination = io.BytesIO()

    with destination as buffer:
      gcs_blob.download_to_file(buffer)
      buffer.seek(0)
      content = buffer.read()
      return content.decode('utf-8')

  def load_bytes(self, filepath: str) -> bytes:
    """Load data from the named location.

    Args:
        filepath: The GCS path to the file to be read.

    Returns:
        The contents of the read file. If the contents are text,
        the result is a str. Otherwise bytes.
    """
    gcs_blob = self.gcs_bucket.blob(filepath)
    gcs_blob.reload()
    destination = io.BytesIO()

    with destination as buffer:
      gcs_blob.download_to_file(buffer)
      buffer.seek(0)
      content = buffer.read()
      return content

  def save_locally(self, filepath: str, local_file: str) -> None:
    """Load data from the named location and save it to a local file.

    Args:
        filepath: The GCS path to the file to be read.
        local_file: The path where to save the file to.
    """
    gcs_blob = self.gcs_bucket.blob(filepath)
    gcs_blob.reload()
    destination = open(local_file, 'wb')
    with destination as buffer:
      gcs_blob.download_to_file(buffer)

  def get_mime_type(self, filepath: str) -> str:
    """Returns the MIME type of the named file.

    Args:
        filepath: The path to the file in question.

    Returns:
        The MIME type of the file
    """
    file = self.gcs_bucket.blob(filepath)
    file.reload()
    return file.content_type

  def get_uri(self, filepath: str) -> str:
    """Returns the URI of the named file.

    Args:
        filepath: The path to the file in question.

    Returns:
        A fully qualified URI starting with gs://
    """
    return f'gs://{self.gcs_bucket.name}/{filepath}'

  def get_path_uri(self) -> str:
    """Returns the URI of the path in which this instance operates.

    Returns:
        A fully qualified URI starting with gs://
    """
    return self.get_uri(self.path)

  def strip_prefix(self, uri: str) -> str:
    """Returns the part of the GCS URI representing the path inside the bucket.

    Args:
        uri: A fully qualified URI starting with gs://

    Returns:
        A file path, not starting with a slash.
    """
    prefix = f'gs://{self.gcs_bucket.name}/'
    if not uri.startswith(prefix):
      logger.error('Not a valid GCS URI: %s', uri)
      raise ValueError('Not a valid GCS URI')
    return uri[len(prefix) :]
