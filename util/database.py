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

"""Manages the content of a workflow execution's Firestore collection."""

import datetime
import typing
from typing import Any

from common import Key
from common import logger
from google.cloud import firestore
from google.cloud.firestore import DocumentSnapshot


MAX_ATTEMPTS = 75


def firestore_to_json_serialisable(data: Any) -> Any:
  """Converts Firestore data types to JSON-serialisable formats.

  Args:
    data: Firestore document data.

  Returns:
    Object that only has JSON-serialisable formats.
  """

  if isinstance(data, dict):
    return {k: firestore_to_json_serialisable(v) for k, v in data.items()}
  if isinstance(data, list):
    return [firestore_to_json_serialisable(item) for item in data]
  if isinstance(data, datetime.datetime):
    return data.isoformat()
  return data


def remove_group_level(
    dictionary: dict[str, dict[str, Any]],
) -> dict[str, list[Any]]:
  """Turns dicts like {a: {0: [...] }, ...} into {a: [...], ...}.

  When collecting input data in Firestore, for each input, the bunches received
  from the upstream nodes' various parallel instances get registered separately,
  indexed by the ID of their input group. Where this is not expected downstream,
  this function removes that level.

  Args:
    dictionary: with group level

  Returns:
    Dictionary without group level.
  """
  result = {}
  for key, inner_dict in dictionary.items():
    flattened = []
    for k in sorted(inner_dict.keys()):
      flattened.extend(inner_dict[k])
    result[key] = flattened
  return result


