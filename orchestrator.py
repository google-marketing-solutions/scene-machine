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

"""Orchestrates workflows."""

import copy
import datetime
import json
import logging
import os
import pathlib
import sys
import threading
from typing import Any
import uuid

import actions_wrapper as actwrap
from common import ContentType
from common import Key
import google.auth.transport.requests
from google.cloud import tasks_v2
import google.cloud.logging
import google.oauth2.id_token
import requests
from util import database
from util import dimensions as util_dimensions
from util import gcs_wrapper
from util import group_input
from util import workflow as util_workflow

ACTIONS_JSON_PATH = 'ui/definitions/actions.json'
CONFIG_JSON_PATH = 'ui/definitions/config.json'
ENDPOINT_GET_STATUS = 'getStatus'
ENDPOINT_SUPPLY_NODE = 'supplyNode'
ENDPOINT_TRIGGER_ACTION = 'triggerAction'

_TASKS_QUEUE_CLASS_DEFAULT = 'Other'
_GCS_HOST = 'https://storage.mtls.cloud.google.com/'


if os.environ.get('K_SERVICE'):
  google.cloud.logging.Client().setup_logging()
else:
  logging.basicConfig(
      level=logging.INFO,
      format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
      handlers=[logging.StreamHandler(sys.stdout)],
  )

logger = logging.getLogger(__name__)


root_dir = pathlib.Path(__file__).parent
with open(root_dir / CONFIG_JSON_PATH, 'r', encoding='utf-8') as file:
  config = json.load(file)
  if 'firestoreDatabase' not in config.keys():
    raise RuntimeError('Database undefined')
db = database.Database(config['firestoreDatabase'])


def get_current_service_account() -> str | None:
  """Get the service account for the current execution context.

  Returns:
    name of the service account
  """
  metadata_url = (
      'http://metadata.google.internal'
      '/computeMetadata/v1/instance/service-accounts/default/email'
  )
  headers = {'Metadata-Flavor': 'Google'}

  try:
    response = requests.get(metadata_url, headers=headers)
    response.raise_for_status()
    return response.text
  except requests.exceptions.RequestException as e:
    logger.error('Error retrieving service account: %s', e)
    # Fallback for local development if needed
    return None


logger.info('Getting service account')
service_account_email = get_current_service_account()
logger.info('Running as: %s', service_account_email)


