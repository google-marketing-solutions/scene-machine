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

"""Tests checksum computation for various data types."""

import unittest
from util import checksum as util_checksum


class TestUtilHash(unittest.TestCase):
  """Tests checksum computation for various data types."""

  def test_compute_object_checksum_different_order(self) -> None:
    """Tests checksums for dictionaries only differing in key order."""
    obj1 = {"a": 1, "b": 2}
    obj2 = {"b": 2, "a": 1}
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    self.assertEqual(checksum1, checksum2)

  def test_compute_object_checksum_different_content(self) -> None:
    """Tests that the checksum is different for different content."""
    obj1 = {"a": 1, "b": 2}
    obj2 = {"a": 1, "b": 3}
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    self.assertNotEqual(checksum1, checksum2)

  def test_compute_object_checksum_list_order(self) -> None:
    """Tests that list order matters for checksum."""
    obj1 = [1, 2, 3]
    obj2 = [3, 2, 1]
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    self.assertNotEqual(checksum1, checksum2)

  def test_compute_object_checksum_list_same(self) -> None:
    """Tests that checksum is the same for identical lists."""
    obj1 = [1, 2, 3]
    obj2 = [1, 2, 3]
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    self.assertEqual(checksum1, checksum2)

  def test_compute_object_checksum_nested_objects(self) -> None:
    """Tests with nested dictionaries and lists."""
    obj1 = {"a": [1, 2], "b": {"c": 3, "d": 4}}
    obj2 = {"b": {"d": 4, "c": 3}, "a": [1, 2]}  # Same content, different order
    obj3 = {"a": [2, 1], "b": {"c": 3, "d": 4}}  # Different content
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    checksum3 = util_checksum.compute_object_checksum(obj3)
    self.assertEqual(checksum1, checksum2)
    self.assertNotEqual(checksum1, checksum3)

  def test_compute_object_checksum_primitives(self) -> None:
    """Tests checksums with primitive datatypes."""
    obj1 = 1
    obj2 = 1.1
    obj3 = "abc"
    obj4 = True
    obj5 = None
    obj6 = 1
    checksum1 = util_checksum.compute_object_checksum(obj1)
    checksum2 = util_checksum.compute_object_checksum(obj2)
    checksum3 = util_checksum.compute_object_checksum(obj3)
    checksum4 = util_checksum.compute_object_checksum(obj4)
    checksum5 = util_checksum.compute_object_checksum(obj5)
    checksum6 = util_checksum.compute_object_checksum(obj6)

    self.assertNotEqual(checksum1, checksum2)
    self.assertNotEqual(checksum1, checksum3)
    self.assertNotEqual(checksum1, checksum4)
    self.assertNotEqual(checksum1, checksum5)
    self.assertEqual(checksum1, checksum6)


if __name__ == "__main__":
  unittest.main()
