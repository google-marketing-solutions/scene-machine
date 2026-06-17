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

"""Characterization tests for the orchestration engine (S0.B).

These tests pin the engine semantics that the product depends on, so that
any re-architecture can prove it preserved them. Each test names the
invariant it pins. Two kinds of test live here:

  - INVARIANT tests pin behavior the product relies on by design
    (fan-out, join, error containment, the sink contract).
  - CHARACTERIZATION tests pin CURRENT behavior that is known to be
    buggy or risky; they document the status quo so that a deliberate fix
    can flip them. Each carries a comment naming the known issue.

The orchestrator runs in local mode (instance=None, threads instead of
Cloud Tasks) against the in-memory Firestore fake in firestore_fake.py;
the real util/database.py counting/sealing logic runs unmodified. The
GCS-backed action cache and the action implementations are mocked at the
same boundaries the existing action tests use.

orchestrator.py has import-time side effects (it reads
ui/definitions/config.json, constructs a Firestore client, and calls the
GCE metadata server without a timeout); the orch fixture neutralises all
three BEFORE the first import.
"""

import copy
import importlib
import json
import pathlib
import threading
import time
from typing import Any
from unittest import mock

import pytest

from test import firestore_fake

_REPO = pathlib.Path(__file__).resolve().parent.parent
_CONFIG_PATH = _REPO / 'ui' / 'definitions' / 'config.json'

_WORKFLOW_PARAMS = {
    'gcpProject': 'test-project',
    'gcpLocation': 'test-location',
    'gcsBucket': 'test-bucket',
    'tasksQueuePrefix': 'Test-',
}

# Generous deadline for thread-driven flows; tests poll and fail fast on
# success, so the full deadline is only ever consumed by a real regression.
_DEADLINE_SECONDS = 15.0
# Deadline used when asserting that something does NOT happen.
_QUIET_SECONDS = 1.5


def _wait_for(predicate, timeout=_DEADLINE_SECONDS, interval=0.02):
  """Polls predicate until true or timeout; never blocks indefinitely."""
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    if predicate():
      return True
    time.sleep(interval)
  return predicate()


class _FakeBlob:
  """Cache blob that never exists and swallows writes."""

  def __init__(self):
    self.metadata = None

  def exists(self):
    return False

  def upload_from_string(self, *_args, **_kwargs):
    pass

  def download_as_string(self):
    raise AssertionError('cache read attempted on a non-existent fake blob')


class _FakeGCS:
  """Stand-in for util.gcs_wrapper.GCS in the action wrapper."""

  def __init__(self, *_args, **_kwargs):
    self.gcs_bucket = mock.Mock()
    self.gcs_bucket.blob = lambda _path: _FakeBlob()


@pytest.fixture(scope='module')
def orch():
  """Imports orchestrator with its import-time side effects neutralised."""
  created_config = False
  if not _CONFIG_PATH.exists():
    _CONFIG_PATH.write_text(
        json.dumps({
            'firestoreDatabase': 'characterization-test',
        }),
        encoding='utf-8',
    )
    created_config = True

  firestore_module = importlib.import_module('google.cloud.firestore')
  real_client = firestore_module.Client
  real_transactional = firestore_module.transactional
  firestore_module.Client = firestore_fake.FakeFirestoreClient
  firestore_module.transactional = firestore_fake.fake_transactional

  requests_module = importlib.import_module('requests')
  real_get = requests_module.get

  def _no_metadata_server(*_args, **_kwargs):
    raise requests_module.exceptions.ConnectionError(
        'test environment: no metadata server'
    )

  requests_module.get = _no_metadata_server
  try:
    orchestrator = importlib.import_module('orchestrator')
  finally:
    requests_module.get = real_get

  yield orchestrator

  firestore_module.Client = real_client
  firestore_module.transactional = real_transactional
  if created_config:
    _CONFIG_PATH.unlink()


