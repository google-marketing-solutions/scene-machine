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

"""Tests for analyse_file."""

import json
import unittest
from unittest import mock

from actions import analyse_file
from common import Key
from util.gcs_wrapper import GCS


class TestAnalyseFile(unittest.TestCase):
    """Tests for analyse_file."""

    @mock.patch("actions_lib.gemini.prompt")
    def test_execute_simple(self, mock_gemini_prompt):
        """Tests execute without generation prompt."""
        mock_gcs = mock.Mock(spec=GCS)
        mock_gcs.get_uri.return_value = "gs://bucket/file.png"
        mock_gemini_prompt.return_value = {"result": "success"}

        params = {Key.WORKFLOW_PARAMS.value: {Key.GCP_PROJECT.value: "test-proj"}}
        prompt = "describe this file"
        file_input = [{Key.FILE.value: "path/to/file.png"}]

        output = analyse_file.execute(
            gcs=mock_gcs,
            params=params,
            prompt=prompt,
            file=file_input,
            generation_prompt=None,
            response_schema={},
        )

        self.assertEqual(
            output, {"text": [{"value": json.dumps({"result": "success"})}]}
        )
        mock_gemini_prompt.assert_called_once_with(
            gcp_project="test-proj",
            text_prompt="describe this file",
            file_uris=["gs://bucket/file.png"],
            response_schema={},
            model="gemini-2.5-flash",
        )

    @mock.patch("actions_lib.gemini.prompt")
    def test_execute_with_generation_prompt(self, mock_gemini_prompt):
        """Tests execute with generation_prompt."""
        mock_gcs = mock.Mock(spec=GCS)
        mock_gcs.get_uri.return_value = "gs://bucket/file.png"
        mock_gcs.load_text.return_value = "original generation prompt"
        mock_gemini_prompt.return_value = "success"

        params = {Key.WORKFLOW_PARAMS.value: {Key.GCP_PROJECT.value: "test-proj"}}
        prompt = "describe this file"
        file_input = [{Key.FILE.value: "path/to/file.png"}]
        gen_prompt_input = [{Key.FILE.value: "path/to/prompt.txt"}]

        analyse_file.execute(
            gcs=mock_gcs,
            params=params,
            prompt=prompt,
            file=file_input,
            generation_prompt=gen_prompt_input,
            response_schema={},
        )

        mock_gemini_prompt.assert_called_once()
        called_kwargs = mock_gemini_prompt.call_args.kwargs
        called_prompt = called_kwargs["text_prompt"]

        self.assertIn("describe this file", called_prompt)
        self.assertIn(
            "<ORIGINAL_PROMPT>original generation prompt</ORIGINAL_PROMPT>",
            called_prompt,
        )


if __name__ == "__main__":
    unittest.main()
