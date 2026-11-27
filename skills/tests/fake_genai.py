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
"""In-process fake of google.genai, google.auth and urllib.request.urlopen.

The fake mirrors the documented response shapes used by media_backend.py:

* ``client.models.generate_content`` -> object with ``.parts`` and
  ``.candidates[0].content.parts``; parts carry ``.text`` or
  ``.inline_data.mime_type`` / ``.inline_data.data`` (Gemini image models return
  an optional text part followed by an ``image/png`` or ``image/jpeg`` part; a
  "refusal" is a text-only parts list; Gemini TTS returns ``audio/L16`` PCM).
* ``client.models.generate_images`` -> ``.generated_images[0].image.image_bytes``.
* ``client.models.generate_videos`` -> operation with ``.done``, ``.error`` and
  ``.response.generated_videos[0].video.video_bytes``; ``client.operations.get``
  advances it.
* Lyria: ``urlopen(req, timeout=)`` with ``req.full_url`` recorded and the body
  ``{"predictions":[{"audioContent": "<b64 wav>", "mimeType": "audio/wav"}]}``
  (``bytesBase64Encoded`` selectable as the tolerated alias).

Nothing here opens a socket. ``test_sdk_surface.py`` checks the real SDK still
has the attribute surface this fake imitates.
"""

from __future__ import annotations

import base64
import email.message
import io
import json
import sys
import threading
import types as pytypes
import urllib.error
import urllib.request
from typing import Any, Callable

FAKE_TOKEN = "fake-token-SECRET"
FAKE_ADC_PROJECT = "fake-adc-project"
MODULE_NAMES = (
  "google",
  "google.genai",
  "google.genai.types",
  "google.genai.errors",
  "google.auth",
  "google.auth.exceptions",
  "google.auth.transport",
  "google.auth.transport.requests",
)


class _Cfg:
  """Keyword-argument holder standing in for the pydantic config types."""

  def __init__(self, **kw: Any):
    self.__dict__.update(kw)

  def __getattr__(self, name: str) -> Any:
    if name.startswith("_"):
      raise AttributeError(name)
    return None

  def model_dump(self, **_: Any) -> dict[str, Any]:
    return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}

  def __repr__(self) -> str:
    return f"{type(self).__name__}({self.model_dump()!r})"


def _part_text(text: str) -> Any:
  return pytypes.SimpleNamespace(text=text, inline_data=None)


def _part_blob(mime: str, data: bytes) -> Any:
  return pytypes.SimpleNamespace(
    text=None, inline_data=pytypes.SimpleNamespace(mime_type=mime, data=data)
  )


def _response(parts: list[Any]) -> Any:
  content = pytypes.SimpleNamespace(parts=parts, role="model")
  texts = [p.text for p in parts if getattr(p, "text", None)]
  return pytypes.SimpleNamespace(
    parts=parts,
    candidates=[pytypes.SimpleNamespace(content=content, finish_reason="STOP")],
    text="".join(texts) if texts else None,
  )


class FakeAPIError(Exception):
  """Stands in for google.genai.errors.APIError (has .code, .status, .message)."""

  def __init__(self, code: int, message: str, status: str = ""):
    self.code = code
    self.status = status or {
      429: "RESOURCE_EXHAUSTED",
      500: "INTERNAL",
      503: "UNAVAILABLE",
      403: "PERMISSION_DENIED",
      400: "INVALID_ARGUMENT",
    }.get(code, "UNKNOWN")
    self.message = message
    super().__init__(f"{code} {self.status}. {message}")


class Recorder:
  """Records every fake SDK interaction and holds the behaviour knobs."""

  def __init__(self, media: dict[str, Any]):
    self.lock = threading.RLock()
    self.media = media  # png, jpeg, pcm, wav, mp4 (callable duration -> bytes)
    self.calls: list[dict[str, Any]] = []
    self.clients: list[dict[str, Any]] = []
    self.polls: dict[str, int] = {}
    self.lyria_requests: list[dict[str, Any]] = []
    self.auth_default_calls = 0
    self.auth_refresh_calls = 0
    self.op_counter = 0
    # knobs ---------------------------------------------------------------
    self.polls_to_done = 2
    self.image_mode: dict[str, str] = {}  # substring of prompt -> png|jpeg|text_then_png|refuse
    self.image_raise: dict[str, list[BaseException]] = {}  # substring -> exceptions per call
    self.video_outcomes: dict[
      str, list[str]
    ] = {}  # substring -> ok|raise:<code>|error:<code>|never
    self.tts_mode = "pcm"  # pcm | wav | refuse | raise
    self.lyria_key = "audioContent"
    self.lyria_mime = "audio/wav"
    self.lyria_http_error: int | None = None
    self.auth_fail = False

  # -- helpers -------------------------------------------------------------
  @staticmethod
  def _match(text: str, table: dict[str, Any]) -> Any:
    for key, value in table.items():
      if key in (text or ""):
        return value
    return None

  def kinds(self) -> list[str]:
    return [c["kind"] for c in self.calls]

  def count(self, kind: str) -> int:
    return self.kinds().count(kind)

  def of(self, kind: str) -> list[dict[str, Any]]:
    return [c for c in self.calls if c["kind"] == kind]

  def record(self, **call: Any) -> None:
    with self.lock:
      self.calls.append(call)

  def next_op_name(self) -> str:
    with self.lock:
      self.op_counter += 1
      return f"operations/fake-op-{self.op_counter}"

  def mp4(self, duration: int) -> bytes:
    with self.lock:
      cache = self.media.setdefault("_mp4_cache", {})
      if duration not in cache:
        cache[duration] = self.media["mp4"](int(duration))
      return cache[duration]


