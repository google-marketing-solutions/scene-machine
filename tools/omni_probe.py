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

"""Live probe for the Gemini Omni 1.1 Flash Interactions API.

Not a test: every step spends real quota, and steps 3 to 5 render actual
video. Run with `python -m tools.omni_probe --project P --bucket B`, or add
`--step N` (1 to 5) to run one step alone. Steps run in order and stop at the
first failure, printing the HTTP status and response body. Credentials are
never printed.
"""

import argparse
import datetime
import json
import time
import uuid

from google import genai
from google.cloud import storage
from google.genai import types


MODEL = 'gemini-omni-1.1-flash-preview'
LOCATION = 'global'
POLL_INTERVAL_SECONDS = 10
POLL_DEADLINE_SECONDS = 480
PENDING_STATES = frozenset({'queued', 'in_progress'})
STEPS = (1, 2, 3, 4, 5)
# Per-call timeouts, in seconds, matching omni.CREATE_TIMEOUT_SECONDS and
# omni.GET_TIMEOUT_SECONDS.
CREATE_TIMEOUT_SECONDS = 120
GET_TIMEOUT_SECONDS = 60


def _client(project: str) -> genai.Client:
  """Builds a client on ADC with the user-project header and retry policy."""
  return genai.Client(
      vertexai=True,
      project=project,
      location=LOCATION,
      http_options=types.HttpOptions(
          headers={'x-goog-user-project': project},
          retry_options=types.HttpRetryOptions(
              attempts=2, http_status_codes=[429]
          ),
      ),
  )


def _output_prefix(bucket: str) -> str:
  """A fresh gs://bucket/_omni-probe/<date>/<uuid>/ folder for one call."""
  date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')
  return f'gs://{bucket}/_omni-probe/{date}/{uuid.uuid4().hex}/'


def _print_request(body: dict) -> None:
  print('Request body:')
  print(json.dumps(body, indent=2, default=str))


def _fail(status: int | str, body) -> None:
  print(f'FAILED: HTTP {status}')
  print(json.dumps(body, indent=2, default=str) if body else '(no body)')
  raise SystemExit(1)


def _fail_on_error(exc: Exception) -> None:
  print(f'{type(exc).__name__}: {exc}')
  _fail(getattr(exc, 'status_code', None), getattr(exc, 'body', None))


def _send(client: genai.Client, body: dict, **kwargs):
  """Prints the request, sends it, and fails loudly on an API error."""
  _print_request(body)
  kwargs.setdefault('timeout', CREATE_TIMEOUT_SECONDS)
  try:
    return client.interactions.create(**body, **kwargs)
  except Exception as exc:  # pylint: disable=broad-except
    _fail_on_error(exc)


def _first_uri(interaction) -> str | None:
  output_video = getattr(interaction, 'output_video', None)
  if output_video is not None and getattr(output_video, 'uri', None):
    return output_video.uri
  for step in getattr(interaction, 'steps', None) or []:
    for content in getattr(step, 'content', None) or []:
      if getattr(content, 'type', None) == 'video' and getattr(
          content, 'uri', None
      ):
        return content.uri
  return None


def _report(interaction) -> None:
  print(f'status={interaction.status} id={interaction.id}')
  print(f'usage={getattr(interaction, "usage", None)}')
  uri = _first_uri(interaction)
  if uri:
    print(f'uri={uri}')


def _poll(client: genai.Client, interaction):
  """Polls every 10 s for at most 480 s, printing one line per poll."""
  deadline = time.monotonic() + POLL_DEADLINE_SECONDS
  while interaction.status in PENDING_STATES:
    if time.monotonic() > deadline:
      _fail(
          'deadline',
          f'poll deadline exceeded for interaction {interaction.id}',
      )
    time.sleep(POLL_INTERVAL_SECONDS)
    try:
      interaction = client.interactions.get(
          interaction.id, timeout=GET_TIMEOUT_SECONDS
      )
    except Exception as exc:  # pylint: disable=broad-except
      _fail_on_error(exc)
    print(('Omni status: ', interaction.id, interaction.status))
  return interaction


def _list_folder(prefix: str) -> None:
  bucket_name, _, path = prefix.removeprefix('gs://').partition('/')
  blobs = storage.Client().list_blobs(bucket_name, prefix=path)
  print(f'Folder listing for {prefix}:')
  for blob in blobs:
    print(f'  {blob.name} ({blob.size} bytes)')


def step1(client: genai.Client) -> None:
  """Text only. Proves identity, quota and the model id."""
  body = {'model': MODEL, 'input': 'Reply with exactly READY.'}
  interaction = _send(client, body)
  _report(interaction)


