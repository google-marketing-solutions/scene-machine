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

"""Generates and edits videos with Gemini Omni through the Interactions API."""

import time
import uuid
from typing import Literal

from common import get_api_client_headers
from common import TrackingType
from google import genai
from google.genai import types
from google.genai.interactions import Interaction


Resolution = Literal['360p', '720p', '1080p', '4k']

POLL_INTERVAL_SECONDS = 10
POLL_DEADLINE_SECONDS = 1500  # below the worker's 1800 s dispatch deadline
MIN_DURATION_SECONDS = 3
MAX_DURATION_SECONDS = 10
RESOLUTIONS = ('360p', '720p', '1080p', '4k')
ASPECT_RATIOS = ('16:9', '9:16')
PENDING_STATES = frozenset({'queued', 'in_progress'})
USE_BACKGROUND = True  # flip to False if the live probe shows Vertex refuses it
# Per-call timeouts, in seconds, passed as call arguments. Never put a
# timeout on the client's HttpOptions instead: that value is milliseconds
# and would give this client a 0.12 s timeout.
CREATE_TIMEOUT_SECONDS = 120
GET_TIMEOUT_SECONDS = 60


class OmniError(RuntimeError):
  """Raised for every Omni failure after a paid create, and for bad args.

  Carries no `code` or `status_code` attribute on purpose: `util.errors.
  is_retryable` then returns False, the task fails once, and the worker
  never buys a second clip.
  """


def _client(gcp_project: str, gcp_location: str) -> genai.Client:
  """Builds the Vertex client used for every Omni call. Tests patch this."""
  return genai.Client(
      vertexai=True,
      project=gcp_project,
      location=gcp_location,
      http_options=types.HttpOptions(
          headers=get_api_client_headers(TrackingType.VIDEO),
          retry_options=types.HttpRetryOptions(
              attempts=2, http_status_codes=[429]
          ),
      ),
  )


def _unique_prefix(output_gcs: str) -> str:
  """A fresh output folder so a rerun can never overwrite a live clip."""
  base = output_gcs[:-1] if output_gcs.endswith('/') else output_gcs
  return f'{base}/{uuid.uuid4().hex}/'


def _video_format(
    gcs_uri: str,
    aspect_ratio: str | None = None,
    resolution: str | None = None,
    duration_seconds: int | None = None,
) -> dict[str, str]:
  """Builds a video response_format dict, adding only the given fields."""
  response_format = {'type': 'video', 'delivery': 'uri', 'gcs_uri': gcs_uri}
  if aspect_ratio is not None:
    response_format['aspect_ratio'] = aspect_ratio
  if resolution is not None:
    response_format['resolution'] = resolution
  if duration_seconds is not None:
    response_format['duration'] = f'{duration_seconds}s'
  return response_format


def _is_transient(exc: Exception) -> bool:
  """Whether a polling failure is safe to retry.

  The interactions client does not raise `google.genai.errors.APIError`; its
  status-coded exceptions live in a private module and carry `status_code`
  (some transport failures carry neither). A throttle, a 5xx, or a dropped
  connection is transient; a 4xx is permanent.
  """
  status = getattr(exc, 'status_code', None)
  if status == 429 or (status is not None and status >= 500):
    return True
  return type(exc).__name__ in ('APITimeoutError', 'APIConnectionError')


def _create(
    client: genai.Client,
    model: str,
    input_parts: list[dict[str, str]],
    response_format: dict[str, str],
    task: str,
) -> Interaction:
  """Sends one interaction.

  Raises immediately if the response carries no interaction id: there would
  be nothing to poll, and the call may already have been billed.
  """
  interaction = client.interactions.create(
      model=model,
      input=input_parts,
      response_format=response_format,
      generation_config={'video_config': {'task': task}},
      background=USE_BACKGROUND,
      timeout=CREATE_TIMEOUT_SECONDS,
  )
  if not interaction.id:
    raise OmniError('create returned no interaction id')
  return interaction


def _wait(
    client: genai.Client, interaction: Interaction, deadline: float
) -> Interaction:
  """Polls one interaction until it leaves `PENDING_STATES`.

  A transient failure from `get` (see `_is_transient`) is logged and
  polling continues; any other failure, or running past `deadline`, becomes
  an `OmniError`. Never calls `create` again.
  """
  if not USE_BACKGROUND:
    return interaction
  while interaction.status in PENDING_STATES:
    if time.monotonic() > deadline:
      raise OmniError(
          f'Omni interaction {interaction.id} did not finish within '
          f'{POLL_DEADLINE_SECONDS}s'
      )
    time.sleep(POLL_INTERVAL_SECONDS)
    try:
      interaction = client.interactions.get(
          interaction.id, timeout=GET_TIMEOUT_SECONDS
      )
    except Exception as exc:  # pylint: disable=broad-except
      if _is_transient(exc):
        print((
            'Omni status: ',
            interaction.id,
            (
                f'transient poll error: {type(exc).__name__}'
                f' {getattr(exc, "status_code", "")}'
            ),
        ))
        continue
      raise OmniError(
          f'Omni polling failed for interaction {interaction.id}: {exc}'
      ) from exc
    print(('Omni status: ', interaction.id, interaction.status))
  return interaction