def supply_node(
    data: dict[str, Any], instance: str | None = None
) -> tuple[str, int]:
  """Supplies a workflow node with input data.

  Args:
    data: The workload description.
    instance: The address of the Cloud Run instance to use.
  Returns:
    The execution ID.
  """
  # In the initial run, set the execution ID and store the workflow:
  if Key.EXECUTION_ID.value not in data:
    execution_id = (
        datetime.datetime.now().strftime('%Y-%m-%d_%H:%M_')
        + data[Key.WORKFLOW_ID.value]
        + '_'
        + uuid.uuid4().hex[:10]
    )
    data[Key.EXECUTION_ID.value] = execution_id
    db.store_workflow(
        execution_id,
        data[Key.WORKFLOW_DEF.value],
        data[Key.WORKFLOW_PARAMS.value],
    )
  else:
    execution_id = data[Key.EXECUTION_ID.value]
  node_id = data[Key.NODE_ID.value]
  node = data[Key.WORKFLOW_DEF.value][node_id]
  node[Key.INPUT.value] = node.get(Key.INPUT.value, {})
  action = node[Key.ACTION.value]
  with open(root_dir / ACTIONS_JSON_PATH, 'r', encoding='utf-8') as json_file:
    actions_def = json.load(json_file)
    if action != 'pass' and action not in actions_def.keys():
      return 'Action undefined', 404
  number_of_initial_executions = 1
  input_complete, input_files = db.verify_input(
      execution_id,
      node_id,
      data.get(Key.GROUP_ID.value, 0),
      node[Key.INPUT.value].keys(),
      data[Key.INPUT_FILES.value],
      data.get(Key.INPUT_COUNT.value, number_of_initial_executions),
  )
  if not input_complete:
    logger.info('[%s] Node %s not yet started', execution_id, node_id)
    return f'Node {node_id} not yet started', 202
  input_files_renamed = util_dimensions.rename_dimensions(
      input_files, node.get(Key.DIMENSIONS_MAPPING.value, {}), True
  )

  if action == 'pass':
    input_groups = [input_files_renamed]
  else:
    input_groups = group_input.group_input(
        input_files_renamed, node.get(Key.DIMENSIONS_CONSUMED.value, [])
    )
  expanded_parameters = util_workflow.expand_parameters(
      node.get(Key.PARAMETERS.value, {})
  )
  logger.info(
      (execution_id, 'SUPPLY', action, input_groups, expanded_parameters)
  )
  groups = {}
  group_id = 0
  if not node[Key.INPUT.value]:
    input_groups = [{}]  # prevents nodes without input from being skipped
  for input_group in input_groups:
    for parameters in expanded_parameters:
      groups[str(group_id)] = {'input': input_group, 'parameters': parameters}
      task_payload = {
          Key.ACTION.value: action,
          Key.INPUT_FILES.value: input_group,
          Key.PARAMETERS.value: parameters,
          Key.WORKFLOW_DEF.value: data[Key.WORKFLOW_DEF.value],
          Key.WORKFLOW_PARAMS.value: data.get(Key.WORKFLOW_PARAMS.value, {}),
          Key.FORCE_EXECUTION.value: data.get(Key.FORCE_EXECUTION.value, False),
          Key.EXECUTION_ID.value: execution_id,
          Key.NODE_ID.value: node_id,
          Key.GROUP_ID.value: group_id,
          Key.SIBLING_ACTIONS.value: (
              len(input_groups) * len(expanded_parameters)
          ),
      }

      if instance:
        params = task_payload[Key.WORKFLOW_PARAMS.value]
        client = tasks_v2.CloudTasksClient()
        if action in actions_def:
          tasks_queue_suffix = actions_def[action].get(
              Key.TASKS_CLASS.value, _TASKS_QUEUE_CLASS_DEFAULT
          )
        else:
          tasks_queue_suffix = _TASKS_QUEUE_CLASS_DEFAULT
        tasks_queue = params[Key.TASKS_QUEUE_PREFIX.value] + tasks_queue_suffix
        logger.info(
            '[%s] Calling triggerAction on queue %s', execution_id, tasks_queue
        )
        queue_path = client.queue_path(
            params[Key.GCP_PROJECT.value],
            params[Key.GCP_LOCATION.value],
            tasks_queue,
        )
        task = tasks_v2.Task(
            http_request=tasks_v2.HttpRequest(
                http_method=tasks_v2.HttpMethod.POST,
                url=f'{instance}/{ENDPOINT_TRIGGER_ACTION}',
                headers={'Content-Type': ContentType.JSON.value},
                body=json.dumps(task_payload).encode('utf-8'),
                oidc_token=tasks_v2.OidcToken(
                    service_account_email=service_account_email
                ),
            ),
            dispatch_deadline={'seconds': 1800},
        )
        client.create_task(parent=queue_path, task=task)
      else:
        thread = threading.Thread(
            target=trigger_action,
            args=(copy.deepcopy(task_payload),),
        )
        thread.start()
      group_id += 1
  db.store_groups(execution_id, node_id, groups)
  return execution_id


def _inform_successors(
    instance: str | None, data: dict[str, Any], output: dict[str, Any]
) -> None:
  """Informs successor nodes of the current node's output.

  Args:
    instance: The address of the Cloud Run instance, if any.
    data: The workflow description.
    output: The output dictionary of the current node.
  """
  current_node_id = data[Key.NODE_ID.value]
  workflow_def = data[Key.WORKFLOW_DEF.value]
  successor_nodes = util_workflow.determine_successors(
      workflow_def, current_node_id
  )
  for successor_node_id in successor_nodes:
    input_files = util_workflow.map_output_to_input(
        current_node_id,
        output,
        workflow_def[successor_node_id].get(Key.INPUT.value, {}),
    )
    successor_data = copy.deepcopy(data)
    successor_data[Key.NODE_ID.value] = successor_node_id
    successor_data[Key.INPUT_FILES.value] = input_files
    successor_data[Key.INPUT_COUNT.value] = data[Key.SIBLING_ACTIONS.value]

    if instance:
      params = successor_data[Key.WORKFLOW_PARAMS.value]
      client = tasks_v2.CloudTasksClient()
      queue_path = client.queue_path(
          params[Key.GCP_PROJECT.value],
          params[Key.GCP_LOCATION.value],
          params[Key.TASKS_QUEUE_PREFIX.value] + _TASKS_QUEUE_CLASS_DEFAULT,
      )

      task = tasks_v2.Task(
          http_request=tasks_v2.HttpRequest(
              http_method=tasks_v2.HttpMethod.POST,
              url=f'{instance}/{ENDPOINT_SUPPLY_NODE}',
              headers={'Content-Type': 'application/json'},
              body=json.dumps(successor_data).encode('utf-8'),
              oidc_token=tasks_v2.OidcToken(
                  service_account_email=service_account_email
              ),
          ),
          dispatch_deadline={'seconds': 1800},
      )
      client.create_task(parent=queue_path, task=task)
    else:
      thread = threading.Thread(target=supply_node, args=(successor_data,))
      thread.start()