@pytest.fixture
def engine(orch, monkeypatch):
  """Fresh in-memory DB + patched GCS + a per-test action registry."""
  database_module = importlib.import_module('util.database')
  gcs_wrapper_module = importlib.import_module('util.gcs_wrapper')
  actions_wrapper_module = importlib.import_module('actions_wrapper')

  fresh_db = database_module.Database('characterization-test')
  monkeypatch.setattr(orch, 'db', fresh_db)
  monkeypatch.setattr(gcs_wrapper_module, 'GCS', _FakeGCS)

  registry: dict[str, Any] = {}

  def _get_action(action_name):
    if action_name not in registry:
      raise RuntimeError(f'test registry has no action "{action_name}"')
    return registry[action_name]

  monkeypatch.setattr(
      actions_wrapper_module, 'get_action_by_name', _get_action
  )

  class Engine:
    db = fresh_db
    actions = registry
    orchestrator = orch

    @staticmethod
    def run(payload):
      return orch.supply_node(copy.deepcopy(payload), instance=None)

    @staticmethod
    def node_doc(execution_id, node_id):
      return fresh_db.db.documents.get((execution_id, node_id))

    @staticmethod
    def sink_output(execution_id):
      doc = Engine.node_doc(execution_id, 'sink') or {}
      return doc.get('output')

  return Engine


def _images(count, **overrides):
  """UI-shaped per-image entries: one product per image by default."""
  items = []
  for index in range(1, count + 1):
    item = {
        'file': f'uploads/img{index}.png',
        'product_id': str(index),
        'image_id': str(index),
        'image_instruction': 'none',
    }
    item.update(overrides)
    items.append(item)
  return items


def _outpaint_dag():
  """root(pass) -> n_outpaint(outpaint_image) -> sink(pass)."""
  return {
      'root': {'action': 'pass', 'input': {'images': None}},
      'n_outpaint': {
          'action': 'outpaint_image',
          'input': {'image': {'node': 'root', 'output': 'images'}},
          'parameters': {},
      },
      'sink': {
          'action': 'pass',
          'input': {
              'outpainted_images': {
                  'node': 'n_outpaint',
                  'output': 'outpainted_image',
              }
          },
      },
  }


def _storyboard_dag():
  """The UI's storyboard pipeline shape (manifest ENG-02)."""
  return {
      'root': {
          'action': 'pass',
          'input': {'images': None, 'user_prompt': None},
      },
      'n_outpaint': {
          'action': 'outpaint_image',
          'input': {'image': {'node': 'root', 'output': 'images'}},
          'parameters': {},
      },
      'n_storyboard': {
          'action': 'generate_storyboard',
          'input': {
              'images': {'node': 'n_outpaint', 'output': 'outpainted_image'},
              'user_prompt': {'node': 'root', 'output': 'user_prompt'},
          },
          'parameters': {},
          'dimensionsConsumed': [
              'product_id',
              'image_id',
              'product_description',
              'image_instruction',
          ],
      },
      'sink': {
          'action': 'pass',
          'input': {
              'storyboard': {'node': 'n_storyboard', 'output': 'storyboard'}
          },
      },
  }


def _payload(workflow_def, input_files):
  return {
      'workflowId': 'characterization',
      'workflowDefinition': workflow_def,
      'workflowParams': dict(_WORKFLOW_PARAMS),
      'nodeId': 'root',
      'forceExecution': True,
      'inputFiles': input_files,
  }


def _register_outpaint(engine, calls=None, fail_files=()):
  """Registers an outpaint mock; optionally failing for given files."""

  def execute(
      gcs,
      workflow_params,
      image: 'NodeInput',
      target_ratio: str = '9:16',
  ):
    del gcs, workflow_params, target_ratio
    if calls is not None:
      calls.append(copy.deepcopy(image))
    if image and image[0]['file'] in fail_files:
      raise ValueError(f'simulated failure for {image[0]["file"]}')
    return {
        'outpainted_image': [{'file': image[0]['file'] + '.outpainted'}]
    }

  execute.__module__ = 'actions.outpaint_image'
  engine.actions['outpaint_image'] = execute


def _register_storyboard(engine, calls):
  def execute(
      gcs,
      workflow_params,
      images: 'NodeInput',
      user_prompt: 'NodeInput',
  ):
    del gcs, workflow_params
    calls.append({
        'images': copy.deepcopy(images),
        'user_prompt': copy.deepcopy(user_prompt),
    })
    return {'storyboard': [{'file': 'generated/storyboard.json'}]}

  execute.__module__ = 'actions.generate_storyboard'
  engine.actions['generate_storyboard'] = execute


# ---------------------------------------------------------------------------
# INVARIANT: fan-out (findings §3.1) — with no dimensionsConsumed, the engine
# runs one action execution per distinct dimension-value tuple. This is
# correctness-critical: actions/outpaint_image.py processes only image[0].
# ---------------------------------------------------------------------------
def test_fanout_one_execution_per_dimension_tuple(engine):
  calls = []
  _register_outpaint(engine, calls=calls)
  execution_id = engine.run(_payload(_outpaint_dag(), {'images': _images(3)}))

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  assert len(calls) == 3
  for received in calls:
    assert len(received) == 1  # one image per execution: image[0] is safe