def _finish(interaction: Interaction, prefix: str) -> str:
  """Validates a polled interaction and returns its video URI.

  Success needs all three: status `completed`, an `output_video`, and a URI
  under this request's own prefix ending in `.mp4`. Anything else is an
  `OmniError` carrying the status, the id, and every error message.
  """
  output_video = interaction.output_video
  uri = output_video.uri if output_video is not None else None
  if (
      interaction.status == 'completed'
      and uri
      and uri.startswith(prefix)
      and uri.endswith('.mp4')
  ):
    return uri
  messages = '; '.join(
      error.message for error in interaction.errors or [] if error.message
  )
  detail = f': {messages}' if messages else ''
  raise OmniError(
      f'Omni interaction {interaction.id} ended with status '
      f'{interaction.status}{detail} (output uri: {uri!r}, expected '
      f'prefix {prefix})'
  )


def generate(
    gcp_project: str,
    gcp_location: str,
    prompt: str,
    image_url: str | None,
    image_type: str | None,
    model: str,
    duration_seconds: int = 8,
    amount: int = 1,
    aspect_ratio: str = '16:9',
    resolution: Resolution = '720p',
    output_gcs: str = 'gs://',
) -> list[str]:
  """Generates videos using Gemini Omni.

  Every candidate is submitted before any of them is polled: `amount` can
  be up to four, and a later create's failure must never look like the
  first create's failure. Once at least one candidate has been accepted,
  the clips it bought are real; a later create that fails is terminal,
  never retried, so nothing already paid for is generated twice.

  `amount` is Scene Machine's own batch size, not an Omni parameter: Omni
  returns one clip per call, so each candidate up to `amount` is a
  separate Omni API call.
  """
  if resolution not in RESOLUTIONS:
    raise OmniError(f'Unsupported Omni resolution: {resolution!r}')
  if aspect_ratio not in ASPECT_RATIOS:
    raise OmniError(f'Unsupported Omni aspect ratio: {aspect_ratio!r}')
  if (
      isinstance(duration_seconds, bool)
      or not isinstance(duration_seconds, int)
      or not MIN_DURATION_SECONDS <= duration_seconds <= MAX_DURATION_SECONDS
  ):
    raise OmniError(
        'Omni duration_seconds must be a whole number of seconds in '
        f'{MIN_DURATION_SECONDS}..{MAX_DURATION_SECONDS}, got '
        f'{duration_seconds!r}'
    )
  if (
      isinstance(amount, bool)
      or not isinstance(amount, int)
      or not 1 <= amount <= 4
  ):
    raise OmniError(f'Omni amount must be 1..4, got {amount!r}')
  if image_url:
    task = 'image_to_video'
    input_parts = [
        {'type': 'text', 'text': prompt},
        {'type': 'image', 'uri': image_url, 'mime_type': image_type},
    ]
  else:
    task = 'text_to_video'
    input_parts = [{'type': 'text', 'text': prompt}]
  client = _client(gcp_project, gcp_location)
  deadline = time.monotonic() + POLL_DEADLINE_SECONDS
  pending: list[tuple[Interaction, str]] = []
  for i in range(amount):
    prefix = _unique_prefix(output_gcs)
    response_format = _video_format(
        prefix,
        aspect_ratio=aspect_ratio,
        resolution=resolution,
        duration_seconds=duration_seconds,
    )
    try:
      interaction = _create(client, model, input_parts, response_format, task)
    except Exception as exc:  # pylint: disable=broad-except
      if not pending:
        raise
      raise OmniError(
          f'create {i + 1} of {amount} failed after {len(pending)} accepted: '
          f'{exc}'
      ) from exc
    pending.append((interaction, prefix))
  return [
      _finish(_wait(client, interaction, deadline), prefix)
      for interaction, prefix in pending
  ]


def edit(
    gcp_project: str,
    gcp_location: str,
    prompt: str,
    video_uri: str,
    video_mime: str,
    model: str,
    output_gcs: str,
    resolution: Resolution | None = None,
) -> str:
  """Edits an existing video using Gemini Omni."""
  if resolution is not None and resolution not in RESOLUTIONS:
    raise OmniError(f'Unsupported Omni resolution: {resolution!r}')
  client = _client(gcp_project, gcp_location)
  input_parts = [
      {'type': 'text', 'text': prompt},
      {'type': 'video', 'uri': video_uri, 'mime_type': video_mime},
  ]
  prefix = _unique_prefix(output_gcs)
  response_format = _video_format(prefix, resolution=resolution)
  deadline = time.monotonic() + POLL_DEADLINE_SECONDS
  interaction = _create(client, model, input_parts, response_format, 'edit')
  interaction = _wait(client, interaction, deadline)
  return _finish(interaction, prefix)
