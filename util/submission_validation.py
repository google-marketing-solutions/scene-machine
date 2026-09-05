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

"""Checks whether a workflow submission can be executed under server policy.

Returns ``(message, code)`` for the first problem, or ``None`` if it passes.
Codes are stable so tests and the UI can branch on them without depending on the
wording.
"""

import functools
import json
import os
from typing import Any

from util.model_allowlist import is_pair_allowed, load_allowlist

_ACTIONS_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'ui', 'definitions', 'actions.json',
)

_MODEL_PARAM_NAMES = ('gemini_model', 'image_model', 'model')
_EXECUTION_ID = 'executionId'
_GROUP_ID = 'groupId'
_INPUT_COUNT = 'inputCount'
_WORKFLOW_ID = 'workflowId'
_NODE_ID = 'nodeId'
_WORKFLOW_DEFINITION = 'workflowDefinition'
_WORKFLOW_PARAMS = 'workflowParams'
_INPUT_FILES = 'inputFiles'
_GCP_PROJECT = 'gcp_project'
# Node input-edge keys (raw submission JSON; mirrors common.Key).
_INPUT = 'input'
_NODE = 'node'
_OUTPUT = 'output'
_PASS = 'pass'
# Client-settable dimension controls (common.Key). A node carrying either can
# split a shared source into independent dimensions the engine cross-products.
_DIMENSIONS_MAPPING = 'dimensionsMapping'
_DIMENSIONS_CONSUMED = 'dimensionsConsumed'

# Cost cap: how many *billable* generations (image / Veo / Omni) one submission
# may spawn. Gemini text calls are cheap and deliberately not counted. This is
# the money guardrail.
_MAX_GENERATIONS = 200
# A node's family costs money when the allowlist's per-action default_key names
# one of these. (Omni's key joins here when that action lands.)
_EXPENSIVE_DEFAULT_KEYS = ('imageModel', 'veoModel')

# Structural / queue-safety caps -- generous; the cost cap above is the real
# money bound. _MAX_TOTAL_FAN_OUT bounds the total node executions the
# orchestrator must materialize (billable or not), so a pass-node blow-up can't
# exhaust it.
_MAX_NODES = 200            # nodes in a single workflow
_MAX_INPUT_FILES = 200      # entries in one inputFiles group
_MAX_LIST_LEN = 100         # length of any list-valued node parameter
_MAX_FAN_OUT = 1000         # product of a single node's list-parameter lengths
_MAX_TOTAL_FAN_OUT = 100000  # total node executions across the whole workflow
_MAX_QUANTITY = 100         # value of a variant/video quantity parameter
_QUANTITY_PARAMS = (
    'video_variant_quantity', 'variant_quantity', 'story_variant_quantity')

# Firestore document/collection IDs are one UTF-8 path segment of at most 1,500
# bytes. The generated execution ID adds a timestamp prefix, separator, and
# ten-character suffix around workflowId, leaving this many client bytes.
_MAX_FIRESTORE_SEGMENT_BYTES = 1500
_EXECUTION_ID_OVERHEAD_BYTES = 28
_MAX_WORKFLOW_ID_BYTES = (
    _MAX_FIRESTORE_SEGMENT_BYTES - _EXECUTION_ID_OVERHEAD_BYTES
)
# Task locks use ``<executionId>_<nodeId>_<groupId>``. Reserve separators and
# the largest group ID permitted by the workflow fan-out limit.
_MAX_WORKFLOW_AND_NODE_ID_BYTES = (
    _MAX_FIRESTORE_SEGMENT_BYTES
    - _EXECUTION_ID_OVERHEAD_BYTES
    - 2
    - len(str(_MAX_TOTAL_FAN_OUT - 1))
)
# Input keys are stored as ``<groupId>_<key>``. The total-fan-out cap allows
# group IDs through 99,999, so reserve five digits plus the underscore.
_MAX_INPUT_KEY_BYTES = _MAX_FIRESTORE_SEGMENT_BYTES - 6


@functools.lru_cache(maxsize=1)
def _load_actions_json() -> dict:
  # Parsed once and cached, like the allowlist. A missing/unreadable file then
  # fails on the first load, not on every request at the trust boundary.
  with open(_ACTIONS_JSON, encoding='utf-8') as f:
    return json.load(f)


