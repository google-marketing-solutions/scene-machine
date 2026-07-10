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

"""Unit tests for util.submission_validation.validate_submission.

Tests assert on the stable error CODE, never the message.
"""

import glob
import json
import os

from util.submission_validation import validate_submission

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _code(data):
  result = validate_submission(data)
  return result[1] if result is not None else None


def _sub(action='generate_video', params=None, **top):
  data = {'workflowDefinition': {'n': {'action': action, 'parameters': params or {}}}}
  data.update(top)
  return data


# --- the acceptance invariant: every shipped example must pass ---------------

def test_all_workflow_examples_pass():
  for path in glob.glob(os.path.join(_REPO, 'workflow_examples', '*.json')):
    with open(path, encoding='utf-8') as f:
      doc = json.load(f)
    assert validate_submission(doc) is None, f'{os.path.basename(path)} was rejected'


# --- each rejection code -----------------------------------------------------

def test_rogue_model():
  assert _code(_sub('generate_video',
                    {'model': 'rogue', 'gcp_location': 'global'})) == 'MODEL_NOT_ALLOWED'


def test_valid_model_disallowed_location():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_gemini_action_disallowed_location():
  # gemini-3.5-flash is allowed at global only; a Gemini-text action elsewhere
  # must reject. Guards the gemini_model_location gate (not just Veo's).
  assert _code(_sub('translate',
                    {'gemini_model': 'gemini-3.5-flash',
                     'gemini_model_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_image_action_disallowed_location():
  # Same for the image_model_location gate.
  assert _code(_sub('generate_image',
                    {'image_model': 'gemini-3-pro-image',
                     'image_model_location': 'europe-west4'})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_execution_id_rejected():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': 'global'},
                    executionId='exec-123')) == 'EXECUTION_ID_NOT_ALLOWED'


def test_missing_model_param():
  assert _code(_sub('generate_video', {'gcp_location': 'global'})) == 'MISSING_MODEL_PARAM'


def test_missing_location_param():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001'})) == 'MISSING_MODEL_PARAM'


def test_empty_location_rejected():
  # Empty string would silently fall back to the infra region in the action.
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': ''})
              ) == 'MISSING_MODEL_PARAM'


def test_unknown_action_is_ignored():
  # This check only covers actions that take a model. An unknown action name is
  # the orchestrator's to reject.
  assert validate_submission(_sub('definitely_not_an_action', {})) is None


def test_list_model_with_one_bad_element():
  assert _code(_sub('generate_video',
                    {'model': ['veo-3.1-generate-001', 'rogue'], 'gcp_location': 'global'})
              ) == 'MODEL_NOT_ALLOWED'


def test_non_model_action_is_ignored():
  # A real but non-model-parameterized action (e.g. concat) is not validated.
  assert validate_submission(_sub('concat', {})) is None


def test_valid_generate_video_passes():
  assert validate_submission(
      _sub('generate_video',
           {'model': 'veo-3.1-fast-generate-001', 'gcp_location': 'us-central1'})) is None


# --- executionId: reject on presence, any value ------------------------------

def test_execution_id_falsy_still_rejected():
  # The orchestrator branches on the key being present, so a falsy value skips
  # the store step just like a real one. Every value must be rejected.
  valid = {'model': 'veo-3.1-generate-001', 'gcp_location': 'global'}
  for bad in ('', 0, False, None):
    data = _sub('generate_video', valid)
    data['executionId'] = bad
    assert _code(data) == 'EXECUTION_ID_NOT_ALLOWED', f'executionId={bad!r} slipped through'


# --- empty-list values must not fail open ------------------------------------

def test_empty_list_model_rejected():
  # An empty list expands to zero combinations, so the empty-list guard catches
  # it up front (fail closed) before the missing-model check is reached.
  assert _code(_sub('generate_video',
                    {'model': [], 'gcp_location': 'global'})) == 'EMPTY_LIST_PARAM'


def test_empty_list_location_rejected():
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001', 'gcp_location': []})
              ) == 'EMPTY_LIST_PARAM'


def test_list_location_with_one_bad_element():
  # Exercises the location cross-product loop: a good + a disallowed location.
  assert _code(_sub('generate_video',
                    {'model': 'veo-3.1-generate-001',
                     'gcp_location': ['global', 'europe-west4']})
              ) == 'MODEL_LOCATION_PAIR_INVALID'