# ---------------------------------------------------------------------------
# INVARIANT: partition-merge (findings §3.2) — a dimensionless input is a
# separate partition that the cross-product attaches to EVERY group.
# ---------------------------------------------------------------------------
def test_partition_merge_attaches_dimensionless_input():
  group_input = importlib.import_module('util.group_input')
  inputs = {
      'images': _images(3),
      'user_prompt': [{'file': 'uploads/brief.txt'}],
  }
  groups = group_input.group_input(inputs, [])
  assert len(groups) == 3
  for group in groups:
    assert group['user_prompt'] == [{'file': 'uploads/brief.txt'}]

  flattened = group_input.group_input(
      inputs,
      ['product_id', 'image_id', 'product_description', 'image_instruction'],
  )
  assert len(flattened) == 1
  assert len(flattened[0]['images']) == 3
  assert flattened[0]['user_prompt'] == [{'file': 'uploads/brief.txt'}]


# ---------------------------------------------------------------------------
# INVARIANT: dimension propagation (findings §3.3) — the wrapper re-attaches
# the group's dimensions to action outputs; the UI keys outpainted images by
# product_id/image_id read off the sink output.
# ---------------------------------------------------------------------------
def test_dimensions_propagated_to_outputs(engine):
  _register_outpaint(engine)
  execution_id = engine.run(_payload(_outpaint_dag(), {'images': _images(2)}))

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  items = engine.sink_output(execution_id)['0']['outpainted_images']
  keyed = {(item.get('product_id'), item.get('image_id')) for item in items}
  assert keyed == {('1', '1'), ('2', '2')}


# ---------------------------------------------------------------------------
# INVARIANT: join releases the successor exactly once (findings §3.4) — the
# Firestore counting barrier (targetCounts/SIBLING_ACTIONS) collects all
# fan-out outputs and the sealing transaction lets exactly one arrival
# trigger the successor, with the flattened union of inputs.
# ---------------------------------------------------------------------------
def test_join_fires_successor_exactly_once_with_all_inputs(engine):
  storyboard_calls = []
  _register_outpaint(engine)
  _register_storyboard(engine, storyboard_calls)
  payload = _payload(
      _storyboard_dag(),
      {
          'images': _images(3, product_description='Couches for all.'),
          'user_prompt': [{'file': 'uploads/brief.txt'}],
      },
  )
  execution_id = engine.run(payload)

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  assert len(storyboard_calls) == 1
  call = storyboard_calls[0]
  assert len(call['images']) == 3
  assert call['user_prompt'] == [{'file': 'uploads/brief.txt'}]


# ---------------------------------------------------------------------------
# INVARIANT: the seal admits exactly one completer (findings §3.4,
# util/database.py mark_complete_if_needed) — once a node is sealed, a
# redelivered/late arrival for an already-counted group must NOT release the
# node again (Cloud Tasks redelivers; double-release would re-run the node).
# This exercises the seal deterministically, without thread timing.
# ---------------------------------------------------------------------------
def test_join_seal_rejects_late_arrivals(engine):
  execution_id = 'seal-test'
  complete, _ = engine.db.verify_input(
      execution_id, 'node', 0, ['a'], {'a': [{'file': 'f0'}]}, 2
  )
  assert not complete  # 1 of 2 arrivals
  complete, files = engine.db.verify_input(
      execution_id, 'node', 1, ['a'], {'a': [{'file': 'f1'}]}, 2
  )
  assert complete  # 2 of 2: this arrival seals and releases the node
  assert files == {'a': [{'file': 'f0'}, {'file': 'f1'}]}
  # A redelivery of group 1 after sealing must not release the node again.
  complete, files = engine.db.verify_input(
      execution_id, 'node', 1, ['a'], {'a': [{'file': 'f1'}]}, 2
  )
  assert not complete
  assert files == {}