def _action_params(action: str, actions_json: dict) -> set[str]:
  action_def = actions_json.get(action, {})
  if not isinstance(action_def, dict):
    return set()
  return set(action_def.get('parameters') or {}) | set(action_def.get('input') or {})


def _is_firestore_segment(value: Any, *, max_bytes: int) -> bool:
  """Whether value is one legal Firestore collection/document path segment."""
  if (
      not isinstance(value, str)
      or not value.strip()
      or '/' in value
      or value in ('.', '..')
      or (value.startswith('__') and value.endswith('__'))
  ):
    return False
  try:
    return len(value.encode('utf-8')) <= max_bytes
  except UnicodeEncodeError:
    return False


def _node_output_names(node: dict, actions_json: dict) -> set[str]:
  action = node.get('action')
  if action == _PASS:
    node_input = node.get(_INPUT)
    return set(node_input) if isinstance(node_input, dict) else set()
  if not isinstance(action, str):
    return set()
  action_def = actions_json.get(action, {})
  if not isinstance(action_def, dict):
    return set()
  outputs = action_def.get('output')
  return set(outputs) if isinstance(outputs, dict) else set()


def _model_param_name(action: str, actions_json: dict) -> str | None:
  for name in _MODEL_PARAM_NAMES:
    if name in _action_params(action, actions_json):
      return name
  return None


def _as_values(value: Any) -> list:
  """Returns values after engine-style list expansion (util.workflow)."""
  return value if isinstance(value, list) else [value]


def _capability_violation(
    node_id: str,
    action: str,
    model: str,
    caps: dict,
    params: dict,
    action_params: set[str],
) -> tuple[str, str] | None:
  """Checks `params` against `model`'s catalog capabilities.

  Generic across actions: a parameter is only checked when it is present in
  `params` AND the model's capabilities carry the matching field, so absent
  parameters and unrestricted models always pass. List-valued parameters are
  checked element-wise via `_as_values`, matching the engine's cross-product
  expansion (util/workflow.py) -- a non-string/odd value simply fails the
  membership test and is reported as not allowed.

  `action_params` is the action's declared parameter/input names, used to
  scope the audio-required check to actions that actually declare
  `generate_audio` -- an action that never sends it (edit_video today) cannot
  be held to it, whatever the model's capabilities say.
  """
  if 'aspect_ratio' in params and 'allowed_aspect_ratios' in caps:
    for value in _as_values(params['aspect_ratio']):
      if value not in caps['allowed_aspect_ratios']:
        return (
            (
                f'Node {node_id!r}: {action} aspect_ratio {value!r} is not '
                f'allowed for {model!r}'
            ),
            'ASPECT_RATIO_NOT_ALLOWED',
        )

  if 'resolution' in params and 'allowed_resolutions' in caps:
    for value in _as_values(params['resolution']):
      if value not in caps['allowed_resolutions']:
        return (
            (
                f'Node {node_id!r}: {action} resolution {value!r} is not '
                f'allowed for {model!r}'
            ),
            'RESOLUTION_NOT_ALLOWED',
        )

  if (
      'duration_seconds' in params
      and 'duration_by_resolution' in caps
      and 'resolution' in params
  ):
    duration_by_resolution = caps['duration_by_resolution']
    # Pairwise, not a union of what each resolution alone allows: list
    # parameters expand as a full cross product, so every (resolution,
    # duration) combination the engine would actually run must be checked.
    for resolution in _as_values(params['resolution']):
      if not isinstance(resolution, str):
        continue  # can never be a key of the mapping
      allowed_durations = duration_by_resolution.get(resolution)
      if allowed_durations is None:
        continue  # not a key of the mapping; the resolution check above owns it
      for duration in _as_values(params['duration_seconds']):
        if (
            isinstance(duration, bool)
            or not isinstance(duration, int)
            or duration not in allowed_durations
        ):
          return (
              (
                  f'Node {node_id!r}: {action} duration_seconds {duration!r} '
                  f'is not allowed for {model!r} at resolution '
                  f'{resolution!r}'
              ),
              'DURATION_NOT_ALLOWED',
          )

  if caps.get('audio_always_on') is True and 'generate_audio' in action_params:
    if 'generate_audio' not in params:
      return (
          (
              f'Node {node_id!r}: {model!r} always generates audio; '
              'generate_audio must be true'
          ),
          'AUDIO_REQUIRED',
      )
    for value in _as_values(params['generate_audio']):
      if value is not True:
        return (
            (
                f'Node {node_id!r}: {model!r} always generates audio; '
                'generate_audio must be true'
            ),
            'AUDIO_REQUIRED',
        )

  return None