def test_list_model_with_non_string_element():
  assert _code(_sub('generate_video',
                    {'model': ['veo-3.1-generate-001', 123], 'gcp_location': 'global'})
              ) == 'MODEL_NOT_ALLOWED'


# --- malformed shapes fail closed, not with a 500 ----------------------------

def test_non_dict_submission_rejected():
  assert validate_submission(['not', 'a', 'dict'])[1] == 'MALFORMED_SUBMISSION'


def test_non_dict_workflow_definition_rejected():
  assert validate_submission({'workflowDefinition': 'nope'})[1] == 'MALFORMED_SUBMISSION'


def test_non_dict_node_rejected():
  assert validate_submission(
      {'workflowDefinition': {'n': 'nope'}})[1] == 'MALFORMED_SUBMISSION'


def test_non_string_action_rejected():
  # An unhashable action (list/dict) used to crash the membership check.
  assert _code(_sub(['generate_video'], {})) == 'MALFORMED_SUBMISSION'


def test_non_dict_parameters_rejected():
  assert _code(_sub('generate_video', 'not-a-dict')) == 'MALFORMED_SUBMISSION'


# --- enqueue fan-out / quantity / project-pin limits (generous caps) ---------

_VALID_VIDEO = {'model': 'veo-3.1-generate-001', 'gcp_location': 'global'}
_VALID_IMAGE = {'image_model': 'gemini-3-pro-image', 'image_model_location': 'global'}


def test_node_gcp_project_rejected():
  # The server pins the project; a node must not point at another.
  assert _code(_sub('generate_video', {**_VALID_VIDEO, 'gcp_project': 'other'})
              ) == 'GCP_PROJECT_NOT_ALLOWED'


def test_node_empty_gcp_project_ok():
  # The UI always sends gcp_project='' -- that is allowed.
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'gcp_project': ''})) is None


def test_quantity_too_large():
  assert _code(_sub('generate_video',
                    {**_VALID_VIDEO, 'video_variant_quantity': 101})
              ) == 'QUANTITY_TOO_LARGE'


def test_quantity_within_cap_ok():
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'video_variant_quantity': 4})) is None


def test_list_parameter_too_long():
  assert _code(_sub('translate',
                    {'gemini_model': 'gemini-3.5-flash',
                     'gemini_model_location': 'global',
                     'target_language': ['x'] * 101})) == 'LIST_TOO_LONG'


def test_fan_out_product_too_large():
  # 40 models x 40 locations = 1600 > the fan-out cap (each list is under the
  # per-list cap, so it is the product that trips).
  assert _code(_sub('generate_video',
                    {'model': ['veo-3.1-generate-001'] * 40,
                     'gcp_location': ['global'] * 40})) == 'FAN_OUT_TOO_LARGE'


def test_too_many_nodes():
  nodes = {f'n{i}': {'action': 'pass', 'parameters': {}} for i in range(201)}
  assert validate_submission({'workflowDefinition': nodes})[1] == 'TOO_MANY_NODES'


def test_too_many_input_files():
  data = _sub('generate_video', _VALID_VIDEO)
  data['inputFiles'] = {'images': [{'file': str(i)} for i in range(201)]}
  assert validate_submission(data)[1] == 'TOO_MANY_INPUT_FILES'


# Engine expands list params before execution; validate expanded values too.

def test_node_gcp_project_list_bypass_rejected():
  assert _code(_sub('generate_video', {**_VALID_VIDEO, 'gcp_project': ['other']})
              ) == 'GCP_PROJECT_NOT_ALLOWED'


def test_node_gcp_project_non_string_rejected():
  # A number or object is not a valid empty project either; reject both.
  for bad in (123, {'p': 'other'}, ['a', 'b']):
    assert _code(_sub('generate_video', {**_VALID_VIDEO, 'gcp_project': bad})
                ) == 'GCP_PROJECT_NOT_ALLOWED', f'gcp_project={bad!r} slipped through'


def test_node_empty_gcp_project_list_ok():
  # A list of blank strings still resolves to no project, so it stays allowed --
  # the fix must not over-reject the UI's empty value in list form.
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'gcp_project': ['']})) is None


