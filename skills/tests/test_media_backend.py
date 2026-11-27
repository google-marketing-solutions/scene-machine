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
"""Unit tests for scene-machine/scripts/media_backend.py and model_registry.json."""

from __future__ import annotations

import datetime as dt
import inspect
import json
import time
from pathlib import Path
from typing import Any

import pytest

import fake_genai
from conftest import MEDIA_BACKEND, REGISTRY, load_script, require_file


@pytest.fixture
def backend() -> Any:
  require_file("scene-machine/scripts/media_backend.py")
  return load_script(MEDIA_BACKEND)


class _Exc(Exception):
  def __init__(self, message: str, code: int | None = None, status_code: int | None = None):
    super().__init__(message)
    if code is not None:
      self.code = code
    if status_code is not None:
      self.status_code = status_code


def test_public_api_names(backend: Any) -> None:
  for name in (
    "MediaError",
    "MediaRefusal",
    "PollTimeout",
    "is_retryable",
    "with_retry",
    "make_client",
  ):
    assert hasattr(backend, name), name
  assert issubclass(backend.MediaRefusal, backend.MediaError)
  assert issubclass(backend.PollTimeout, backend.MediaError)
  params = inspect.signature(backend.with_retry).parameters
  assert params["attempts"].default == 3 and params["base"].default == 2.0


@pytest.mark.parametrize(
  "exc, expected",
  [
    (_Exc("quota", code=429), True),
    (_Exc("server", status_code=503), True),
    (_Exc("x", code=500), True),
    (_Exc("x", code=502), True),
    (_Exc("x", code=504), True),
    (_Exc("RESOURCE_EXHAUSTED: too many requests"), True),
    (_Exc("503 UNAVAILABLE"), True),
    (_Exc("bad request", code=400), False),
    (_Exc("PERMISSION_DENIED", code=403), False),
    (ValueError("plain failure"), False),
  ],
)
def test_is_retryable(backend: Any, exc: BaseException, expected: bool) -> None:
  assert backend.is_retryable(exc) is expected


def test_refusal_and_timeout_are_not_retryable(backend: Any) -> None:
  assert backend.is_retryable(backend.MediaRefusal(2, ["I cannot do that"])) is False
  assert backend.is_retryable(backend.PollTimeout(2, 900.0)) is False


def test_with_retry_backoff_and_give_up(backend: Any, monkeypatch: pytest.MonkeyPatch) -> None:
  sleeps: list[float] = []
  monkeypatch.setattr(time, "sleep", lambda s: sleeps.append(float(s)))
  attempts: list[int] = []

  def flaky() -> str:
    attempts.append(1)
    if len(attempts) < 3:
      raise _Exc("UNAVAILABLE", code=503)
    return "ok"

  assert backend.with_retry(flaky, attempts=3, base=2.0) == "ok"
  assert len(attempts) == 3 and sleeps == [2.0, 4.0]

  attempts.clear()
  sleeps.clear()

  def always() -> None:
    attempts.append(1)
    raise _Exc("RESOURCE_EXHAUSTED", code=429)

  with pytest.raises(_Exc):
    backend.with_retry(always, attempts=3, base=2.0)
  assert len(attempts) == 3 and sleeps == [2.0, 4.0]

  attempts.clear()
  sleeps.clear()

  def fatal() -> None:
    attempts.append(1)
    raise _Exc("INVALID_ARGUMENT", code=400)

  with pytest.raises(_Exc):
    backend.with_retry(fatal, attempts=3, base=2.0)
  assert len(attempts) == 1 and sleeps == []


def test_make_client_is_cached_per_location_and_uses_enterprise(
  backend: Any, fake_sdk: fake_genai.Recorder
) -> None:
  if hasattr(backend, "reset_clients"):
    backend.reset_clients()
  a = backend.make_client("proj", "us-central1")
  b = backend.make_client("proj", "us-central1")
  c = backend.make_client("proj", "global")
  assert a is b and a is not c
  assert len(fake_sdk.clients) == 2
  assert all(k.get("enterprise") is True and "vertexai" not in k for k in fake_sdk.clients)
  assert {k["location"] for k in fake_sdk.clients} == {"us-central1", "global"}