def _cfg_dump(cfg: Any) -> Any:
  if isinstance(cfg, _Cfg):
    return {k: _cfg_dump(v) for k, v in cfg.model_dump().items()}
  if isinstance(cfg, (list, tuple)):
    return [_cfg_dump(v) for v in cfg]
  return cfg


def build_fake_modules(
  rec: Recorder, enterprise_kwarg: bool = True
) -> dict[str, pytypes.ModuleType]:
  """Creates the fake module objects for sys.modules (does not install them)."""

  class Image(_Cfg):
    @classmethod
    def from_file(cls, location: str, mime_type: str | None = None) -> "Image":
      return cls(location=str(location), mime_type=mime_type)

    @classmethod
    def from_bytes(cls, data: bytes, mime_type: str | None = None) -> "Image":
      return cls(image_bytes=data, mime_type=mime_type)

  types_mod = pytypes.ModuleType("google.genai.types")
  for name in (
    "GenerateContentConfig",
    "SpeechConfig",
    "VoiceConfig",
    "PrebuiltVoiceConfig",
    "GenerateImagesConfig",
    "GenerateVideosSource",
    "GenerateVideosConfig",
    "ImageConfig",
    "Part",
    "Blob",
    "Content",
    "HttpOptions",
  ):
    setattr(types_mod, name, type(name, (_Cfg,), {}))
  types_mod.Image = Image

  errors_mod = pytypes.ModuleType("google.genai.errors")
  errors_mod.APIError = FakeAPIError
  errors_mod.ClientError = type("ClientError", (FakeAPIError,), {})
  errors_mod.ServerError = type("ServerError", (FakeAPIError,), {})

  class Models:
    def __init__(self, client: Any):
      self.client = client

    # Gemini image (IMAGE modality) and Gemini TTS (AUDIO modality)
    def generate_content(self, model: str, contents: Any, config: Any = None) -> Any:
      modalities = [str(m).upper() for m in (getattr(config, "response_modalities", None) or [])]
      prompt = (
        contents if isinstance(contents, str) else json.dumps(_cfg_dump(contents), default=str)
      )
      if "AUDIO" in modalities:
        speech = getattr(config, "speech_config", None)
        voice_cfg = getattr(speech, "voice_config", None)
        prebuilt = getattr(voice_cfg, "prebuilt_voice_config", None)
        rec.record(
          kind="tts",
          model=model,
          location=self.client.location,
          contents=prompt,
          voice_name=getattr(prebuilt, "voice_name", None),
          language_code=getattr(speech, "language_code", None),
          config=_cfg_dump(config),
        )
        if rec.tts_mode == "raise":
          raise FakeAPIError(500, "Internal error")
        if rec.tts_mode == "refuse":
          return _response([_part_text("I cannot read that script aloud.")])
        if rec.tts_mode == "wav":
          return _response([_part_blob("audio/wav", rec.media["wav"])])
        return _response([_part_blob("audio/L16;codec=pcm;rate=24000", rec.media["pcm"])])
      if "IMAGE" in modalities:
        image_cfg = getattr(config, "image_config", None)
        rec.record(
          kind="image",
          api="generate_content_image",
          model=model,
          location=self.client.location,
          prompt=prompt,
          aspect_ratio=getattr(image_cfg, "aspect_ratio", None),
          config=_cfg_dump(config),
        )
        pending = rec._match(prompt, rec.image_raise)
        if pending:
          raise pending.pop(0)
        mode = rec._match(prompt, rec.image_mode) or "png"
        if mode == "refuse":
          return _response([_part_text("I can't create that image. Try a different description.")])
        if mode == "jpeg":
          return _response([_part_blob("image/jpeg", rec.media["jpeg"])])
        if mode == "text_then_png":
          return _response(
            [
              _part_text("Here is the image you asked for."),
              _part_blob("image/png", rec.media["png"]),
            ]
          )
        return _response([_part_blob("image/png", rec.media["png"])])
      raise FakeAPIError(400, f"fake generate_content: unsupported modalities {modalities}")

    # legacy Imagen
    def generate_images(self, model: str, prompt: str, config: Any = None) -> Any:
      rec.record(
        kind="image",
        api="generate_images",
        model=model,
        location=self.client.location,
        prompt=prompt,
        aspect_ratio=getattr(config, "aspect_ratio", None),
        config=_cfg_dump(config),
      )
      pending = rec._match(prompt, rec.image_raise)
      if pending:
        raise pending.pop(0)
      img = pytypes.SimpleNamespace(
        image=pytypes.SimpleNamespace(image_bytes=rec.media["png"], mime_type="image/png"),
        rai_filtered_reason=None,
      )
      return pytypes.SimpleNamespace(generated_images=[img])

    # Veo
    def generate_videos(
      self,
      model: str,
      prompt: Any = None,
      image: Any = None,
      video: Any = None,
      source: Any = None,
      config: Any = None,
    ) -> Any:
      if source is not None:
        prompt = getattr(source, "prompt", None)
        image = getattr(source, "image", None)
      duration = getattr(config, "duration_seconds", None) or 6
      rec.record(
        kind="video",
        model=model,
        location=self.client.location,
        prompt=prompt,
        used_source=source is not None,
        image_location=getattr(image, "location", None),
        duration_seconds=duration,
        aspect_ratio=getattr(config, "aspect_ratio", None),
        generate_audio=getattr(config, "generate_audio", None),
        resolution=getattr(config, "resolution", None),
        enhance_prompt=getattr(config, "enhance_prompt", None),
        config=_cfg_dump(config),
      )
      outcomes = rec._match(prompt or "", rec.video_outcomes)
      outcome = "ok"
      if outcomes:
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
      if outcome.startswith("raise:"):
        code = int(outcome.split(":", 1)[1])
        raise FakeAPIError(code, f"fake Veo failure for {prompt!r}")
      return pytypes.SimpleNamespace(
        name=rec.next_op_name(),
        done=False,
        error=None,
        response=None,
        result=None,
        metadata=None,
        _outcome=outcome,
        _ticks=0,
        _duration=int(duration),
      )

  class Operations:
    def __init__(self, client: Any):
      self.client = client

    def get(self, operation: Any, config: Any = None) -> Any:
      operation._ticks += 1
      with rec.lock:
        rec.polls[operation.name] = operation._ticks
      rec.record(kind="poll", name=operation.name)
      if operation._outcome == "never":
        return operation
      if operation._ticks >= rec.polls_to_done:
        operation.done = True
        if operation._outcome.startswith("error:"):
          code = int(operation._outcome.split(":", 1)[1])
          operation.error = {"code": code, "message": f"fake operation error code {code}"}
        else:
          vid = pytypes.SimpleNamespace(
            video_bytes=rec.mp4(operation._duration), uri=None, mime_type="video/mp4"
          )
          operation.response = pytypes.SimpleNamespace(
            generated_videos=[pytypes.SimpleNamespace(video=vid)], rai_media_filtered_count=0
          )
          operation.result = operation.response
      return operation

  def _record_client(self: Any, kw: dict[str, Any]) -> None:
    kw = {k: v for k, v in kw.items() if v is not None}
    with rec.lock:
      rec.clients.append(kw)
    self.project = kw.get("project")
    self.location = kw.get("location")
    self.models = Models(self)
    self.operations = Operations(self)

  class Client:
    def __init__(
      self,
      *,
      enterprise: bool | None = None,
      vertexai: bool | None = None,
      api_key: str | None = None,
      credentials: Any = None,
      project: str | None = None,
      location: str | None = None,
      debug_config: Any = None,
      http_options: Any = None,
    ):
      _record_client(
        self,
        dict(
          enterprise=enterprise,
          vertexai=vertexai,
          api_key=api_key,
          credentials=credentials,
          project=project,
          location=location,
          http_options=http_options,
        ),
      )

  class LegacyClient:  # google-genai before the `enterprise` kwarg existed
    def __init__(
      self,
      *,
      vertexai: bool | None = None,
      api_key: str | None = None,
      credentials: Any = None,
      project: str | None = None,
      location: str | None = None,
      debug_config: Any = None,
      http_options: Any = None,
    ):
      _record_client(
        self,
        dict(
          vertexai=vertexai,
          api_key=api_key,
          credentials=credentials,
          project=project,
          location=location,
          http_options=http_options,
        ),
      )

  genai = pytypes.ModuleType("google.genai")
  genai.Client = Client if enterprise_kwarg else LegacyClient
  genai.types = types_mod
  genai.errors = errors_mod
  genai.__version__ = "0.0.0-fake"
  genai.__path__ = []  # type: ignore[attr-defined]

  # google.auth ------------------------------------------------------------
  auth_exc = pytypes.ModuleType("google.auth.exceptions")
  auth_exc.DefaultCredentialsError = type("DefaultCredentialsError", (Exception,), {})
  auth_exc.RefreshError = type("RefreshError", (Exception,), {})
  auth_exc.GoogleAuthError = type("GoogleAuthError", (Exception,), {})

  class Credentials:
    def __init__(self) -> None:
      self.token = FAKE_TOKEN
      self.valid = True
      self.expired = False

    def refresh(self, request: Any) -> None:
      rec.auth_refresh_calls += 1

  def auth_default(scopes: Any = None, request: Any = None, quota_project_id: Any = None) -> Any:
    rec.auth_default_calls += 1
    if rec.auth_fail:
      raise auth_exc.DefaultCredentialsError("Your default credentials were not found")
    return Credentials(), FAKE_ADC_PROJECT

  requests_mod = pytypes.ModuleType("google.auth.transport.requests")
  requests_mod.Request = type("Request", (), {"__call__": lambda self, *a, **k: None})
  transport_mod = pytypes.ModuleType("google.auth.transport")
  transport_mod.requests = requests_mod
  transport_mod.__path__ = []  # type: ignore[attr-defined]
  auth_mod = pytypes.ModuleType("google.auth")
  auth_mod.default = auth_default
  auth_mod.exceptions = auth_exc
  auth_mod.transport = transport_mod
  auth_mod.__path__ = []  # type: ignore[attr-defined]

  google_mod = pytypes.ModuleType("google")
  google_mod.genai = genai
  google_mod.auth = auth_mod
  google_mod.__path__ = []  # type: ignore[attr-defined]

  return {
    "google": google_mod,
    "google.genai": genai,
    "google.genai.types": types_mod,
    "google.genai.errors": errors_mod,
    "google.auth": auth_mod,
    "google.auth.exceptions": auth_exc,
    "google.auth.transport": transport_mod,
    "google.auth.transport.requests": requests_mod,
  }