def validate_submission(
    data: Any,
    allowlist: dict | None = None,
    actions_json: dict | None = None,
) -> tuple[str, str] | None:
  """Returns ``(message, code)`` for the first problem, else ``None``.

  This runs at the app's trust boundary, so it fails closed: any shape it can't
  make sense of is rejected as ``MALFORMED_SUBMISSION`` rather than passed on --
  a malformed node would otherwise crash the orchestrator with a 500."""
  allowlist = allowlist if allowlist is not None else load_allowlist()
  actions_json = actions_json if actions_json is not None else _load_actions_json()
  action_specs = allowlist['actions']
  models = allowlist['models']

  if not isinstance(data, dict):
    return ('submission is not an object', 'MALFORMED_SUBMISSION')

  # A resume payload carries an executionId and skips the store step. The
  # orchestrator branches on the key being present (any value, empty string
  # included), so match it: reject on presence, not truthiness.
  if _EXECUTION_ID in data:
    return ('executionId is not allowed on this route', 'EXECUTION_ID_NOT_ALLOWED')
  for field in (_GROUP_ID, _INPUT_COUNT):
    if field in data:
      return (f'{field} is not allowed on this route',
              'SERVER_FIELD_NOT_ALLOWED')

  workflow_id = data.get(_WORKFLOW_ID)
  if not _is_firestore_segment(
      workflow_id, max_bytes=_MAX_WORKFLOW_ID_BYTES
  ):
    return ('workflowId must be a valid Firestore path segment',
            'MALFORMED_SUBMISSION')
  selected_node_id = data.get(_NODE_ID)
  if not _is_firestore_segment(
      selected_node_id, max_bytes=_MAX_FIRESTORE_SEGMENT_BYTES
  ):
    return ('nodeId must be a valid Firestore path segment',
            'MALFORMED_SUBMISSION')
  if not isinstance(data.get(_WORKFLOW_PARAMS), dict):
    return ('workflowParams is not an object', 'MALFORMED_SUBMISSION')

  # Each inputFiles group must be a list of file objects with a
  # real file path -- the actions read entry['file'] (Key.FILE), so a non-list
  # group or an entry missing 'file' would crash the engine; fail closed. Record
  # each group's size for the DAG fan-out below.
  input_files = data.get(_INPUT_FILES)
  input_group_sizes = {}
  if not isinstance(input_files, dict):
    return ('inputFiles is not an object', 'MALFORMED_SUBMISSION')
  for key, files in input_files.items():
    if not _is_firestore_segment(
        key, max_bytes=_MAX_INPUT_KEY_BYTES
    ):
      return (f'inputFiles key {key!r} is not a valid Firestore path segment',
              'MALFORMED_SUBMISSION')
    if not isinstance(files, list):
      return (f'inputFiles {key!r} is not a list', 'MALFORMED_SUBMISSION')
    dimension_keys = None
    for entry in files:
      if (not isinstance(entry, dict) or not isinstance(entry.get('file'), str)
          or not entry['file'].strip()):
        return (f'inputFiles {key!r} entries must each have a non-empty '
                f'file', 'MALFORMED_SUBMISSION')
      # The engine groups on the non-file fields of the first entry and
      # indexes every entry by them (group_input._group_dictionaries), so
      # ragged keys raise KeyError there and a non-scalar value makes an
      # unhashable group key. Fail closed on both shapes.
      entry_keys = frozenset(entry) - {'file'}
      if dimension_keys is None:
        dimension_keys = entry_keys
      elif entry_keys != dimension_keys:
        return (f'inputFiles {key!r} entries carry inconsistent dimension '
                'keys', 'MALFORMED_SUBMISSION')
      for field in entry_keys:
        value = entry[field]
        if value is not None and not isinstance(value, (str, int, float, bool)):
          return (f'inputFiles {key!r} dimension {field!r} must be a scalar',
                  'MALFORMED_SUBMISSION')
    if len(files) > _MAX_INPUT_FILES:
      return (f'inputFiles {key!r} has too many entries '
              f'({len(files)} > {_MAX_INPUT_FILES})', 'TOO_MANY_INPUT_FILES')
    # An empty group still becomes one grouping slot in the engine
    # (group_input returns {(): []}), so counting it as 0 would zero out
    # every downstream multiplier and hide real fan-out from the budget.
    input_group_sizes[key] = max(1, len(files))

  definition = data.get(_WORKFLOW_DEFINITION)
  if not isinstance(definition, dict):
    return ('workflowDefinition is not an object', 'MALFORMED_SUBMISSION')
  if len(definition) > _MAX_NODES:
    return (f'workflow has too many nodes ({len(definition)} > {_MAX_NODES})',
            'TOO_MANY_NODES')
  for node_id in definition:
    if not _is_firestore_segment(
        node_id, max_bytes=_MAX_FIRESTORE_SEGMENT_BYTES
    ):
      return (f'Node id {node_id!r} is not a valid Firestore path segment',
              'MALFORMED_SUBMISSION')
    if (
        len(workflow_id.encode('utf-8')) + len(node_id.encode('utf-8'))
        > _MAX_WORKFLOW_AND_NODE_ID_BYTES
    ):
      return (f'workflowId and Node id {node_id!r} are too long for a task '
              'lock', 'MALFORMED_SUBMISSION')
  if selected_node_id not in definition:
    return (f'Node {selected_node_id!r} is not in workflowDefinition',
            'MALFORMED_SUBMISSION')

  # Pass 1: per-node structural, model/location, and per-node-limit checks, in
  # node order. Collect each node's own fan-out (its list/quantity multiplier)
  # for the graph-aware budget below.
  node_locals = {}
  for node_id, node in definition.items():
    if not isinstance(node, dict):
      return (f'Node {node_id!r} is not an object', 'MALFORMED_SUBMISSION')
    action = node.get('action')
    if not isinstance(action, str):
      return (f'Node {node_id!r} has a non-string action', 'MALFORMED_SUBMISSION')
    if action != _PASS and action not in actions_json:
      return (f'Node {node_id!r} has an undefined action {action!r}',
              'ACTION_UNDEFINED')
    # Absence and explicit null are NOT equivalent: the executor reads these
    # fields with .get(key, default), which supplies the default only when the
    # key is missing. A null survives to the engine and crashes it, so a
    # present-but-null field is rejected here while an omitted one defaults.
    if _INPUT in node and not isinstance(node[_INPUT], dict):
      return (f'Node {node_id!r} input is not an object', 'MALFORMED_SUBMISSION')
    node_input = node.get(_INPUT)
    # The referenced action's own metadata is read by the executor whether or
    # not this node declares inputs, so its shape is checked out here rather
    # than inside the input branch below.
    if action != _PASS:
      action_def = actions_json[action]
      if not isinstance(action_def, dict):
        return (
            f'Action {action!r} definition is not an object',
            'MALFORMED_SUBMISSION',
        )
      for key in (_INPUT, 'parameters'):
        if key in action_def and not isinstance(action_def[key], dict):
          return (
              f'Action {action!r} {key} is not an object',
              'MALFORMED_SUBMISSION',
          )
    if node_id == selected_node_id and set(input_files) != set(node_input or {}):
      return (f'Node {node_id!r} inputs and inputFiles groups do not match',
              'MALFORMED_SUBMISSION')
    if node_input is not None:
      for input_key in node_input:
        if not _is_firestore_segment(
            input_key, max_bytes=_MAX_INPUT_KEY_BYTES
        ):
          return (f'Node {node_id!r} input {input_key!r} is not a valid '
                  'Firestore path segment', 'MALFORMED_SUBMISSION')
      if action != _PASS:
        declared_inputs = actions_json[action].get(_INPUT, {})
        undeclared_inputs = set(node_input) - set(declared_inputs)
        if undeclared_inputs:
          return (f'Node {node_id!r} has an undeclared input '
                  f'{sorted(undeclared_inputs)[0]!r}', 'MALFORMED_SUBMISSION')
      for input_key, source in node_input.items():
        if node_id == selected_node_id and source is not None:
          return (f'Node {node_id!r} input {input_key!r} must have a null '
                  'source', 'MALFORMED_SUBMISSION')
        # An edge is null (top-level input) or a {node, output} object; anything
        # else would crash the engine's map_output_to_input (.get on a non-dict).
        if source is None:
          if node_id != selected_node_id:
            return (f'Node {node_id!r} input {input_key!r} has a null source',
                    'MALFORMED_SUBMISSION')
          continue
        if not isinstance(source, dict):
          return (f'Node {node_id!r} has a malformed input source',
                  'MALFORMED_SUBMISSION')
        # A predecessor edge carries {node, output}; both must be non-empty
        # strings. A non-string node throws when hashed in the graph walk; a
        # missing/empty output raises KeyError mapping the predecessor output.
        if (not isinstance(source.get(_NODE), str) or not source.get(_NODE)
            or not isinstance(source.get(_OUTPUT), str) or not source.get(_OUTPUT)):
          return (f'Node {node_id!r} has a malformed input edge (node/output '
                  f'must be non-empty strings)', 'MALFORMED_SUBMISSION')
        predecessor = definition.get(source[_NODE])
        if (isinstance(predecessor, dict)
            and source[_OUTPUT] not in _node_output_names(
                predecessor, actions_json
            )):
          return (f'Node {node_id!r} input {input_key!r} references undeclared '
                  f'output {source[_OUTPUT]!r}', 'MALFORMED_SUBMISSION')

    # dimensionsMapping / dimensionsConsumed reach the worker unvalidated: the
    # orchestrator inverts the mapping ({v: k for k, v in mapping.items()}), which
    # throws on a non-dict or an unhashable value, and does `key in
    # dimensionsConsumed`, which throws on a non-list. Fail closed on shape here so
    # a bad control is a 400, not a 500.
    mapping = node.get(_DIMENSIONS_MAPPING)
    if _DIMENSIONS_MAPPING in node:
      if not isinstance(mapping, dict) or any(
          not isinstance(k, str) or not k or not isinstance(v, str) or not v
          for k, v in mapping.items()):
        return (f'Node {node_id!r} has a malformed dimensionsMapping (expected '
                f'an object of non-empty string pairs)', 'MALFORMED_SUBMISSION')
      # The engine inverts the mapping, so duplicate targets silently drop a
      # rename; rename_dimensions requires targets to be unique.
      targets = list(mapping.values())
      if len(set(targets)) != len(targets):
        return (f'Node {node_id!r} dimensionsMapping has duplicate targets',
                'MALFORMED_SUBMISSION')
    consumed = node.get(_DIMENSIONS_CONSUMED)
    if _DIMENSIONS_CONSUMED in node and (not isinstance(consumed, list) or any(
        not isinstance(dimension, str) or not dimension
        for dimension in consumed)):
      return (f'Node {node_id!r} has a malformed dimensionsConsumed (expected a '
              f'list of non-empty strings)', 'MALFORMED_SUBMISSION')

    params = node.get('parameters', {})
    if not isinstance(params, dict):
      return (f'Node {node_id!r} has non-object parameters', 'MALFORMED_SUBMISSION')

    limit, node_fan = _node_limit_violation(node_id, params)
    if limit is not None:
      return limit
    node_locals[node_id] = node_fan

    if action not in action_specs:
      continue  # only model-parameterized actions get the model/location checks

    model_param = _model_param_name(action, actions_json)
    model_value = params.get(model_param) if model_param else None
    model_list = model_value if isinstance(model_value, list) else [model_value]
    if not model_list or any(model is None or model == '' for model in model_list):
      return (f'Node {node_id!r}: {action} is missing its model ({model_param})',
              'MISSING_MODEL_PARAM')

    location_param = action_specs[action].get('location_param')
    locations = None
    if location_param is not None:
      location_value = params.get(location_param)
      locations = (location_value if isinstance(location_value, list)
                   else [location_value])
      if not locations or any(
          location is None or location == '' for location in locations):
        return (f'Node {node_id!r}: {action} is missing its location '
                f'({location_param})', 'MISSING_MODEL_PARAM')

    for model in model_list:
      if (not isinstance(model, str) or model not in models
          or action not in models[model].get('actions', [])):
        return (f'Node {node_id!r}: {action} model {model!r} is not allowed',
                'MODEL_NOT_ALLOWED')
      if location_param is not None:
        for location in locations:
          if not is_pair_allowed(action, model, location, allowlist):
            return (f'Node {node_id!r}: {action} model {model!r} is not allowed '
                    f'in {location!r}', 'MODEL_LOCATION_PAIR_INVALID')
      caps = models[model].get('capabilities') or {}
      violation = _capability_violation(
          node_id,
          action,
          model,
          caps,
          params,
          _action_params(action, actions_json),
      )
      if violation is not None:
        return violation

  # Pass 2: graph-aware fan-out -- bound total executions (queue) and billable
  # generations (cost) along the actual DAG.
  return _fan_out_budget(definition, input_group_sizes, node_locals, action_specs)