def trigger_action(
    data: dict[str, Any],
    instance: str | None = None,
    can_still_retry: bool = False,
) -> None:
  """Triggers an action's execution.

  Args:
    data: The workfload description.
    instance: The address of the Cloud Run instance to use.
    can_still_retry: Flag specifying whether failure would be final.
  """
  action = data[Key.ACTION.value]
  node_id = data[Key.NODE_ID.value]
  node = data[Key.WORKFLOW_DEF.value][node_id]
  logger.info((
      data[Key.EXECUTION_ID.value],
      'TRIGGER',
      node,
      action,
      data[Key.GROUP_ID.value],
      data[Key.INPUT_FILES.value],
  ))
  if action != 'pass':
    func = actwrap.wrapper(actwrap.get_action_by_name(action))
  else:  # For pass action, simply forward
    func = lambda input_files, *_: input_files
  output = func(
      data[Key.INPUT_FILES.value],
      data.get(Key.PARAMETERS.value, {}),
      data[Key.WORKFLOW_PARAMS.value],
      node.get(Key.DIMENSIONS_CONSUMED.value, []),
      node.get(Key.DIMENSIONS_MAPPING.value, {}),
      data[Key.FORCE_EXECUTION.value],
      can_still_retry,
  )

  db.store_output(
      data[Key.EXECUTION_ID.value], node_id, data[Key.GROUP_ID.value], output
  )
  logger.info((data[Key.EXECUTION_ID.value], 'PERFORMED', node, action, output))
  _inform_successors(instance, data, output)


def get_status(
    execution_id: str,
    gcs_bucket_name: str,
    flask_context: bool = False,
    sign_urls: bool = True,
) -> dict[str, Any]:
  """Returns the status of the workflow execution as a dictionary."""
  url_cache = {}

  def _add_urls(structure, gcs_bucket_name, sign_urls):
    """Adds URLs to file references."""
    for items in structure.values():
      for item in items:
        if isinstance(item, dict) and Key.FILE.value in item:
          if sign_urls:
            if item[Key.FILE.value] not in url_cache:
              url_cache[item[Key.FILE.value]] = gcs_wrapper.get_signed_url(
                  gcs_bucket_name, item[Key.FILE.value], flask_context
              )
            item[Key.URL.value] = url_cache[item[Key.FILE.value]]
          else:
            item[Key.URL.value] = (
                f'{_GCS_HOST}{gcs_bucket_name}/{item[Key.FILE.value]}'
            )

  documents = db.get_documents(execution_id)
  nodes_status = {}
  for doc in documents:
    node_data = doc.to_dict()
    if not node_data:
      continue
    nodes_status[doc.id] = database.firestore_to_json_serialisable(node_data)
    node_status = nodes_status[doc.id]
    # Add URLs:
    if Key.INPUT_FILES.value in node_status and isinstance(
        node_status[Key.INPUT_FILES.value], dict
    ):
      input_files_arrays = database.remove_group_level(
          node_status[Key.INPUT_FILES.value]
      )
      _add_urls(input_files_arrays, gcs_bucket_name, sign_urls)
      node_status[Key.INPUT_FILES.value] = input_files_arrays
    if Key.INPUT_GROUPS.value in node_status:
      for input_group in node_status[Key.INPUT_GROUPS.value].values():
        _add_urls(input_group[Key.INPUT.value], gcs_bucket_name, sign_urls)
    if Key.OUTPUT.value in node_status:
      for output_group in node_status[Key.OUTPUT.value].values():
        _add_urls(output_group, gcs_bucket_name, sign_urls)
  return nodes_status