class _FakeHTTPResponse:
  def __init__(self, body: bytes, status: int = 200):
    self._body = body
    self.status = status
    self.headers = email.message.Message()

  def read(self) -> bytes:
    return self._body

  def getcode(self) -> int:
    return self.status

  def __enter__(self) -> "_FakeHTTPResponse":
    return self

  def __exit__(self, *exc: Any) -> bool:
    return False


def make_fake_urlopen(rec: Recorder) -> Callable[..., Any]:
  def fake_urlopen(req: Any, data: Any = None, timeout: Any = None, **_: Any) -> Any:
    url = req.full_url if hasattr(req, "full_url") else str(req)
    raw = req.data if hasattr(req, "data") else data
    headers = dict(req.header_items()) if hasattr(req, "header_items") else {}
    try:
      payload = json.loads(raw) if raw else None
    except (TypeError, ValueError):
      payload = raw
    with rec.lock:
      rec.lyria_requests.append(
        {"url": url, "payload": payload, "headers": headers, "timeout": timeout}
      )
    if rec.lyria_http_error:
      code = int(rec.lyria_http_error)
      body = json.dumps(
        {
          "error": {
            "code": code,
            "message": "Permission denied on resource project",
            "status": "PERMISSION_DENIED",
          }
        }
      ).encode()
      raise urllib.error.HTTPError(
        url, code, "Forbidden", email.message.Message(), io.BytesIO(body)
      )
    b64 = base64.b64encode(rec.media["wav"]).decode("ascii")
    body = json.dumps({"predictions": [{rec.lyria_key: b64, "mimeType": rec.lyria_mime}]}).encode()
    return _FakeHTTPResponse(body)

  return fake_urlopen


def install(
  monkeypatch: Any, rec: Recorder, enterprise_kwarg: bool = True
) -> dict[str, pytypes.ModuleType]:
  """Installs the fake modules into sys.modules and patches urlopen (monkeypatch-scoped)."""
  modules = build_fake_modules(rec, enterprise_kwarg=enterprise_kwarg)
  for name in list(sys.modules):
    if name == "google" or name.startswith("google."):
      monkeypatch.delitem(sys.modules, name, raising=False)
  for name, mod in modules.items():
    monkeypatch.setitem(sys.modules, name, mod)
  monkeypatch.setattr(urllib.request, "urlopen", make_fake_urlopen(rec))
  return modules