def test_quantity_list_shape_bypass_rejected():
  for name in ('video_variant_quantity', 'variant_quantity', 'story_variant_quantity'):
    assert _code(_sub('generate_video', {**_VALID_VIDEO, name: [101]})
                ) == 'QUANTITY_TOO_LARGE', f'{name}=[101] slipped through'


def test_quantity_list_within_cap_ok():
  # A list of in-range quantities is legitimate fan-out and must pass.
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'video_variant_quantity': [4, 10]})) is None


def test_input_files_not_object_rejected():
  # A non-object inputFiles would crash verify_input downstream; fail closed.
  data = _sub('generate_video', _VALID_VIDEO)
  data['inputFiles'] = [{'file': '1'}, {'file': '2'}]
  assert validate_submission(data)[1] == 'MALFORMED_SUBMISSION'


def _pipeline(n, image_nodes=(), video_nodes=(('v', 'root', 'image'),), groups=None):
  """Builds a wired workflow: `root` forwards inputFiles, then the named image /
  video nodes each draw from a predecessor's output."""
  nodes = {'root': {'action': 'pass', 'input': dict.fromkeys(groups or ['image'])}}
  for nid, pred, out in image_nodes:
    nodes[nid] = {'action': 'outpaint_image', 'parameters': dict(_VALID_IMAGE),
                  'input': {'image': {'node': pred, 'output': out}}}
  for nid, pred, out in video_nodes:
    nodes[nid] = {'action': 'generate_video', 'parameters': dict(_VALID_VIDEO),
                  'input': {'image': {'node': pred, 'output': out}}}
  return {'inputFiles': {g: [{'file': str(i)} for i in range(n)]
                         for g in (groups or ['image'])},
          'workflowDefinition': nodes}


def test_billable_generations_over_cap_rejected():
  # 100 images x a 3-model list on one video node = 300 generations > 200.
  wf = _pipeline(100, video_nodes=())
  wf['workflowDefinition']['v'] = {
      'action': 'generate_video',
      'input': {'image': {'node': 'root', 'output': 'image'}},
      'parameters': {'model': ['veo-3.1-generate-001'] * 3, 'gcp_location': 'global'}}
  assert validate_submission(wf)[1] == 'TOO_MANY_GENERATIONS'


def test_billable_generations_within_budget_ok():
  # 50 images -> outpaint + video = 100 generations, under the cap.
  wf = _pipeline(50, image_nodes=(('o', 'root', 'image'),),
                 video_nodes=(('v', 'o', 'outpainted_image'),))
  assert validate_submission(wf) is None


def test_sibling_billable_nodes_sum_not_multiply():
  # Independent sibling branches SUM, not multiply: 3 video siblings over 60
  # images = 180 (not 60**3); a 4th would make 240 > 200.
  assert validate_submission(_pipeline(
      60, video_nodes=[(f'v{i}', 'root', 'image') for i in range(3)])) is None
  assert _code(_pipeline(
      60, video_nodes=[(f'v{i}', 'root', 'image') for i in range(4)])
             ) == 'TOO_MANY_GENERATIONS'


def test_shared_lineage_counted_once():
  # A node drawing two inputs that trace to the same source counts it once, not
  # squared. prompt(1) + image(N) both via root: outpaint(N) + video(N) = 2N, so
  # N=100 -> 200 (ok), N=101 -> 202 (over). Squaring would blow up far sooner.
  def wf(n):
    return {'inputFiles': {'prompt': [{'file': 'p'}],
                           'image': [{'file': str(i)} for i in range(n)]},
            'workflowDefinition': {
                'root': {'action': 'pass', 'input': {'prompt': None, 'image': None}},
                'o': {'action': 'outpaint_image', 'parameters': dict(_VALID_IMAGE),
                      'input': {'image': {'node': 'root', 'output': 'image'}}},
                'v': {'action': 'generate_video', 'parameters': dict(_VALID_VIDEO),
                      'input': {'prompt': {'node': 'root', 'output': 'prompt'},
                                'image': {'node': 'o', 'output': 'outpainted_image'}}}}}
  assert validate_submission(wf(100)) is None
  assert validate_submission(wf(101))[1] == 'TOO_MANY_GENERATIONS'


# --- review round: non-int quantity, empty lists, malformed inputFiles --------

