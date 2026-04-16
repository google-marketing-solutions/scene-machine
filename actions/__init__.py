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

"""
This package contains the actions to be available in Remix Engine.
Each module represents one action, implemented in the function "execute".

Arguments:
- Each function's first argument injects GCS access.
- The workflow-level parameters follow.
- Then the actual input files are referenced.
- Finally, the action's parameters are provided.

Output:
Each function needs to return a dictionary with
    1) output names as keys (as defined in actions.json) and
    2) arrays as values (a single value if only one is returned) that have
    3) a dictionary in which the actual output is the property "value".
(1) allows several outputs, (2) allows several values, (3) allows additional properties.
If there is nothing to be returned, the array in (2) must still exist, but can be empty.
"""
