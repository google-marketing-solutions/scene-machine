#!/usr/bin/env python3
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
"""Media generation adapters for Scene Machine (Vertex AI through google-genai).

Every ``google.genai`` / ``google.auth`` import in this module is lazy (inside
a function) so that importing the module, ``--help``, ``--dry-run`` and
``--list-models`` never load an SDK.

Adapters are keyed by the ``api`` discriminator of ``model_registry.json``:

  generate_images          legacy Imagen (client.models.generate_images)
  generate_content_image   Gemini image models (generate_content + ImageConfig)
  generate_videos          Veo (generate_videos + operations.get polling)
  generate_content_audio   Gemini TTS (generate_content + SpeechConfig)
  predict_rest             Lyria (REST :predict with an ADC bearer token)

Error text never contains request headers or tokens.
"""

import base64
import inspect
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path
from typing import Any, Callable, Optional

RETRYABLE_CODES = frozenset({429, 500, 502, 503, 504})
RETRYABLE_TOKENS = ("RESOURCE_EXHAUSTED", "UNAVAILABLE", "429", "503")
CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
TTS_SAMPLE_RATE = 24000
LYRIA_TIMEOUT_SECONDS = 180
IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
}
IMAGE_MAGIC = (
  (b"\x89PNG", "image/png"),
  (b"\xff\xd8\xff", "image/jpeg"),
  (b"RIFF", "image/webp"),
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class MediaError(Exception):
  """Base class for media generation failures; carries the shot index."""

  def __init__(
    self,
    message: str,
    shot_index: Optional[int] = None,
    code: Optional[int] = None,
  ):
    super().__init__(message)
    self.shot_index = shot_index
    if code is not None:
      self.code = code


class MediaRefusal(MediaError):
  """The model answered with text (or nothing) instead of the requested media."""

  def __init__(
    self,
    shot_index: Optional[int],
    text_parts: Any,
    model: Optional[str] = None,
  ):
    if isinstance(text_parts, str):
      text_parts = [text_parts]
    self.text_parts = [str(t) for t in (text_parts or []) if t]
    quoted = " ".join(" ".join(t.split()) for t in self.text_parts)
    quoted = quoted or "(no text returned)"
    label = model or "model"
    who = f"shot {shot_index}" if shot_index is not None else "voiceover"
    super().__init__(
      f"{who}: {label} returned no media part; model text: {quoted}",
      shot_index,
    )


class PollTimeout(MediaError):
  """A long-running operation did not finish within --poll-timeout."""

  def __init__(
    self,
    shot_index: Optional[int],
    timeout_seconds: float,
    operation_name: Optional[str] = None,
  ):
    self.timeout_seconds = timeout_seconds
    self.operation_name = operation_name
    name = f" {operation_name}" if operation_name else ""
    super().__init__(
      f"shot {shot_index}: video operation{name} not done after "
      f"{float(timeout_seconds):g} s (poll timeout)",
      shot_index,
    )


class RetryableError(MediaError):
  """A transient failure (quota, 5xx) that with_retry() may retry."""


class DependencyMissing(Exception):
  """An optional runtime dependency (google-genai, google-auth) is absent."""

  def __init__(self, message: str, hint: str = "pip install -r requirements.txt"):
    super().__init__(message)
    self.hint = hint


# ---------------------------------------------------------------------------
# Retries
# ---------------------------------------------------------------------------
def is_retryable(exc: BaseException) -> bool:
  """True for quota / transient server errors (429, 5xx, RESOURCE_EXHAUSTED)."""
  if isinstance(exc, RetryableError):
    return True
  if isinstance(exc, (MediaRefusal, PollTimeout, DependencyMissing)):
    return False
  code = getattr(exc, "code", None)
  if code is None:
    code = getattr(exc, "status_code", None)
  if code is not None:
    try:
      if int(code) in RETRYABLE_CODES:
        return True
    except (TypeError, ValueError):
      pass
  text = str(exc)
  return any(token in text for token in RETRYABLE_TOKENS)


def with_retry(
  fn: Callable[[], Any],
  attempts: int = 3,
  base: float = 2.0,
  sleep: Optional[Callable[[float], None]] = None,
  on_retry: Optional[Callable[[int, float, BaseException], None]] = None,
) -> Any:
  """Calls fn() up to `attempts` times with exponential backoff (base ** n).

  Only errors for which is_retryable() is true are retried. The sleep
  function defaults to time.sleep looked up at call time (tests monkeypatch
  `time.sleep`).
  """
  attempts = max(1, int(attempts))
  for attempt in range(1, attempts + 1):
    try:
      return fn()
    except Exception as exc:
      if attempt >= attempts or not is_retryable(exc):
        raise
      delay = float(base) ** attempt
      if on_retry is not None:
        on_retry(attempt, delay, exc)
      (sleep or time.sleep)(delay)
  return None  # not reachable: the loop either returns or raises


# ---------------------------------------------------------------------------
# SDK access and client cache
# ---------------------------------------------------------------------------
_CLIENTS: dict[tuple[str, str], Any] = {}
_CLIENT_LOCK = threading.Lock()


def import_sdk() -> tuple[Any, Any]:
  """Imports google-genai lazily; raises DependencyMissing when absent."""
  try:
    from google import genai  # pylint: disable=g-import-not-at-top
    from google.genai import types  # pylint: disable=g-import-not-at-top
  except ImportError as exc:
    raise DependencyMissing(
      "google-genai is required for --execute (pip install -r requirements.txt)"
    ) from exc
  return genai, types


def client_kwargs(genai_mod: Any, project: str, location: str) -> dict[str, Any]:
  """Builds Client kwargs: enterprise=True when the SDK exposes it, else vertexai=True."""
  kwargs: dict[str, Any] = {"project": project, "location": location}
  try:
    params = inspect.signature(genai_mod.Client.__init__).parameters
  except (TypeError, ValueError):
    params = {}
  if "enterprise" in params:
    kwargs["enterprise"] = True
  else:
    kwargs["vertexai"] = True
  return kwargs


def make_client(project: str, location: str) -> Any:
  """Returns one genai.Client per (project, location); created lazily."""
  key = (project, location)
  with _CLIENT_LOCK:
    client = _CLIENTS.get(key)
    if client is None:
      genai, _ = import_sdk()
      client = genai.Client(**client_kwargs(genai, project, location))
      _CLIENTS[key] = client
    return client


def reset_clients() -> None:
  """Drops cached clients (call at the start of a run and in tests)."""
  with _CLIENT_LOCK:
    _CLIENTS.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def as_bytes(data: Any) -> bytes:
  """Normalises SDK payloads (bytes, bytearray or base64 text) to bytes."""
  if isinstance(data, (bytes, bytearray, memoryview)):
    return bytes(data)
  if isinstance(data, str):
    try:
      return base64.b64decode(data, validate=True)
    except (ValueError, TypeError):
      return data.encode("utf-8")
  raise MediaError(f"unsupported media payload type {type(data).__name__}")


def image_extension(mime_type: str) -> str:
  mime = (mime_type or "").split(";")[0].strip().lower()
  if mime in IMAGE_EXTENSIONS:
    return IMAGE_EXTENSIONS[mime]
  sub = mime.split("/", 1)[1] if "/" in mime else ""
  sub = sub[2:] if sub.startswith("x-") else sub
  return sub or "png"


def sniff_image_mime(data: bytes) -> str:
  for magic, mime in IMAGE_MAGIC:
    if data.startswith(magic):
      if mime == "image/webp" and data[8:12] != b"WEBP":
        continue
      return mime
  return ""


def response_parts(resp: Any) -> list[Any]:
  """Returns resp.parts, falling back to resp.candidates[0].content.parts."""
  parts = None
  try:
    parts = resp.parts
  except Exception:  # pylint: disable=broad-except
    parts = None
  if parts:
    return list(parts)
  candidates = getattr(resp, "candidates", None) or []
  if candidates:
    content = getattr(candidates[0], "content", None)
    parts = getattr(content, "parts", None) if content is not None else None
  return list(parts or [])


def part_text(part: Any) -> str:
  text = getattr(part, "text", None)
  return str(text) if isinstance(text, str) and text.strip() else ""


def pcm_sample_rate(mime_type: Optional[str], default: int = TTS_SAMPLE_RATE) -> int:
  """Reads `rate=24000` out of mime types such as audio/L16;codec=pcm;rate=24000."""
  for token in (mime_type or "").split(";"):
    key, _, value = token.strip().partition("=")
    if key.lower() == "rate" and value.strip().isdigit():
      return int(value.strip())
  return default


def write_pcm_or_wav(audio_bytes: bytes, out_wav: Path, sample_rate: int = TTS_SAMPLE_RATE) -> None:
  """Writes audio bytes as a RIFF WAV file (wrapping raw 16-bit mono PCM if needed)."""
  out_wav.parent.mkdir(parents=True, exist_ok=True)
  if audio_bytes[:4] == b"RIFF":
    out_wav.write_bytes(audio_bytes)
    return
  with wave.open(str(out_wav), "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sample_rate)
    wf.writeframes(audio_bytes)


def one_line(text: Any, limit: int = 500) -> str:
  flat = " ".join(str(text).split())
  return flat if len(flat) <= limit else flat[: limit - 3] + "..."


# ---------------------------------------------------------------------------
# Image adapters
# ---------------------------------------------------------------------------
def generate_image(
  client: Any,
  api: str,
  model: str,
  prompt: str,
  aspect_ratio: str,
  out_dir: Path,
  shot_index: int,
) -> Path:
  """Generates one keyframe; returns work_dir/shot_{i}.<png|jpg|webp>."""
  if api == "generate_images":
    return _generate_images_legacy(client, model, prompt, aspect_ratio, out_dir, shot_index)
  if api == "generate_content_image":
    return _generate_content_image(client, model, prompt, aspect_ratio, out_dir, shot_index)
  raise MediaError(f"shot {shot_index}: no image adapter for api '{api}'", shot_index)


def _generate_images_legacy(
  client: Any, model: str, prompt: str, aspect_ratio: str, out_dir: Path, shot_index: int
) -> Path:
  _, types = import_sdk()
  resp = client.models.generate_images(
    model=model,
    prompt=prompt,
    config=types.GenerateImagesConfig(
      number_of_images=1,
      aspect_ratio=aspect_ratio,
      add_watermark=False,
    ),
  )
  images = getattr(resp, "generated_images", None) or []
  if not images:
    raise MediaRefusal(shot_index, [], model=model)
  image = getattr(images[0], "image", None)
  data = getattr(image, "image_bytes", None) if image is not None else None
  if not data:
    raise MediaRefusal(shot_index, [], model=model)
  raw = as_bytes(data)
  mime = getattr(image, "mime_type", None) or sniff_image_mime(raw) or "image/png"
  out = Path(out_dir) / f"shot_{shot_index}.{image_extension(mime)}"
  out.write_bytes(raw)
  return out


def _generate_content_image(
  client: Any, model: str, prompt: str, aspect_ratio: str, out_dir: Path, shot_index: int
) -> Path:
  _, types = import_sdk()
  resp = client.models.generate_content(
    model=model,
    contents=prompt,
    config=types.GenerateContentConfig(
      response_modalities=["IMAGE"],
      image_config=types.ImageConfig(aspect_ratio=aspect_ratio),
    ),
  )
  texts: list[str] = []
  for part in response_parts(resp):
    blob = getattr(part, "inline_data", None)
    data = getattr(blob, "data", None) if blob is not None else None
    if data:
      mime = str(getattr(blob, "mime_type", None) or "")
      raw = as_bytes(data)
      if not mime:
        mime = sniff_image_mime(raw)
      if mime.startswith("image/"):
        out = Path(out_dir) / f"shot_{shot_index}.{image_extension(mime)}"
        out.write_bytes(raw)
        return out
    text = part_text(part)
    if text:
      texts.append(text)
  raise MediaRefusal(shot_index, texts, model=model)


# ---------------------------------------------------------------------------
# Video adapter (Veo)
# ---------------------------------------------------------------------------
def poll_operation(
  client: Any,
  operation: Any,
  poll_interval: float,
  poll_timeout: float,
  shot_index: Optional[int] = None,
) -> Any:
  """Polls client.operations.get(operation) until done or PollTimeout."""
  start = time.monotonic()
  while not getattr(operation, "done", False):
    elapsed = time.monotonic() - start
    if elapsed >= poll_timeout:
      raise PollTimeout(shot_index, poll_timeout, getattr(operation, "name", None))
    time.sleep(max(0.0, min(float(poll_interval), poll_timeout - elapsed)))
    operation = client.operations.get(operation)
  return operation


def generate_video(
  client: Any,
  api: str,
  model: str,
  prompt: str,
  keyframe: Optional[Path],
  aspect_ratio: str,
  duration_seconds: int,
  out_dir: Path,
  shot_index: int,
  veo_audio: bool = False,
  resolution: Optional[str] = None,
  poll_interval: float = 10.0,
  poll_timeout: float = 900.0,
) -> Path:
  """Generates one clip (image-to-video when a keyframe is given); returns shot_{i}.mp4."""
  if api != "generate_videos":
    raise MediaError(f"shot {shot_index}: no video adapter for api '{api}'", shot_index)
  _, types = import_sdk()
  config_kwargs: dict[str, Any] = {
    "aspect_ratio": aspect_ratio,
    "duration_seconds": int(duration_seconds),
    "enhance_prompt": True,
    "generate_audio": bool(veo_audio),
  }
  if resolution:
    config_kwargs["resolution"] = resolution
  image = types.Image.from_file(location=str(keyframe)) if keyframe else None
  operation = client.models.generate_videos(
    model=model,
    source=types.GenerateVideosSource(prompt=prompt, image=image),
    config=types.GenerateVideosConfig(**config_kwargs),
  )
  operation = poll_operation(client, operation, poll_interval, poll_timeout, shot_index)
  error = getattr(operation, "error", None)
  if error:
    code = error.get("code") if isinstance(error, dict) else getattr(error, "code", None)
    raise MediaError(
      f"shot {shot_index}: video generation failed: {one_line(error)}",
      shot_index,
      code=code if isinstance(code, int) else None,
    )
  response = getattr(operation, "response", None) or getattr(operation, "result", None)
  videos = getattr(response, "generated_videos", None) or []
  if not videos:
    raise MediaError(
      f"shot {shot_index}: video operation finished without generated_videos",
      shot_index,
    )
  video = getattr(videos[0], "video", None)
  data = getattr(video, "video_bytes", None) if video is not None else None
  if not data:
    uri = getattr(video, "uri", None) if video is not None else None
    raise MediaError(
      f"shot {shot_index}: Veo returned no inline video_bytes (uri={uri!r}); "
      "generate without output_gcs_uri so bytes are returned inline",
      shot_index,
    )
  out = Path(out_dir) / f"shot_{shot_index}.mp4"
  out.write_bytes(as_bytes(data))
  return out


# ---------------------------------------------------------------------------
# TTS adapter (Gemini TTS)
# ---------------------------------------------------------------------------
def generate_tts(
  client: Any,
  api: str,
  model: str,
  script: str,
  voice: str,
  out_wav: Path,
  language_code: Optional[str] = None,
) -> Path:
  """Synthesises the voiceover; writes 16-bit PCM (24 kHz mono by default) as WAV."""
  if api != "generate_content_audio":
    raise MediaError(f"voiceover: no tts adapter for api '{api}'")
  _, types = import_sdk()
  speech_kwargs: dict[str, Any] = {
    "voice_config": types.VoiceConfig(
      prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
    ),
  }
  if language_code:
    speech_kwargs["language_code"] = language_code
  resp = client.models.generate_content(
    model=model,
    contents=script,
    config=types.GenerateContentConfig(
      response_modalities=["AUDIO"],
      speech_config=types.SpeechConfig(**speech_kwargs),
    ),
  )
  texts: list[str] = []
  for part in response_parts(resp):
    blob = getattr(part, "inline_data", None)
    data = getattr(blob, "data", None) if blob is not None else None
    if data:
      rate = pcm_sample_rate(getattr(blob, "mime_type", None))
      write_pcm_or_wav(as_bytes(data), Path(out_wav), sample_rate=rate)
      return Path(out_wav)
    text = part_text(part)
    if text:
      texts.append(text)
  raise MediaRefusal(None, texts, model=model)


# ---------------------------------------------------------------------------
# Music adapter (Lyria, REST :predict)
# ---------------------------------------------------------------------------
def lyria_endpoint(project: str, location: str, model: str) -> str:
  """Vertex REST host: no prefix for `global`, `{location}-` prefix otherwise."""
  if location == "global":
    host = "https://aiplatform.googleapis.com"
  else:
    host = f"https://{location}-aiplatform.googleapis.com"
  return (
    f"{host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predict"
  )


def generate_music(
  api: str,
  project: str,
  location: str,
  model: str,
  prompt: str,
  out_wav: Path,
  timeout: float = LYRIA_TIMEOUT_SECONDS,
  negative_prompt: Optional[str] = None,
  seed: Optional[int] = None,
) -> Path:
  """Generates the music bed through the Vertex :predict REST endpoint."""
  if api != "predict_rest":
    raise MediaError(f"music: no music adapter for api '{api}'")
  try:
    import google.auth  # pylint: disable=g-import-not-at-top
    import google.auth.transport.requests  # pylint: disable=g-import-not-at-top
  except ImportError as exc:
    raise DependencyMissing(
      "google-auth is required for Lyria (pip install -r requirements.txt)"
    ) from exc

  creds, _ = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
  creds.refresh(google.auth.transport.requests.Request())

  url = lyria_endpoint(project, location, model)
  path = urllib.parse.urlsplit(url).path
  instance: dict[str, Any] = {"prompt": prompt}
  if negative_prompt:
    instance["negative_prompt"] = negative_prompt
  parameters: dict[str, Any] = {}
  if seed is not None:
    instance["seed"] = int(seed)
  else:
    parameters["sample_count"] = 1
  body = {"instances": [instance], "parameters": parameters}
  req = urllib.request.Request(
    url,
    data=json.dumps(body).encode("utf-8"),
    headers={
      "Authorization": f"Bearer {creds.token}",
      "Content-Type": "application/json; charset=utf-8",
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(req, timeout=timeout) as resp:
      raw = resp.read()
  except urllib.error.HTTPError as exc:
    code = int(getattr(exc, "code", 0) or 0)
    reason = one_line(getattr(exc, "reason", "") or "", 80)
    message = f"Lyria predict failed: HTTP {code} {reason} for {path}".rstrip()
    if code in RETRYABLE_CODES:
      raise RetryableError(message, code=code) from None
    raise MediaError(message, code=code) from None
  except urllib.error.URLError as exc:
    raise MediaError(
      f"Lyria predict failed: {one_line(getattr(exc, 'reason', exc), 120)} for {path}"
    ) from None

  try:
    payload = json.loads(raw.decode("utf-8"))
  except (ValueError, UnicodeDecodeError) as exc:
    raise MediaError(f"Lyria returned a non-JSON body for {path}: {exc}") from None
  predictions = payload.get("predictions") if isinstance(payload, dict) else None
  if not predictions:
    raise MediaError(f"Lyria returned no predictions for {path}")
  first = predictions[0] if isinstance(predictions[0], dict) else {}
  b64 = first.get("audioContent") or first.get("bytesBase64Encoded")
  if not b64:
    raise MediaError("Lyria prediction has neither audioContent nor bytesBase64Encoded")
  out = Path(out_wav)
  out.parent.mkdir(parents=True, exist_ok=True)
  out.write_bytes(base64.b64decode(b64))
  return out