def test_non_int_quantity_rejected():
  # The prior guard only capped ints, so a non-int quantity slipped through and
  # then range()/min() misbehaved in the worker. Reject type and shape, not just
  # magnitude.
  for name in ('video_variant_quantity', 'variant_quantity', 'story_variant_quantity'):
    for bad in ('1000', 1.5, [[101]], ['1'], True, -1, 0):
      assert _code(_sub('generate_video', {**_VALID_VIDEO, name: bad})
                  ) == 'QUANTITY_INVALID', f'{name}={bad!r} slipped through'


def test_empty_list_param_no_ops_rejected():
  # aspect_ratio=[] expands to zero combinations, so the node silently never
  # runs; reject rather than accept a workflow that looks queued but does nothing.
  assert _code(_sub('generate_video', {**_VALID_VIDEO, 'aspect_ratio': []})
              ) == 'EMPTY_LIST_PARAM'


def test_malformed_input_files_values_rejected():
  # Entries must be dicts with a real file path; a dict without a non-empty
  # 'file' passes shape but crashes the action (a 500, not a 400).
  base = _sub('generate_video', _VALID_VIDEO)
  for bad in ('not-list', [1], [{'file': 'ok'}, 'bad'],
              [{}], [{'file': ''}], [{'file': '  '}], [{'file': 123}]):
    data = dict(base)
    data['inputFiles'] = {'images': bad}
    assert validate_submission(data)[1] == 'MALFORMED_SUBMISSION', f'{bad!r} passed'


def test_quantity_list_summed_not_multiplied():
  # A quantity list is alternatives, not a product: [100, 100] = two runs of 100
  # = 200 outputs (at the cap), not 100*100=10000. [10,10,10] = 30. But the sum
  # over the cap ([100,100,100] = 300) still trips the generation cap.
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'video_variant_quantity': [100, 100]})) is None
  assert validate_submission(
      _sub('generate_video', {**_VALID_VIDEO, 'video_variant_quantity': [10, 10, 10]})) is None
  assert _code(_sub('generate_video',
                    {**_VALID_VIDEO, 'video_variant_quantity': [100, 100, 100]})
              ) == 'TOO_MANY_GENERATIONS'


def test_cheap_text_generations_not_counted():
  # Gemini text is not billable: fanning a text action well past the generation
  # cap still passes -- only image/Veo/Omni families count toward the cost cap.
  data = {'inputFiles': {'images': [{'file': str(i)} for i in range(150)]},
          'workflowDefinition': {
              't': {'action': 'translate',
                    'parameters': {'gemini_model': 'gemini-3.5-flash',
                                   'gemini_model_location': 'global'}}}}
  assert validate_submission(data) is None


def test_billable_generations_boundary():
  # The user's serial pipeline: N images -> outpaint -> video = 2N generations.
  # 100 -> 200 (at cap); 101 -> 202 (over).
  def wf(n):
    return _pipeline(n, image_nodes=(('o', 'root', 'image'),),
                     video_nodes=(('v', 'o', 'outpainted_image'),))
  assert validate_submission(wf(100)) is None
  assert validate_submission(wf(101))[1] == 'TOO_MANY_GENERATIONS'


def test_queue_safety_fan_out_rejected():
  # Non-billable pass nodes chained via edges compound their list fan-out
  # (100 -> 10,000 -> 1,000,000 executions) past the queue cap, though nothing is
  # billable. (Independent, unchained nodes would only sum -- this must chain.)
  nodes = {'root': {'action': 'pass', 'input': {'image': None}}}
  prev = 'root'
  for i in range(3):
    nodes[f'p{i}'] = {'action': 'pass', 'parameters': {'x': list(range(100))},
                      'input': {'image': {'node': prev, 'output': 'image'}}}
    prev = f'p{i}'
  wf = {'inputFiles': {'image': [{'file': '0'}]}, 'workflowDefinition': nodes}
  assert validate_submission(wf)[1] == 'TOTAL_FAN_OUT_TOO_LARGE'


# --- review round 3: client dimension controls must not under-count -----------