# ---------------------------------------------------------------------------
# CHARACTERIZATION: join-token loss (findings §1.5, manifest ORC-11) — when a
# failure escapes the action wrapper's containment (here: db.store_output
# raising), the group's join token is silently dropped and the downstream
# node waits forever. There is no watchdog. This pins the CURRENT behavior;
# the intended fix (containment around the orchestration layer) is a
# deliberate, separately-reviewed change.
# ---------------------------------------------------------------------------
@pytest.mark.filterwarnings(
    'ignore::pytest.PytestUnhandledThreadExceptionWarning'
)
def test_token_loss_on_store_output_failure_stalls_downstream(
    engine, monkeypatch
):
  # The injected store_output failure escapes inside a worker thread by
  # design (that escape IS the behavior under test), so the unhandled-
  # thread-exception warning is expected here and suppressed.
  storyboard_calls = []
  _register_outpaint(engine)
  _register_storyboard(engine, storyboard_calls)

  real_store_output = engine.db.store_output
  failed = threading.Event()

  def flaky_store_output(execution_id, node_id, group_id, output):
    if node_id == 'n_outpaint' and str(group_id) == '0' and not failed.is_set():
      failed.set()
      raise RuntimeError('simulated Firestore outage')
    return real_store_output(execution_id, node_id, group_id, output)

  monkeypatch.setattr(engine.db, 'store_output', flaky_store_output)

  execution_id = engine.run(
      _payload(
          _storyboard_dag(),
          {
              'images': _images(2),
              'user_prompt': [{'file': 'uploads/brief.txt'}],
          },
      )
  )

  assert _wait_for(failed.is_set)
  # The successor never fires and the sink never produces output: the
  # workflow is permanently stalled (current behavior — no watchdog).
  assert not _wait_for(
      lambda: storyboard_calls or engine.sink_output(execution_id),
      timeout=_QUIET_SECONDS,
  )


# ---------------------------------------------------------------------------
# INVARIANT: per-group error containment + pass-sink forwarding (findings
# §3.6) — an action exception becomes an _error envelope that flows to the
# pass sink unfiltered (the UI's only error surface), the failing group does
# NOT block the join, and successful sibling groups still deliver.
# ---------------------------------------------------------------------------
def test_action_error_contained_and_forwarded_by_pass_sink(engine):
  _register_outpaint(engine, fail_files=('uploads/img2.png',))
  execution_id = engine.run(_payload(_outpaint_dag(), {'images': _images(3)}))

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  items = engine.sink_output(execution_id)['0']['outpainted_images']
  errored = [item for item in items if '_error' in item]
  succeeded = [item for item in items if 'file' in item]
  assert len(errored) == 1
  assert len(succeeded) == 2
  # The error envelope keeps the group's dimensions (UI keys results by them).
  assert errored[0].get('product_id') == '2'


# ---------------------------------------------------------------------------
# INVARIANT: non-pass nodes silently DROP errored inputs (findings §3.6,
# group_input.py:291) — graceful degradation: downstream generation continues
# with the surviving items only. (Pass nodes forward errors; non-pass drop.)
# ---------------------------------------------------------------------------
def test_non_pass_node_drops_errored_inputs(engine):
  storyboard_calls = []
  _register_outpaint(engine, fail_files=('uploads/img1.png',))
  _register_storyboard(engine, storyboard_calls)
  execution_id = engine.run(
      _payload(
          _storyboard_dag(),
          {
              'images': _images(3),
              'user_prompt': [{'file': 'uploads/brief.txt'}],
          },
      )
  )

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  assert len(storyboard_calls) == 1
  received_files = [
      item['file'] for item in storyboard_calls[0]['images'] if 'file' in item
  ]
  assert len(received_files) == 2
  assert not any('img1' in f for f in received_files)


# ---------------------------------------------------------------------------
# INVARIANT: quota containment (findings §3.7, manifest ORC-03) — retryable
# errors re-raise while retries remain (orch.py turns them into HTTP 429 for
# Cloud Tasks redelivery); at the retry cap they are contained into an
# _error envelope keyed by the action's declared outputs, with the input
# dimensions attached, so the workflow proceeds instead of hanging.
# ---------------------------------------------------------------------------
def test_retryable_error_reraises_then_contains_at_cap(engine):
  google_exceptions = importlib.import_module('google.api_core.exceptions')
  actions_wrapper = importlib.import_module('actions_wrapper')

  def quota_limited(
      gcs, workflow_params, image: 'NodeInput', target_ratio: str = '9:16'
  ):
    del gcs, workflow_params, image, target_ratio
    raise google_exceptions.ResourceExhausted('Veo quota exceeded')

  quota_limited.__module__ = 'actions.outpaint_image'
  wrapped = actions_wrapper.wrapper(quota_limited)
  input_files = {'image': [{'file': 'uploads/img1.png', 'product_id': '7'}]}

  with pytest.raises(google_exceptions.ResourceExhausted):
    wrapped(input_files, {}, dict(_WORKFLOW_PARAMS), [], {}, True, True)

  contained = wrapped(
      input_files, {}, dict(_WORKFLOW_PARAMS), [], {}, True, False
  )
  assert list(contained.keys()) == ['outpainted_image']
  assert '_error' in contained['outpainted_image'][0]
  assert contained['outpainted_image'][0].get('product_id') == '7'


