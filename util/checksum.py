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

"""Provides helper functions to compute checksums of complex objects."""

from __future__ import annotations
import hashlib
import json
from typing import Any


def compute_object_checksum(obj: Any, hash_function: str = 'sha256') -> str:
  """Computes a checksum of a complex object (dictionary of arrays of dictionaries).

  Args:
    obj: The object (dictionary, list, array, etc.) to checksum.
    hash_function: The hashing algorithm to use ('sha256', 'sha1', 'md5').
                  Defaults to 'sha256'.  Strongly recommended to use sha256.

  Returns:
    A hexadecimal string representing the checksum of the object.
  """
  hasher = hashlib.new(hash_function)
  _update_hasher_with_object(hasher, obj)
  print(('HASH', hasher.hexdigest(), json.dumps(obj)))
  return hasher.hexdigest()


def _update_hasher_with_object(hasher: hashlib._Hash, obj: Any) -> None:
  """Recursively updates the hasher with the object's contents.

  Handles dictionaries (ordered keys), lists, tuples and primitive types.
  Ensures consistent hashing regardless of dictionary key order.

  Args:
    hasher: The hashlib hasher object.
    obj: The object (or part of an object) to hash.
  """

  if isinstance(obj, dict):
    # Sort keys for consistent order
    sorted_keys = sorted(obj.keys())
    hasher.update(b'{')
    for key in sorted_keys:
      hasher.update(json.dumps(key).encode('utf-8'))
      hasher.update(b':')
      _update_hasher_with_object(hasher, obj[key])
      hasher.update(b',')
    hasher.update(b'}')

  elif isinstance(obj, (list, tuple)):
    hasher.update(b'[')  # canonical representation of tuples
    for item in obj:
      _update_hasher_with_object(hasher, item)
      hasher.update(b',')
    hasher.update(b']')

  else:  # primitive types (int, float, string, boolean, None)
    hasher.update(json.dumps(obj).encode('utf-8'))
