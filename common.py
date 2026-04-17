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

"""Defines common types and global constants."""

import enum
import functools
import logging
import typing

Params = typing.Dict[str, typing.Any]
NodeInput = typing.List[typing.Dict[str, str]]
NodeOutput = typing.Dict[str, NodeInput]

_USER_AGENT_PREFIX = 'cloud-solutions/mas-scenemachine'
_GIT_VERSION_FILE = 'deployed_version.txt'


class TypeNames(enum.Enum):
  """Enumerates type names to compensate deficiencies in Python's typing."""

  PARAMS = 'Params'
  NODE_INPUT = 'NodeInput'
  NODE_OUTPUT = 'NodeOutput'


class Key(enum.Enum):
  """Enumerates JSON keys.

  These should be distinct as some of them are used as keys in the same object.
  """

  ACTION = 'action'
  ACTIONS = 'actions'
  ACTUAL_COUNTS = 'actualCounts'
  DIMENSIONS = 'dimensions'
  DIMENSIONS_CONSUMED = 'dimensionsConsumed'
  DIMENSIONS_MAPPING = 'dimensionsMapping'
  EXECUTION_ID = 'executionId'
  FILE = 'file'
  FORCE_EXECUTION = 'forceExecution'
  GCP_LOCATION = 'gcpLocation'
  GCP_PROJECT = 'gcpProject'
  GCS_BUCKET = 'gcsBucket'
  GROUP_ID = 'groupId'
  INPUT = 'input'
  INPUT_COUNT = 'inputCount'
  INPUT_FILES = 'inputFiles'
  INPUT_GROUPS = 'inputGroups'
  LAST_UPDATED = 'lastUpdated'
  MULTI = 'multi'
  NODE = 'node'
  NODE_ID = 'nodeId'
  OUTPUT = 'output'
  OUTPUT_FILES = 'outputFiles'
  PARAMETERS = 'parameters'
  SIBLING_ACTIONS = 'siblingActions'
  SIGN_URLS = 'signUrls'
  TASKS_CLASS = 'tasksClass'
  TASKS_QUEUE_PREFIX = 'tasksQueuePrefix'
  TARGET_COUNTS = 'targetCounts'
  URL = 'url'
  VARIANT_PARAMETER = 'variantParameter'
  WORKFLOW_DEF = 'workflowDefinition'
  WORKFLOW_ID = 'workflowId'
  WORKFLOW_PARAMS = 'workflowParams'


class Dimension(enum.Enum):
  """Enumerates names of dimensions used by actions.

  The values must match those specified in actions.json.
  """

  IMAGE_ID = 'image_id'
  IMAGE_VARIANT_ID = 'image_variant_id'
  IMAGE_INSTRUCTION = 'image_instruction'
  PRODUCT_ID = 'product_id'
  SCENE_ID = 'scene_id'
  STORY_VARIANT_ID = 'story_variant_id'
  THEME_TITLE = 'theme_title'
  VARIANT_NAME = 'variant_name'
  VIDEO_VARIANT_ID = 'video_variant_id'


class ContentType(enum.Enum):
  """Enumerates MIME types."""

  TEXT = 'text/plain'
  JPEG = 'image/jpeg'
  MP4 = 'video/mp4'
  PNG = 'image/png'
  JSON = 'application/json'
  VIDEO = 'video/*'


class TrackingType(enum.Enum):
  """Enumerates types of activities registered with GCP."""

  STORYBOARD = 'storyboard'
  VIDEO = 'video'


#  Maps short type names to suitable input and output MIME types.
content_type_short = {
    'string': {
        'output': ContentType.TEXT.value,
        'input': [ContentType.TEXT.value],
    },
    'video': {
        'output': ContentType.MP4.value,
        'input': [ContentType.VIDEO.value],
    },
}


@functools.lru_cache(maxsize=1)
def get_api_client_headers(context: TrackingType) -> dict[str, str]:
  """Gets headers for use with Google APIs.

  This currently covers only user-agent headers to identify the client in logs.

  Args:
    context: The string to denote what type of request is being made.

  Returns:
    A dictionary of headers.
  """

  user_agent = _USER_AGENT_PREFIX + '-' + str(context) + '-v'
  try:
    with open(_GIT_VERSION_FILE, 'r') as f:
      user_agent += f.read().strip()
  except FileNotFoundError:
    user_agent += 'unknown'

  return {
      'User-Agent': user_agent,
      'x-goog-api-client': user_agent,
  }


logger = logging.getLogger(__name__)