# ---------------------------------------------------------------------------
# INVARIANT: the sink contract (findings §3.5, manifest ENG-07) — '0' is
# str(group_id), guaranteed to be the only output key because the sink is a
# 'pass' node with no parameters (one input group, one parameter set). The
# UI reads sink.output['0'] exclusively.
# ---------------------------------------------------------------------------
def test_sink_output_keyed_by_string_zero_only(engine):
  _register_outpaint(engine)
  execution_id = engine.run(_payload(_outpaint_dag(), {'images': _images(3)}))

  assert _wait_for(lambda: engine.sink_output(execution_id) is not None)
  assert list(engine.sink_output(execution_id).keys()) == ['0']


# ---------------------------------------------------------------------------
# INVARIANT (fixed by this branch; was CHARACTERIZATION of findings §10.1a):
# the UI now tags images with 'product_description', which the storyboard
# node's dimensionsConsumed flattens — so products with different
# descriptions land in ONE storyboard group (one generate_storyboard call
# covering all products), matching what the UI consumes (storyboard[0]).
# Before the fix the UI sent 'description', which stayed a live grouping
# dimension and split products into separate, silently-dropped groups.
# ---------------------------------------------------------------------------
def test_descriptions_flattened_into_single_storyboard_group():
  group_input = importlib.import_module('util.group_input')
  images = [
      {
          'file': 'uploads/img1.png',
          'product_id': '1',
          'image_id': '1',
          'image_instruction': 'none',
          'product_description': 'A red couch.',
      },
      {
          'file': 'uploads/img2.png',
          'product_id': '2',
          'image_id': '2',
          'image_instruction': 'none',
          'product_description': 'A blue lamp.',
      },
  ]
  groups = group_input.group_input(
      {'images': images, 'user_prompt': [{'file': 'uploads/brief.txt'}]},
      ['product_id', 'image_id', 'product_description', 'image_instruction'],
  )
  # INTENDED behavior: one group containing every product's images.
  assert len(groups) == 1
  assert len(groups[0]['images']) == 2


# ---------------------------------------------------------------------------
# INVARIANT (fixed by this branch; was CHARACTERIZATION of findings §10.1b):
# the user-entered product description reaches the Gemini prompt. Before the
# fix the UI sent 'description' while actions/generate_storyboard.py reads
# 'product_description', so str(None) = 'None' (truthy) was presented to
# the model as every product's description.
# ---------------------------------------------------------------------------
def test_prompt_receives_actual_product_description():
  generate_storyboard = importlib.import_module('actions.generate_storyboard')

  fake_gcs = mock.MagicMock()
  fake_gcs.load_text.return_value = 'Make an ad.'
  fake_gcs.get_uri.return_value = 'gs://bucket/uploads/img1.png'
  fake_gcs.store.return_value = 'gs://bucket/storyboard.json'

  ui_shaped_images = [{
      'file': 'uploads/img1.png',
      'product_id': '1',
      'image_id': '1',
      'image_instruction': 'none',
      # the key the UI sends since the fix on this branch
      'product_description': 'A red couch.',
  }]

  with mock.patch.object(generate_storyboard.genai, 'Client') as client_class:
    client = client_class.return_value
    response = mock.MagicMock()
    part = mock.MagicMock()
    part.text = (
        '{"storyboard": [{"image_id": "1", "product_id": "1",'
        ' "scene_name": "Scene 1", "video_prompt": "p"}]}'
    )
    response.candidates = [mock.MagicMock()]
    response.candidates[0].content.parts = [part]
    client.models.generate_content.return_value = response

    generate_storyboard.execute(
        fake_gcs,
        {'gcpProject': 'test-project'},
        ui_shaped_images,
        [{'file': 'uploads/brief.txt'}],
        'gemini-test-model',
        'global',
    )

    contents = client.models.generate_content.call_args.kwargs['contents']
  texts = [part.text for part in contents if getattr(part, 'text', None)]
  # INTENDED behavior: the real description reaches the model; the literal
  # 'None' artifact is gone.
  assert "**Product description:** 'A red couch.'\n\n" in texts
  assert not any("'None'" in text for text in texts)