def test_make_client_falls_back_to_vertexai(
  monkeypatch: pytest.MonkeyPatch, fake_media_bytes: dict[str, Any]
) -> None:
  rec = fake_genai.Recorder(dict(fake_media_bytes))
  fake_genai.install(monkeypatch, rec, enterprise_kwarg=False)
  backend = load_script(MEDIA_BACKEND)
  backend.make_client("proj", "us-central1")
  assert rec.clients == [{"vertexai": True, "project": "proj", "location": "us-central1"}]


def test_lyria_endpoint_hosts(backend: Any) -> None:
  if not hasattr(backend, "lyria_endpoint"):
    pytest.skip("lyria_endpoint helper not exposed")
  assert backend.lyria_endpoint("p", "global", "lyria-002") == (
    "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/lyria-002:predict"
  )
  assert backend.lyria_endpoint("p", "us-central1", "lyria-002") == (
    "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1"
    "/publishers/google/models/lyria-002:predict"
  )


def test_poll_timeout_uses_monotonic_clock(backend: Any, monkeypatch: pytest.MonkeyPatch) -> None:
  if not hasattr(backend, "poll_operation"):
    pytest.skip("poll_operation helper not exposed")
  now = {"t": 100.0}
  monkeypatch.setattr(time, "monotonic", lambda: now["t"])

  def fake_sleep(s: float) -> None:
    now["t"] += s

  monkeypatch.setattr(time, "sleep", fake_sleep)

  class Ops:
    polls = 0

    def get(self, op: Any) -> Any:
      Ops.polls += 1
      return op

  class Client:
    operations = Ops()

  op = type("Op", (), {"done": False, "name": "operations/x"})()
  with pytest.raises(backend.PollTimeout):
    backend.poll_operation(Client(), op, poll_interval=10.0, poll_timeout=30.0, shot_index=1)
  assert 2 <= Ops.polls <= 4


# ---------------------------------------------------------------------------
# model_registry.json
# ---------------------------------------------------------------------------
@pytest.fixture
def registry() -> dict[str, Any]:
  require_file("scene-machine/scripts/model_registry.json")
  return json.loads(Path(REGISTRY).read_text(encoding="utf-8"))


def test_registry_defaults_are_current(registry: dict[str, Any]) -> None:
  defaults = {m["kind"]: m for m in registry["models"] if m.get("default")}
  assert set(defaults) == {"image", "video", "tts", "music"}
  assert defaults["image"]["id"] == "gemini-3.1-flash-image"
  assert defaults["video"]["id"] == "veo-3.1-fast-generate-001"
  assert defaults["tts"]["id"] == "gemini-2.5-flash-tts"
  assert defaults["music"]["id"] == "lyria-002"
  for entry in defaults.values():
    assert entry["status"] != "retired"
    assert entry.get("api") and entry.get("last_verified")


def test_registry_entries_have_api_and_dates(registry: dict[str, Any]) -> None:
  today = dt.date.today()
  for entry in registry["models"]:
    assert entry["status"] in {"active", "preview", "retired", "successor"}, entry["id"]
    if entry["status"] in {"active", "preview"} or entry.get("default"):
      assert entry.get("api"), entry["id"]
      assert entry.get("last_verified"), f"{entry['id']} lacks last_verified"
      verified = dt.date.fromisoformat(entry["last_verified"])
      assert (today - verified).days < 180, f"{entry['id']} last_verified {verified} is stale"
    if entry["status"] == "retired":
      assert entry.get("replacement"), entry["id"]
  all_ids = {m["id"] for m in registry["models"]}
  assert {
    "gemini-nano-banana-2.1",
    "gemini-3.1-flash-lite-image",
    "gemini-3-pro-image",
    "gemini-2.5-flash-image",
    "veo-3.1-lite-generate-001",
    "gemini-omni-1.1-flash-preview",
    "gemini-omni-flash-preview",
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "lyria-3-pro-preview",
    "lyria-3-clip-preview",
  } <= all_ids
  retired = {m["id"] for m in registry["models"] if m["status"] == "retired"}
  assert {
    "imagen-4.0-generate-001",
    "imagen-3.0-generate-002",
    "veo-3.0-generate-001",
    "gemini-2.5-flash-preview-tts",
  } <= retired
  music = next(m for m in registry["models"] if m["id"] == "lyria-002")
  assert music["api"] == "predict_rest" and "global" in music["locations"]