def test_dimensions_mapping_under_count_rejected():
  # A dimensionsMapping rename can split a shared source into independent
  # dimensions the engine cross-products (n -> n*n). A dim-altering node's output
  # is treated as an opaque source, so the merge at z multiplies (100*100 > 200)
  # instead of deduping by origin (which under-counted to 100).
  wf = {'inputFiles': {'src': [{'file': str(i), 'd': str(i)} for i in range(100)]},
        'workflowDefinition': {
            'root': {'action': 'pass', 'input': {'src': None}},
            'x': {'action': 'translate', 'dimensionsMapping': {'d': 'd2'},
                  'input': {'src': {'node': 'root', 'output': 'src'}},
                  'parameters': {'gemini_model': 'gemini-3.5-flash',
                                 'gemini_model_location': 'global'}},
            'y': {'action': 'pass', 'input': {'src': {'node': 'root', 'output': 'src'}}},
            'z': {'action': 'generate_image', 'parameters': dict(_VALID_IMAGE),
                  'input': {'a': {'node': 'x', 'output': 'src'},
                            'b': {'node': 'y', 'output': 'src'}}}}}
  assert validate_submission(wf)[1] == 'TOO_MANY_GENERATIONS'


def test_dimensions_consumed_under_count_rejected():
  # dimensionsConsumed splits a source into independent dimensions too, no rename
  # needed: p projects out dim2, q projects out dim1, so they cross-product at c.
  def branch(drop):
    return {'action': 'translate', 'dimensionsConsumed': [drop],
            'input': {'src': {'node': 'root', 'output': 'src'}},
            'parameters': {'gemini_model': 'gemini-3.5-flash',
                           'gemini_model_location': 'global'}}
  wf = {'inputFiles': {'src': [{'file': str(i), 'dim1': str(i), 'dim2': str(i)}
                               for i in range(100)]},
        'workflowDefinition': {
            'root': {'action': 'pass', 'input': {'src': None}},
            'p': branch('dim2'), 'q': branch('dim1'),
            'c': {'action': 'generate_image', 'parameters': dict(_VALID_IMAGE),
                  'input': {'a': {'node': 'p', 'output': 'src'},
                            'b': {'node': 'q', 'output': 'src'}}}}}
  assert validate_submission(wf)[1] == 'TOO_MANY_GENERATIONS'


def test_malformed_input_edge_rejected():
  # A predecessor edge must be {node: str, output: str}: a non-string node throws
  # when hashed in the graph walk, a missing/empty output crashes the mapper.
  for edge in ({'node': [], 'output': 'i'}, {'node': 'r', 'output': []},
               {'node': 'r'}, {'node': '', 'output': 'i'}, {'node': 'r', 'output': ''}):
    wf = {'workflowDefinition': {'a': {'action': 'pass', 'input': {'x': edge}},
                                 'r': {'action': 'pass'}}}
    assert validate_submission(wf)[1] == 'MALFORMED_SUBMISSION', f'{edge!r} passed'


def test_malformed_dimensions_mapping_rejected():
  # A non-dict throws when the worker inverts the mapping; an unhashable/non-string
  # value or a duplicate target corrupts the rename. All must fail closed here.
  for mapping in ('evil', ['d'], {'d': ['x']}, {'d': 1}, {'': 'd2'}, {'d': ''},
                  {'a': 'x', 'b': 'x'}):
    wf = {'workflowDefinition': {'n': {'action': 'pass', 'dimensionsMapping': mapping}}}
    assert validate_submission(wf)[1] == 'MALFORMED_SUBMISSION', f'{mapping!r} passed'


def test_malformed_dimensions_consumed_rejected():
  # A non-list throws when the worker does `key in dimensionsConsumed`; a non-string
  # element never matches and silently fails to project. Reject both shapes.
  for consumed in (123, True, 'x', {'d': 1}, [1], [''], ['ok', 2]):
    wf = {'workflowDefinition': {'n': {'action': 'pass', 'dimensionsConsumed': consumed}}}
    assert validate_submission(wf)[1] == 'MALFORMED_SUBMISSION', f'{consumed!r} passed'


def test_wellformed_dimension_controls_accepted():
  # The shape check must not reject a legitimate rename/projection.
  wf = {'inputFiles': {'src': [{'file': '1', 'd': 'x'}]},
        'workflowDefinition': {
            'root': {'action': 'pass', 'input': {'src': None}},
            'x': {'action': 'pass', 'dimensionsMapping': {'d': 'd2'},
                  'dimensionsConsumed': ['other'],
                  'input': {'src': {'node': 'root', 'output': 'src'}}}}}
  assert validate_submission(wf) is None
