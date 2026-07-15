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
import hashlib
import io
import pathlib
import re
from typing import Iterable
from typing import Union

from common import logger
from google.auth import compute_engine
from google.auth import default
from google.auth.transport import requests as transport_requests
from google.cloud import storage

SIGNED_URL_TTL_HOURS = 24

# Cloud Run's writable filesystem uses the worker's 16G memory allocation.
# Keep half available for FFmpeg, output files, and the Python process.
MAX_LOCAL_INPUT_BYTES = 8 * 1024 * 1024 * 1024
_MAX_LOCAL_EXTENSION_LENGTH = 10


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

  def _storage_target(self, name: str):
    filepath = self.path + name
    blob = self.gcs_bucket.blob(filepath)
    time_to_delete = datetime.datetime.now(
        datetime.timezone.utc
    ) + datetime.timedelta(days=self.ttl_days)
    blob.metadata = {'timeToDelete': time_to_delete.isoformat()}
    return filepath, blob

  def store(self, data: Union[str, bytes], name: str, content_type: str) -> str:
    """Stores data at the default location.

    Args:
        data: The data to be stored.
        name: The filename to be used.
        content_type: The type of the data to be stored.

    Returns:
        The path to the file written.
    """
    filepath, blob = self._storage_target(name)
    blob.upload_from_string(data, content_type=content_type)
    return filepath

  def store_file(self, source: str, name: str, content_type: str) -> str:
    """Stores a local file at the default location.

    Args:
        source: The local path to upload.
        name: The filename to use in Cloud Storage.
        content_type: The MIME type of the data.

    Returns:
        The path to the file written.
    """
    filepath, blob = self._storage_target(name)
    blob.upload_from_filename(source, content_type=content_type)
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

  def save_locally(
      self,
      filepath: str,
      local_file: str,
      if_generation_match: int | None = None,
  ) -> None:
    """Load data from the named location and save it to a local file.

    Args:
        filepath: The GCS path to the file to be read.
        local_file: The path where to save the file to.
        if_generation_match: Download only this immutable object generation.
    """
    if if_generation_match is None:
      gcs_blob = self.gcs_bucket.blob(filepath)
      gcs_blob.reload()
    else:
      gcs_blob = self.gcs_bucket.blob(filepath, generation=if_generation_match)
    destination = open(local_file, 'wb')
    with destination as buffer:
      gcs_blob.download_to_file(buffer, if_generation_match=if_generation_match)

  def get_size_and_generation(self, filepath: str) -> tuple[int, int]:
    """Returns the stored size and immutable generation of an object.

    Args:
        filepath: The GCS path to inspect.

    Returns:
        The object's size in bytes and its Cloud Storage generation.

    Raises:
        ValueError: The object metadata has no usable size or generation.
    """
    gcs_blob = self.gcs_bucket.blob(filepath)
    gcs_blob.reload()
    size = gcs_blob.size
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
      raise ValueError('Cloud Storage object size is unavailable')
    generation = gcs_blob.generation
    if (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation <= 0
    ):
      raise ValueError('Cloud Storage object generation is unavailable')
    return size, generation

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


def _local_input_path(local_directory: str, filepath: str) -> pathlib.Path:
  digest = hashlib.sha256(filepath.encode('utf-8')).hexdigest()
  extension = pathlib.PurePosixPath(filepath).suffix.lower()
  if not re.fullmatch(
      rf'\.[a-z0-9]{{1,{_MAX_LOCAL_EXTENSION_LENGTH}}}', extension
  ):
    extension = ''
  return pathlib.Path(local_directory, f'input-{digest}{extension}')


def download_distinct_inputs(
    gcs: GCS,
    filepaths: Iterable[str],
    local_directory: str,
    max_total_bytes: int = MAX_LOCAL_INPUT_BYTES,
) -> dict[str, str]:
  """Downloads each distinct object once within an aggregate size limit.

  Args:
      gcs: The Cloud Storage wrapper to use.
      filepaths: Object paths to download. Repeated paths reuse one local file.
      local_directory: Request-owned directory for the downloaded files.
      max_total_bytes: Largest permitted sum of distinct object sizes.

  Returns:
      A mapping from each distinct object path to its local path.

  Raises:
      ValueError: A path, size, or aggregate size is invalid.
  """
  if (
      isinstance(max_total_bytes, bool)
      or not isinstance(max_total_bytes, int)
      or max_total_bytes <= 0
  ):
    raise ValueError('Local input size limit must be a positive integer')

  local_paths: dict[str, str] = {}
  generations: dict[str, int] = {}
  used_local_paths: set[str] = set()
  total_bytes = 0
  for filepath in filepaths:
    if not isinstance(filepath, str) or not filepath:
      raise ValueError('Input media path must be a non-empty string')
    if filepath in local_paths:
      continue

    size, generation = gcs.get_size_and_generation(filepath)
    if size > max_total_bytes - total_bytes:
      limit_gib = max_total_bytes // (1024 * 1024 * 1024)
      raise ValueError(f'Input media exceeds the {limit_gib} GiB local limit')
    total_bytes += size
    local_path = str(_local_input_path(local_directory, filepath))
    if local_path in used_local_paths:
      raise ValueError('Distinct input paths produced the same local filename')
    local_paths[filepath] = local_path
    generations[filepath] = generation
    used_local_paths.add(local_path)

  for filepath, local_path in local_paths.items():
    gcs.save_locally(
        filepath,
        local_path,
        if_generation_match=generations[filepath],
    )

  return local_paths