class Database:
  """Encapsulates Firestore functionality."""

  def __init__(self, database: str) -> None:
    """Initialises the object.

    Args:
        database: The Firestore database to use.
    """
    self.db = firestore.Client(database=database)

  def store_workflow(
      self,
      execution_id: str,
      workflow_def: dict[str, Any],
      workflow_params: dict[str, Any],
  ) -> None:
    """Stores the workflow definition and parameters.

    Args:
      execution_id: The workflow's execution ID.
      workflow_def: The workflow definition.
      workflow_params: The workflow parameters.
    """
    batch = self.db.batch()
    batch.set(
        self.db.collection(execution_id).document(Key.WORKFLOW_DEF.value),
        workflow_def,
    )
    batch.set(
        self.db.collection(execution_id).document(Key.WORKFLOW_PARAMS.value),
        workflow_params,
    )
    batch.commit()

  def verify_input(
      self,
      execution_id: str,
      node_id: str,
      group_id: typing.Union[str, int],
      input_names: typing.Iterable[str],
      new_files: dict[str, Any],
      input_count: int,
  ) -> tuple[bool, dict[str, Any]]:
    """Adds input data and determines whether it is complete.

    Args:
      execution_id: The workflow's execution ID.
      node_id: The node ID being checked.
      group_id: The group ID being checked.
      input_names: The node's input names.
      new_files: The input files added to this node in this instance.
      input_count: number of input groups to this node.

    Returns:
      Tuple of whether the input is complete and, if so, the totality of input.
    """
    # Write inputs to subcollection (blind write, no transaction)
    inputs_ref = (
        self.db.collection(execution_id)
        .document(node_id)
        .collection(Key.INPUT_FILES.value)
    )

    for key, value in new_files.items():
      # Use deterministic ID to prevent duplicates on retry
      doc_id = f'{group_id}_{key}'
      inputs_ref.document(doc_id).set({
          Key.GROUP_ID.value: str(group_id),
          'key': key,
          'value': value,
          'timestamp': datetime.datetime.now(datetime.timezone.utc),
      })

    # Sync expected counts for the inputs being supplied.
    # This ensures that even if inputs come from different sources with
    # different counts, we aggregate the requirements correctly.
    node_ref = self.db.collection(execution_id).document(node_id)
    current_input_counts = {k: input_count for k in new_files.keys()}

    @firestore.transactional
    def sync_targets(
        transaction: firestore.Transaction,
        node_ref: firestore.DocumentReference,
        current_updates: dict[str, int],
    ) -> dict[str, int]:
      """Synchronises expected input counts into the node's Firestore document.

      Args:
        transaction: The active Firestore transaction object.
        node_ref: Reference to the node's Firestore document.
        current_updates: Dictionary mapping input names to expected counts.

      Returns:
        The comprehensively merged target counts for all known inputs.
      """
      snapshot = node_ref.get(transaction=transaction)
      current_data = snapshot.to_dict() or {}
      stored_targets = current_data.get(Key.TARGET_COUNTS.value, {})
      needs_update = False
      for k, v in current_updates.items():
        if stored_targets.get(k) != v:
          stored_targets[k] = v
          needs_update = True
      if needs_update:
        transaction.set(
            node_ref, {Key.TARGET_COUNTS.value: stored_targets}, merge=True
        )
      return stored_targets

    target_counts = sync_targets(
        self.db.transaction(max_attempts=MAX_ATTEMPTS),
        node_ref,
        current_input_counts,
    )

    # Check if we have targets for all input_names
    for name in input_names:
      if name not in target_counts:
        # We don't know the expected count for a required input yet.
        return False, {}

    # Check if we have enough inputs before reading them all
    # This optimization avoids O(N) reads when we are not yet complete.
    total_expected = sum(target_counts[name] for name in input_names)

    # Note: This count aggregation is efficient and strongly consistent.
    # We access the first result of the first aggregation.
    current_count = inputs_ref.count().get()[0][0].value
    if current_count < total_expected:
      return False, {}

    # Read all inputs to check for completion
    # Note: This is strongly consistent within the parent document scope.
    docs = inputs_ref.stream()

    input_files: dict[str, Any] = {}
    actual_counts = {}
    for doc in docs:
      data = doc.to_dict()
      k = data.get('key')
      g = data.get(Key.GROUP_ID.value)
      v = data.get('value')
      if k and g is not None:
        if k not in input_files:
          input_files[k] = {}
          actual_counts[k] = 0
        # Avoid double counting if multiple entries for same group
        if g not in input_files[k]:
          input_files[k][g] = v
          actual_counts[k] += 1

    # Verify completeness
    all_inputs_present = True
    inputs_complete = True

    for key in input_names:
      if key not in actual_counts:
        all_inputs_present = False
        inputs_complete = False
        break
      if actual_counts[key] < target_counts[key]:
        inputs_complete = False

    # Also check if any input has MORE than expected (error condition)
    for key, count in actual_counts.items():
      if key in target_counts and count > target_counts[key]:
        logger.error(
            '[%s] Too many inputs for %s: %s > %s',
            execution_id,
            node_id,
            count,
            target_counts[key],
        )

    input_files_arrays = remove_group_level(input_files)

    if all_inputs_present and inputs_complete:

      @firestore.transactional
      def mark_complete_if_needed(
          transaction: firestore.Transaction,
          node_ref: firestore.DocumentReference,
          update_data: dict[str, Any],
      ) -> bool:
        """Atomically marks the inputs as complete if not already marked.

        Args:
          transaction: The active Firestore transaction object.
          node_ref: Reference to the node's Firestore document.
          update_data: The fully aggregated dataset and actual counts computed.

        Returns:
          Whether this transaction successfully sealed the node.
        """
        snapshot = node_ref.get(transaction=transaction)
        current_data = snapshot.to_dict() or {}
        # If ACTUAL_COUNTS is already present, another thread beat us to it.
        if Key.ACTUAL_COUNTS.value in current_data:
          return False
        transaction.set(node_ref, update_data, merge=True)
        return True

      update_data = {
          Key.INPUT_FILES.value: input_files,
          Key.ACTUAL_COUNTS.value: actual_counts,
          Key.LAST_UPDATED.value: datetime.datetime.now(datetime.timezone.utc),
      }

      # Only return True if THIS thread was the one to flip the state
      is_first_to_complete = mark_complete_if_needed(
          self.db.transaction(max_attempts=MAX_ATTEMPTS), node_ref, update_data
      )

      if is_first_to_complete:
        return True, input_files_arrays

      # If we weren't the first, act as if we are still waiting
      # (the other thread is handling the trigger)
      return False, {}

    return False, {}

  def store_groups(
      self, execution_id: str, node_id: str, input_groups: dict[str, Any]
  ) -> None:
    """Stores fan-out input parameters for parallelisation into Firestore.

    Args:
      execution_id: The workflow's execution ID.
      node_id: The node ID these groups are destined for.
      input_groups: The dictionary of inputs to the individual node executions.
    """
    logger.info((execution_id, 'STORING GROUPS', node_id, input_groups))

    @firestore.transactional
    def add_data(
        transaction: firestore.Transaction,
        execution_id: str,
        node_id: str,
        input_groups: list[dict[str, Any]],
    ) -> None:
      node_ref = self.db.collection(execution_id).document(node_id)
      node_doc = typing.cast(
          DocumentSnapshot, node_ref.get(transaction=transaction)
      )
      if not node_doc.exists:
        raise RuntimeError('Document must exist')
      update_data = {
          Key.INPUT_GROUPS.value: input_groups,
          Key.LAST_UPDATED.value: datetime.datetime.now(datetime.timezone.utc),
      }
      transaction.set(node_ref, update_data, merge=True)

    add_data(
        self.db.transaction(max_attempts=MAX_ATTEMPTS),
        execution_id,
        node_id,
        input_groups,
    )

  def store_output(
      self,
      execution_id: str,
      node_id: str,
      group_id: typing.Union[str, int],
      output: dict[str, Any],
  ) -> None:
    """Adds output from a node execution group into Firestore.

    Args:
      execution_id: The workflow's execution ID.
      node_id: The node ID that executed the workload.
      group_id: The specific sub-task/group identifier that finished.
      output: The resulting payload dictionary returned by the action.
    """
    node_ref = self.db.collection(execution_id).document(node_id)

    # Pass a deeply nested dictionary.
    # merge=True will safely combine this with existing group outputs.
    node_ref.set(
        {
            Key.OUTPUT.value: {str(group_id): output},
            Key.LAST_UPDATED.value: datetime.datetime.now(
                datetime.timezone.utc
            ),
        },
        merge=True,
    )

  def get_documents(self, execution_id: str) -> typing.Iterable[typing.Any]:
    """Gets all node state documents within the specified workflow execution.

    Args:
      execution_id: The workflow's execution ID.

    Returns:
      A generator stream yielding all Firestore documents within the collection.
    """
    return self.db.collection(execution_id).stream()