def step2(client: genai.Client) -> None:
  """Text plus background=True, polled to completion."""
  body = {
      'model': MODEL,
      'input': 'Reply with exactly READY.',
      'background': True,
  }
  interaction = _send(client, body)
  _report(interaction)
  interaction = _poll(client, interaction)
  _report(interaction)


def step3(client: genai.Client, bucket: str) -> tuple[str | None, bool]:
  """text_to_video, 3 s, 720p, 16:9, delivery uri. Returns (uri, background).

  Tries the background form first. If Vertex answers 400 mentioning
  "background", falls back to a synchronous create (background omitted,
  timeout raised) and says which form worked.
  """
  prefix = _output_prefix(bucket)
  response_format = {
      'type': 'video',
      'delivery': 'uri',
      'gcs_uri': prefix,
      'aspect_ratio': '16:9',
      'resolution': '720p',
      'duration': '3s',
  }
  generation_config = {'video_config': {'task': 'text_to_video'}}
  body = {
      'model': MODEL,
      'input': 'A calm lake at sunrise.',
      'response_format': response_format,
      'generation_config': generation_config,
      'background': True,
  }
  _print_request(body)
  background = True
  try:
    interaction = client.interactions.create(
        **body, timeout=CREATE_TIMEOUT_SECONDS
    )
  except Exception as exc:  # pylint: disable=broad-except
    status = getattr(exc, 'status_code', None)
    body_text = json.dumps(getattr(exc, 'body', None), default=str).lower()
    if status == 400 and 'background' in body_text:
      print(
          'background create answered 400 mentioning "background"; '
          'retrying synchronously'
      )
      sync_body = {k: v for k, v in body.items() if k != 'background'}
      _print_request(sync_body)
      try:
        interaction = client.interactions.create(
            **sync_body, timeout=POLL_DEADLINE_SECONDS
        )
      except Exception as exc2:  # pylint: disable=broad-except
        _fail_on_error(exc2)
      background = False
    else:
      _fail_on_error(exc)
  print(f'form that worked: {"background" if background else "synchronous"}')
  _report(interaction)
  if background:
    interaction = _poll(client, interaction)
    _report(interaction)
  uri = _first_uri(interaction)
  if uri:
    _list_folder(prefix)
  return uri, background


def _edit(
    client: genai.Client,
    bucket: str,
    video_uri: str,
    background: bool,
    resolution: str | None,
) -> str | None:
  prefix = _output_prefix(bucket)
  response_format = {'type': 'video', 'delivery': 'uri', 'gcs_uri': prefix}
  if resolution:
    response_format['resolution'] = resolution
  body = {
      'model': MODEL,
      'input': [
          {'type': 'text', 'text': 'Make the sky purple.'},
          {'type': 'video', 'uri': video_uri, 'mime_type': 'video/mp4'},
      ],
      'response_format': response_format,
      'generation_config': {'video_config': {'task': 'edit'}},
  }
  if background:
    body['background'] = True
  interaction = _send(client, body)
  _report(interaction)
  if background:
    interaction = _poll(client, interaction)
    _report(interaction)
  return _first_uri(interaction)


def step4(
    client: genai.Client, bucket: str, video_uri: str, background: bool
) -> str | None:
  """Edit of --video (default: step 3 clip). No aspect ratio, no duration."""
  return _edit(client, bucket, video_uri, background, resolution=None)


def step5(
    client: genai.Client, bucket: str, video_uri: str, background: bool
) -> str | None:
  """Same edit as step 4, with resolution='720p' added."""
  return _edit(client, bucket, video_uri, background, resolution='720p')


def _parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
      description='Live probe for the Gemini Omni Interactions API.'
  )
  parser.add_argument('--project', required=True)
  parser.add_argument('--bucket', required=True)
  parser.add_argument('--step', type=int, choices=STEPS)
  parser.add_argument(
      '--video',
      help=(
          'gs:// source video for steps 4 and 5. Defaults to the step 3'
          ' output when step 3 ran earlier in the same invocation.'
      ),
  )
  return parser.parse_args()


def main() -> None:
  args = _parse_args()
  client = _client(args.project)
  steps = STEPS if args.step is None else (args.step,)
  step3_uri = None
  background = True
  for step in steps:
    print(f'--- step {step} ---')
    if step == 1:
      step1(client)
    elif step == 2:
      step2(client)
    elif step == 3:
      step3_uri, background = step3(client, args.bucket)
    elif step in (4, 5):
      video_uri = args.video or step3_uri
      if not video_uri:
        _fail(
            'usage',
            f'step {step} needs --video (no step 3 output in this run)',
        )
      if step == 4:
        step4(client, args.bucket, video_uri, background)
      else:
        step5(client, args.bucket, video_uri, background)


if __name__ == '__main__':
  main()