def _fan_out_budget(
    definition: dict,
    input_group_sizes: dict,
    node_locals: dict,
    action_specs: dict,
) -> tuple[str, str] | None:
  """Bounds total node executions and billable generations over the workflow DAG.

  The orchestrator runs a node ``len(input_groups) * len(expanded_parameters)``
  times, so fan-out flows along input edges. We track each node's fan-out as the
  product of its distinct lineage *sources* -- inputFiles groups plus each node's
  own list/quantity multiplier. Merging by source means a source reached by more
  than one path (shared lineage) is counted once, while independent sources
  multiply and sibling branches simply sum. This is a conservative upper bound on
  the engine's dimension-aligned grouping (it never under-counts)."""
  order = _topo_order(definition)
  if order is None:
    return ('workflowDefinition has a cycle or an edge to an unknown node',
            'MALFORMED_SUBMISSION')

  node_lineage = {}   # node_id -> {source_key: multiplier} (an action's outputs)
  out_lineage = {}    # (node_id, output_key) -> {...} (a pass forwards per output)
  generations = 0
  total = 0
  for node_id in order:
    node = definition[node_id]
    inputs = node.get(_INPUT) if isinstance(node.get(_INPUT), dict) else {}
    combined = {}
    for in_key, source in inputs.items():
      combined.update(_edge_lineage(in_key, source, out_lineage, node_lineage,
                                    input_group_sizes))
    local = node_locals.get(node_id, 1)
    if local > 1:
      combined['loc:' + node_id] = local

    node_fan = 1
    for multiplier in combined.values():
      node_fan *= multiplier
    total += node_fan
    if total > _MAX_TOTAL_FAN_OUT:
      return (f'workflow fan-out too large across all nodes '
              f'({total} > {_MAX_TOTAL_FAN_OUT})', 'TOTAL_FAN_OUT_TOO_LARGE')
    if action_specs.get(node.get('action'), {}).get('default_key') in _EXPENSIVE_DEFAULT_KEYS:
      generations += node_fan
      if generations > _MAX_GENERATIONS:
        return (f'workflow spawns too many billable generations '
                f'({generations} > {_MAX_GENERATIONS})', 'TOO_MANY_GENERATIONS')

    if node.get(_DIMENSIONS_MAPPING) or node.get(_DIMENSIONS_CONSUMED):
      # This node renames/projects dimensions (dimensionsMapping/dimensionsConsumed
      # are client-settable and applied in orchestrator.py). That can SPLIT a
      # shared source into independent dimension keys the engine then
      # cross-products (n -> n*n), so model the output as one fresh opaque source:
      # a downstream merge then multiplies it instead of deduping by origin.
      # Conservative -- it can over-count a rename that happens to realign, but
      # it never under-counts (the property the cost cap depends on).
      opaque = {'dim:' + node_id: node_fan}
      node_lineage[node_id] = opaque
      if node.get('action') == _PASS:
        for in_key in inputs:
          out_lineage[(node_id, in_key)] = dict(opaque)
    else:
      node_lineage[node_id] = combined
      # A pass forwards each input to the same-named output, so a consumer of one
      # output must not inherit the node's *other* inputs. Track per-output.
      if node.get('action') == _PASS:
        for in_key, source in inputs.items():
          lineage = dict(_edge_lineage(in_key, source, out_lineage, node_lineage,
                                       input_group_sizes))
          if local > 1:
            lineage['loc:' + node_id] = local
          out_lineage[(node_id, in_key)] = lineage
  return None


