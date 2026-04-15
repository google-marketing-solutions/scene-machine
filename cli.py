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

"""Enables command-line calls to Remix Engine."""

import argparse
import json
import logging
import os
import sys
from typing import Any

import orchestrator

logging.basicConfig(
    level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s'
)


def get_workflow_status(
    execution_id: str, gcs_bucket: str, sign_urls: bool
) -> None:
  """Attempts to get and print the workflow status, exiting on failure.

  Args:
    execution_id: reference to the execution in question
    gcs_bucket: bucket in which this execution stored its files
    sign_urls: whether or not to sign URLs in the output
  """
  logging.info('Attempting to get status for execution ID: %s', execution_id)
  try:
    status = orchestrator.get_status(execution_id, gcs_bucket, False, sign_urls)
    print(json.dumps(status, indent=2, default=str))
  except Exception as e:  # pylint: disable=broad-exception-caught
    logging.error('Could not retrieve status for %s: %s', execution_id, e)
    sys.exit(1)


def start_workflow(initial_data: dict[str, Any]) -> None:
  """Attempts to start the workflow, exiting on failure.

  Args:
    initial_data: the input bootstrapping the workflow
  """
  logging.info('Starting workflow execution...')
  try:
    execution_id = orchestrator.supply_node(initial_data)
    logging.info('Workflow started locally. Execution ID: %s', execution_id)
    print(execution_id)
  except Exception as e:  # pylint: disable=broad-exception-caught
    logging.error('An error occurred during workflow execution: %s', e)
    sys.exit(1)


def main() -> None:
  """Handles the command-line call."""
  parser = argparse.ArgumentParser(
      description='Start a Remix Engine workflow locally or get its status.'
  )

  group = parser.add_mutually_exclusive_group(required=True)
  group.add_argument(
      '--e',
      metavar='PAYLOAD_FILE_PATH',
      help='Path to the JSON payload file to start a new workflow execution.',
  )
  group.add_argument(
      '--s',
      metavar='EXECUTION_ID',
      help='Execution ID of the workflow to get status information about.',
  )

  parser.add_argument(
      '--bucket',
      metavar='GCS_BUCKET_NAME',
      help='GCS bucket name (required for status lookup with URLs).',
      default=os.environ.get('remix-engine-bucket'),
  )
  parser.add_argument(
      '--signUrls',
      metavar='true/false',
      help='Whether or not to sign URLs.',
      default='true',
  )

  args = parser.parse_args()

  if args.s:
    if not args.bucket:
      logging.error(
          'Error: --bucket argument is required when using --s to get status.'
      )
      sys.exit(1)
    get_workflow_status(args.s, args.bucket, args.signUrls == 'true')

  elif args.e:
    payload_file_path = args.e
    logging.info(
        'Attempting to start workflow from file: %s', payload_file_path
    )

    if not os.path.exists(payload_file_path):
      logging.error('Error: Input file not found: %s', payload_file_path)
      sys.exit(1)

    try:
      with open(payload_file_path, 'r', encoding='utf-8') as f:
        initial_data = json.load(f)
      logging.info('Initial data loaded from %s.', payload_file_path)
      start_workflow(initial_data)

    except (IOError, json.JSONDecodeError) as e:
      logging.error(
          'Error reading or parsing JSON data from %s: %s', payload_file_path, e
      )
      sys.exit(1)
    except Exception as e:  # pylint: disable=broad-exception-caught
      logging.error('Unexpected error processing %s: %s', payload_file_path, e)
      sys.exit(1)


if __name__ == '__main__':
  main()
