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

"""Handles the Cloud Run endpoints of Remix Engine.

This defines the endpoints /supplyNode and /triggerAction.
"""

import copy
import json
import logging
import os
import sys

from common import ContentType
from common import Key
import firebase_admin
from flask import Flask
from flask import request as flask_request
from flask import Response as flask_response
from flask_cors import CORS
import orchestrator
from util import errors as util_errors

# At most the queue's allowed attempts minus one, so the workflow proceeds:
_MAX_ALLOWED_RETRIES = 10

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

with open(orchestrator.CONFIG_JSON_PATH, 'r', encoding='utf-8') as file:
  config = json.load(file)
  if 'appEngineUrl' not in config.keys():
    raise RuntimeError('App Engine URL undefined in config.json')

app = Flask(__name__)
CORS(
    app,
    origins=[
        config['appEngineUrl'],
        'http://localhost:4200',
    ],
)

firebase_admin.initialize_app()


@app.route('/' + orchestrator.ENDPOINT_SUPPLY_NODE, methods=['POST'])
def supply_node_handler() -> flask_response:
  """Initiates a node execution by supplying input data to it.

  Returns:
    the default response object returned by Flask

  Raises:
    RuntimeError: if no host header is found
  """
  host = flask_request.headers.get('Host')
  if not host:
    raise RuntimeError('No host header found')
  data = flask_request.get_json()
  execution_id = orchestrator.supply_node(data, 'https://' + host)
  output = {Key.EXECUTION_ID.value: execution_id}
  return flask_response(
      json.dumps(output), status=200, mimetype=ContentType.JSON.value
  )


@app.route('/' + orchestrator.ENDPOINT_TRIGGER_ACTION, methods=['POST'])
def trigger_action_handler() -> tuple[str, int]:
  """Triggers an action's execution.

  Returns:
    response message and HTTP response code

  Raises:
    RuntimeError: if no host header is found
  """
  host = flask_request.headers.get('Host')
  if not host:
    raise RuntimeError('No host header found')
  data = flask_request.get_json()
  retry_count = int(flask_request.headers.get('X-CloudTasks-TaskRetryCount', 0))
  if retry_count > 0:
    logger.info('Retried %s %s times', data[Key.ACTION.value], retry_count)
  try:
    orchestrator.trigger_action(
        copy.deepcopy(data),
        'https://' + host,
        retry_count < _MAX_ALLOWED_RETRIES,
    )
  except Exception as e:  # pylint: disable=broad-exception-caught
    if util_errors.is_retryable(e):
      logger.error('Retrying action %s: %s', data[Key.ACTION.value], e)
      return 'Quota Exceeded', 429  # Cloud Tasks may retry this
    else:
      logger.error('Fatal error for action %s: %s', data[Key.ACTION.value], e)
      return 'Internal Error', 200  # Cloud Tasks will NOT retry this
  return (
      (
          f'Action {data[Key.ACTION.value]} triggered for'
          f' {data[Key.INPUT_FILES.value]} and'
          f' {data.get(Key.PARAMETERS.value, {})}'
      ),
      200,
  )


@app.route('/' + orchestrator.ENDPOINT_GET_STATUS, methods=['GET'])
def get_status_handler() -> flask_response:
  """Returns the status of the workflow execution.

  Returns:
    the default response object returned by Flask
  """
  execution_id = flask_request.args.get(Key.EXECUTION_ID.value)
  gcs_bucket_name = flask_request.args.get(Key.GCS_BUCKET.value)
  sign_urls = flask_request.args.get(Key.SIGN_URLS.value) == 'true'
  if not execution_id or not gcs_bucket_name:
    return flask_response(
        json.dumps({'error': 'Incomplete parameters for status request'}),
        status=400,
        mimetype=ContentType.JSON.value,
    )
  try:
    node_status = orchestrator.get_status(
        execution_id, gcs_bucket_name, True, sign_urls
    )
    return flask_response(
        json.dumps(node_status), status=200, mimetype=ContentType.JSON.value
    )
  except Exception as e:  # pylint: disable=broad-exception-caught
    sys.stderr.write(f'Error fetching status for execution {execution_id}: {e}')
    orchestrator.logger.error(
        'Error fetching status for execution %s: %s', execution_id, e
    )
    return flask_response(
        json.dumps({'error': 'Failed to retrieve execution status'}),
        status=500,
        mimetype=ContentType.JSON.value,
    )


if __name__ == '__main__':
  logger.info('Running in Flask mode')
  app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