def _edge_lineage(
    in_key: str,
    source: Any,
    out_lineage: dict,
    node_lineage: dict,
    input_group_sizes: dict,
) -> dict:
  """The lineage an input edge carries: a predecessor output's lineage, or the
  inputFiles group named by a top-level input, else nothing (a constant)."""
  if isinstance(source, dict) and source.get(_NODE) is not None:
    pred_id = source.get(_NODE)
    output_key = source.get(_OUTPUT)
    lineage = out_lineage.get((pred_id, output_key))
    return lineage if lineage is not None else node_lineage.get(pred_id, {})
  if in_key in input_group_sizes:
    return {'in:' + in_key: input_group_sizes[in_key]}
  return {}


def _topo_order(definition: dict) -> list[str] | None:
  """Nodes ordered so every predecessor precedes its successors, or ``None`` on a
  cycle, a self-edge, or an edge to an unknown node (all malformed)."""
  preds = {}
  for node_id, node in definition.items():
    node_preds = set()
    inputs = node.get(_INPUT) if isinstance(node, dict) else None
    if isinstance(inputs, dict):
      for source in inputs.values():
        if isinstance(source, dict) and source.get(_NODE) is not None:
          pred_id = source.get(_NODE)
          if pred_id == node_id or pred_id not in definition:
            return None
          node_preds.add(pred_id)
    preds[node_id] = node_preds
  order, done = [], set()
  progress = True
  while progress and len(order) < len(definition):
    progress = False
    for node_id in definition:
      if node_id not in done and preds[node_id] <= done:
        order.append(node_id)
        done.add(node_id)
        progress = True
  return order if len(order) == len(definition) else None


