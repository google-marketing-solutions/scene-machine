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

"""Tests the grouping of inputs to actions."""

import json
import unittest

from util.group_input import _cross_product_dicts
from util.group_input import _group_dictionaries
from util.group_input import _partition_parameters
from util.group_input import group_input


class TestGroupInput(unittest.TestCase):
  """Tests the grouping of inputs to actions."""

  def test_group_dictionaries_empty(self) -> None:
    """Tests grouping of empty dictionaries."""
    data: list[dict[str, str]] = []
    ignore: list[str] = []
    grouping_keys, groups = _group_dictionaries(data, ignore)
    self.assertEqual(grouping_keys, [])
    self.assertEqual(groups, {tuple(): []})

  def test_group_dictionaries_no_grouping_keys(self) -> None:
    """Tests grouping of dictionaries without grouping keys."""
    data = [{"file": "a"}, {"file": "b"}]
    ignore: list[str] = []
    grouping_keys, groups = _group_dictionaries(data, ignore)
    self.assertEqual(grouping_keys, [])
    self.assertEqual(groups, {tuple(): [{"file": "a"}, {"file": "b"}]})

  def test_group_dictionaries_single_grouping_key(self) -> None:
    """Tests grouping of dictionaries with a single grouping key."""
    data = [
        {"file": "a", "color": "red"},
        {"file": "b", "color": "red"},
    ]
    ignore: list[str] = []
    grouping_keys, groups = _group_dictionaries(data, ignore)
    self.assertEqual(grouping_keys, ["color"])
    self.assertEqual(
        groups,
        {
            ("red",): [
                {"file": "a", "color": "red"},
                {"file": "b", "color": "red"},
            ]
        },
    )

  def test_group_dictionaries_multiple_grouping_keys(self) -> None:
    """Tests grouping of dictionaries with multiple grouping keys."""
    data = [
        {"file": "a", "color": "red", "size": "small"},
        {"file": "b", "color": "red", "size": "large"},
        {"file": "c", "color": "blue", "size": "small"},
    ]
    ignore: list[str] = []
    grouping_keys, groups = _group_dictionaries(data, ignore)
    self.assertEqual(set(grouping_keys), {"color", "size"})
    self.assertEqual(
        groups,
        {
            ("red", "small"): [{"file": "a", "color": "red", "size": "small"}],
            ("red", "large"): [{"file": "b", "color": "red", "size": "large"}],
            ("blue", "small"): [
                {"file": "c", "color": "blue", "size": "small"}
            ],
        },
    )

  def test_group_dictionaries_ignore(self) -> None:
    """Tests grouping of dictionaries with a grouping key to be ignored."""
    data = [
        {"file": "a", "color": "red", "size": "small", "ignore": "X"},
        {"file": "b", "color": "red", "size": "large", "ignore": "Y"},
        {"file": "c", "color": "blue", "size": "small", "ignore": "Z"},
    ]
    ignore = ["ignore"]
    grouping_keys, groups = _group_dictionaries(data, ignore)
    self.assertEqual(set(grouping_keys), {"color", "size"})
    self.assertEqual(
        groups,
        {
            ("red", "small"): [
                {"file": "a", "color": "red", "size": "small", "ignore": "X"}
            ],
            ("red", "large"): [
                {"file": "b", "color": "red", "size": "large", "ignore": "Y"}
            ],
            ("blue", "small"): [
                {"file": "c", "color": "blue", "size": "small", "ignore": "Z"}
            ],
        },
    )

  def test_partition_parameters_single_param(self) -> None:
    """Tests partitioning of parameters with a single parameter."""
    input_dict = {
        "lang": (["language"], {("en",): ["english"], ("de",): ["german"]})
    }
    result = _partition_parameters(input_dict)
    expected = [{"lang": ["english"]}, {"lang": ["german"]}]
    self.assertEqual(result, expected)

  def test_partition_parameters_multiple_params_aligned(self) -> None:
    """Tests partitioning of parameters with a aligned parameters."""
    input_dict = {
        "lang": (["language"], {("en",): ["english"], ("de",): ["german"]}),
        "dialect": (["language"], {("en",): ["GB"], ("de",): ["DE"]}),
    }
    result = _partition_parameters(input_dict)
    expected = [
        {"lang": ["english"], "dialect": ["GB"]},
        {"lang": ["german"], "dialect": ["DE"]},
    ]
    self.assertEqual(result, expected)

  def test_partition_parameters_multiple_params_unaligned(self) -> None:
    """Tests partitioning of parameters with non-aligned parameters."""
    input_dict = {
        "lang": (["language"], {("en",): ["english"], ("de",): ["german"]}),
        "audience": (["audience"], {("a",): ["A"], ("b",): ["B"]}),
    }
    result = _partition_parameters(input_dict)
    expected = [
        {"lang": ["english"], "audience": ["A"]},
        {"lang": ["german"], "audience": ["A"]},
        {"lang": ["english"], "audience": ["B"]},
        {"lang": ["german"], "audience": ["B"]},
    ]
    self.assertEqual(result, expected)

  def test_partition_parameters_partially_aligned(self) -> None:
    """Tests partitioning of parameters with partially aligned parameters."""
    input_dict = {
        "lang": (
            ["language", "country"],
            {
                ("en", "GB"): ["english"],
                ("de", "DE"): ["german"],
                ("fr", "CH"): ["french"],
            },
        ),
        "dialect": (["country"], {("GB",): ["GB_dial"], ("DE",): ["DE_dial"]}),
    }
    result = _partition_parameters(input_dict)
    expected = [
        {"lang": ["english"], "dialect": ["GB_dial"]},
        {"lang": ["german"], "dialect": ["DE_dial"]},
        {"lang": ["french"], "dialect": []},
    ]
    self.assertEqual(result, expected)

  def test_cross_product_dicts_empty(self) -> None:
    """Tests cross product of empty dictionaries."""
    self.assertEqual(_cross_product_dicts([]), [])

  def test_cross_product_dicts_single_list(self) -> None:
    """Tests cross product of dictionaries in a single-entry list."""
    a = [[{"a": 1}, {"a": 2}]]
    self.assertEqual(_cross_product_dicts(a), [{"a": 1}, {"a": 2}])

  def test_cross_product_dicts_multiple_lists(self) -> None:
    """Tests cross product of dictionaries in a multi-entry list."""
    a = [[{"a": 1}, {"a": 2}], [{"b": 3}, {"b": 4}]]
    self.assertEqual(
        _cross_product_dicts(a),
        [
            {"a": 1, "b": 3},
            {"a": 1, "b": 4},
            {"a": 2, "b": 3},
            {"a": 2, "b": 4},
        ],
    )

  def test_cross_product_dicts_complex_lists(self) -> None:
    """Tests cross product of dictionaries in complex lists."""
    a = [[{"a": 1, "c": 5}, {"a": 2, "c": 6}], [{"b": 3}]]
    self.assertEqual(
        _cross_product_dicts(a),
        [
            {"a": 1, "b": 3, "c": 5},
            {"a": 2, "b": 3, "c": 6},
        ],
    )

  def test_group_input_empty(self) -> None:
    """Tests empty input grouping."""
    self.assertEqual(group_input({}), [])

  def test_group_input_single_input_no_dimensions(self) -> None:
    """Tests grouping of a single input without dimensions."""
    input_dict = {"text": [{"file": "Hello"}, {"file": "World"}]}
    self.assertEqual(
        group_input(input_dict),
        [{"text": [{"file": "Hello"}, {"file": "World"}]}],
    )

  def test_group_input_single_input_with_dimensions(self) -> None:
    """Tests grouping of a single input with dimensions."""
    input_dict = {
        "text": [
            {"file": "Hello", "language": "en"},
            {"file": "World", "language": "de"},
        ]
    }
    expected = [
        {"text": [{"file": "Hello", "language": "en"}]},
        {"text": [{"file": "World", "language": "de"}]},
    ]
    self.assertEqual(group_input(input_dict), expected)

  def test_group_input_multiple_inputs_unrelated_dimensions(self) -> None:
    """Tests grouping of multiple inputs with unrelated dimensions."""
    input_dict = {
        "text1": [
            {"file": "Hello", "language": "en"},
            {"file": "World", "language": "de"},
        ],
        "text2": [
            {"file": "Hi", "audience": "a"},
            {"file": "There", "audience": "b"},
        ],
    }
    result = group_input(input_dict)
    expected = [
        {
            "text1": [{"file": "Hello", "language": "en"}],
            "text2": [{"file": "Hi", "audience": "a"}],
        },
        {
            "text1": [{"file": "Hello", "language": "en"}],
            "text2": [{"file": "There", "audience": "b"}],
        },
        {
            "text1": [{"file": "World", "language": "de"}],
            "text2": [{"file": "Hi", "audience": "a"}],
        },
        {
            "text1": [{"file": "World", "language": "de"}],
            "text2": [{"file": "There", "audience": "b"}],
        },
    ]
    self.assertEqual(result, expected)

  def test_group_input_multiple_inputs_related_dimensions(self) -> None:
    """Tests grouping of multiple inputs with related dimensions."""
    input_dict = {
        "text1": [
            {"file": "Hello", "language": "en", "id": "1"},
            {"file": "World", "language": "de", "id": "2"},
        ],
        "text2": [
            {"file": "Hi", "language": "en"},
            {"file": "There", "language": "de"},
        ],
    }
    result = group_input(input_dict)
    expected = [
        {
            "text1": [{"file": "Hello", "language": "en", "id": "1"}],
            "text2": [{"file": "Hi", "language": "en"}],
        },
        {
            "text1": [{"file": "World", "language": "de", "id": "2"}],
            "text2": [{"file": "There", "language": "de"}],
        },
    ]
    self.assertEqual(result, expected)

  def test_group_input_multiple_inputs_related_dimensions_ignore(self) -> None:
    """Tests grouping of multiple inputs with related dimensions and one to ignore."""
    input_dict = {
        "text1": [
            {"file": "Hello", "language": "en", "id": "1"},
            {"file": "World", "language": "de", "id": "2"},
        ],
        "text2": [
            {"file": "Hi", "language": "en"},
            {"file": "There", "language": "de"},
        ],
    }
    result = group_input(input_dict, ["id"])
    expected = [
        {
            "text1": [{"file": "Hello", "language": "en", "id": "1"}],
            "text2": [{"file": "Hi", "language": "en"}],
        },
        {
            "text1": [{"file": "World", "language": "de", "id": "2"}],
            "text2": [{"file": "There", "language": "de"}],
        },
    ]
    self.assertEqual(result, expected)

  def test_group_input_complex_example(self) -> None:
    """Tests grouping of a complex example."""
    input_dict = {
        "text1": [
            {"file": "X", "audience": "a"},
            {"file": "Y", "audience": "b"},
            {"file": "Z", "audience": "c"},
            {
                "_error": "Error test",
            },
        ],
        "text2": [
            {"file": "GG", "language": "de", "dialect": "DE"},
            {"file": "HH", "language": "fr", "dialect": "CH"},
            {"file": "GH", "language": "de", "dialect": "CH"},
            {"file": "II", "language": "en", "dialect": "GB"},
        ],
        "image": [
            {"file": "I1", "audience": "a"},
            {"file": "I2", "audience": "a"},
        ],
        "dialectinfo": [
            {"file": "red", "dialect": "DE"},
            {"file": "blue", "dialect": "CH"},
            {"file": "yellow", "dialect": "IT"},
        ],
        "test": [{"file": "A", "option": "1"}, {"file": "B", "option": "2"}],
    }
    expected_len = 15
    output = group_input(input_dict, ["option"])
    print(json.dumps(output, indent=4, sort_keys=True))
    self.assertEqual(len(output), expected_len)


if __name__ == "__main__":
  unittest.main()