def _node_limit_violation(
    node_id: str, params: dict
) -> tuple[tuple[str, str] | None, int]:
  """Per-node checks; returns ``((message, code) or None, node_fan_out)``.

  ``node_fan_out`` is this node's own output multiplier: the product of its
  list-parameter lengths times its quantity outputs (quantity *alternatives* are
  summed, not multiplied -- see below). The caller compounds it over the DAG to
  bound whole-workflow fan-out and billable-generation totals. List-shaped values
  are checked element-wise -- the engine expands them to scalars before
  execution, so the raw type alone can't be trusted (see ``_as_values``)."""
  # The server pins the GCP project; a node must not point elsewhere. The UI
  # sends an empty string (allowed). Anything else is rejected, including a
  # one-element list the engine would unwrap to a real project.
  if _GCP_PROJECT in params:
    for value in _as_values(params[_GCP_PROJECT]):
      if not (isinstance(value, str) and not value.strip()):
        return ((f'Node {node_id!r}: gcp_project may not be set on a node',
                 'GCP_PROJECT_NOT_ALLOWED'), 1)

  fan_out = 1
  for name, value in params.items():
    if name in _QUANTITY_PARAMS:
      continue  # an output multiplier, summed below -- not a plain dimension
    if isinstance(value, list):
      # An empty list expands to zero combinations (itertools.product), so the
      # node silently never runs. Reject it rather than accept a no-op workflow.
      if not value:
        return ((f'Node {node_id!r}: parameter {name!r} is an empty list',
                 'EMPTY_LIST_PARAM'), fan_out)
      if len(value) > _MAX_LIST_LEN:
        return ((f'Node {node_id!r}: parameter {name!r} list too long '
                 f'({len(value)} > {_MAX_LIST_LEN})', 'LIST_TOO_LONG'), fan_out)
      fan_out *= len(value)
  if fan_out > _MAX_FAN_OUT:
    return ((f'Node {node_id!r}: list-parameter fan-out too large '
             f'({fan_out} > {_MAX_FAN_OUT})', 'FAN_OUT_TOO_LARGE'), fan_out)

  # A quantity param is a dimension of *alternatives*, not a multiplier: [10, 10]
  # is two runs of 10 outputs = 20, not 10*10. Sum the values within a param;
  # multiply across independent quantity params. Each value must be a plain int
  # in 1..cap -- the executor does range()/min() on it, so a string, float,
  # nested list, bool, or <=0 would 500 or clamp silently (type AND shape, not
  # just magnitude, since the prior guard only capped ints).
  quantity = 1
  for name in _QUANTITY_PARAMS:
    if name not in params:
      continue
    values = _as_values(params[name])
    if isinstance(params[name], list):
      if not values:
        return ((f'Node {node_id!r}: parameter {name!r} is an empty list',
                 'EMPTY_LIST_PARAM'), fan_out)
      if len(values) > _MAX_LIST_LEN:
        return ((f'Node {node_id!r}: parameter {name!r} list too long '
                 f'({len(values)} > {_MAX_LIST_LEN})', 'LIST_TOO_LONG'), fan_out)
    total = 0
    for value in values:
      if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return ((f'Node {node_id!r}: {name} must be an integer in '
                 f'1..{_MAX_QUANTITY}', 'QUANTITY_INVALID'), fan_out)
      if value > _MAX_QUANTITY:
        return ((f'Node {node_id!r}: {name} too large '
                 f'({value} > {_MAX_QUANTITY})', 'QUANTITY_TOO_LARGE'), fan_out)
      total += value
    quantity *= total
  return None, fan_out * quantity
