# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Bounded audio normalization and Gemini transcription for dictation."""

from __future__ import annotations

import io
import json
import os
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any
import wave

import httpx
from google import genai
from google.genai import types


MAX_AUDIO_BYTES = 4 * 1024 * 1024
MAX_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024
MAX_DURATION_SECONDS = 120
SUBPROCESS_DEADLINE_SECONDS = 10
PROVIDER_TIMEOUT_MILLISECONDS = 45_000
MODEL = 'gemini-3.5-transcribe-preview'
LOCATION = 'global'
MIME_TYPES = (
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/wav',
)

# Keep normalized output below the request/audio cap. Decoded frames, not this
# byte bound, are the source of truth for the 120-second duration check.
_MAX_WAV_BYTES = 4 * 1024 * 1024
_MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
_ADMISSION = threading.BoundedSemaphore(2)


class TranscriptionError(Exception):
  """A safe, stable error that can be returned from the HTTP handler."""

  def __init__(self, code: str, status: int, message: str):
    super().__init__(message)
    self.code = code
    self.status = status
    self.message = message


def _enum_value(value):
  """Returns a stable enum value without exposing provider detail."""
  value = getattr(value, 'value', value)
  return value if isinstance(value, str) else None


def _prompt_block_reason(response: Any) -> str | None:
  feedback = getattr(response, 'prompt_feedback', None)
  reason = getattr(feedback, 'block_reason', None)
  value = _enum_value(reason)
  if value and value != 'BLOCK_REASON_UNSPECIFIED':
    return value
  return None


def _is_completed_empty(response: Any, candidate: Any) -> bool:
  return (
      _enum_value(getattr(candidate, 'finish_reason', None)) == 'STOP'
      and _prompt_block_reason(response) is None
  )


def enabled() -> bool:
  """Returns whether the server-side dictation capability is enabled."""
  return os.environ.get('DICTATION_ENABLED', '').strip().lower() in (
      '1', 'true', 'yes'
  )


def _remaining(deadline: float) -> float:
  remaining = deadline - time.monotonic()
  if remaining <= 0:
    raise TranscriptionError(
        'normalization_timeout', 504, 'Audio processing timed out'
    )
  return remaining


def _kill_process(process: subprocess.Popen) -> None:
  """Stops a media process without waiting beyond the request deadline."""
  if process.poll() is None:
    try:
      process.kill()
    except OSError:
      return
    try:
      process.wait(timeout=0.1)
    except subprocess.TimeoutExpired:
      pass


def _run(command: list[str], deadline: float) -> subprocess.CompletedProcess:
  """Runs a local media command without a shell and with bounded output."""
  try:
    process = subprocess.Popen(  # pylint: disable=consider-using-with
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
  except OSError as exc:
    raise TranscriptionError(
        'normalization_failed', 502, 'Audio processing failed'
    ) from exc
  output = bytearray()
  selector = selectors.DefaultSelector()
  assert process.stdout is not None
  selector.register(process.stdout, selectors.EVENT_READ)
  try:
    while selector.get_map():
      timeout = min(_remaining(deadline), 0.1)
      for key, _ in selector.select(timeout):
        chunk = os.read(key.fd, 8192)
        if not chunk:
          selector.unregister(key.fileobj)
          continue
        if len(output) + len(chunk) > _MAX_PROCESS_OUTPUT_BYTES:
          _kill_process(process)
          raise TranscriptionError(
              'normalization_output_limit', 502, 'Audio processing failed'
          )
        output.extend(chunk)
      if process.poll() is not None and not selector.get_map():
        break
    try:
      process.wait(timeout=_remaining(deadline))
    except subprocess.TimeoutExpired as exc:
      _kill_process(process)
      raise TranscriptionError(
          'normalization_timeout', 504, 'Audio processing timed out'
      ) from exc
    return subprocess.CompletedProcess(
        command, process.returncode, bytes(output), b''
    )
  except TranscriptionError:
    raise
  except (OSError, ValueError) as exc:
    _kill_process(process)
    raise TranscriptionError(
        'normalization_failed', 502, 'Audio processing failed'
    ) from exc
  finally:
    selector.close()
    _kill_process(process)
    if process.stdout is not None:
      process.stdout.close()


def _probe(path: str, demuxer: str, deadline: float) -> dict[str, Any]:
  ffprobe = shutil.which('ffprobe') or 'ffprobe'
  result = _run(
      [
          ffprobe,
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-threads',
          '1',
          '-f',
          demuxer,
          '-show_entries',
          'format=duration,format_name:stream=codec_type,codec_name',
          '-of',
          'json',
          path,
      ],
      deadline,
  )
  if result.returncode != 0:
    raise TranscriptionError('invalid_audio', 422, 'Audio could not be decoded')
  try:
    probe = json.loads(result.stdout.decode('utf-8'))
  except (UnicodeDecodeError, json.JSONDecodeError) as exc:
    raise TranscriptionError(
        'invalid_audio', 422, 'Audio could not be decoded'
    ) from exc
  if not isinstance(probe, dict):
    raise TranscriptionError('invalid_audio', 422, 'Audio could not be decoded')
  return probe


def _is_allowed_media(probe: dict[str, Any]) -> bool:
  format_info = probe.get('format')
  streams = probe.get('streams')
  if not isinstance(format_info, dict) or not isinstance(streams, list):
    return False
  format_names = set(str(format_info.get('format_name', '')).split(','))
  audio_streams = [
      stream for stream in streams
      if isinstance(stream, dict) and stream.get('codec_type') == 'audio'
  ]
  if len(audio_streams) != 1:
    return False
  if any(
      isinstance(stream, dict) and stream.get('codec_type') == 'video'
      for stream in streams
  ):
    return False
  codec = audio_streams[0].get('codec_name')
  if not isinstance(codec, str):
    return False
  if 'webm' in format_names:
    return codec == 'opus'
  if 'ogg' in format_names:
    return codec == 'opus'
  if format_names.intersection({'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'}):
    return codec == 'aac'
  if 'wav' in format_names:
    return codec.startswith('pcm_')
  return False


def normalize(audio_bytes: bytes) -> bytes:
  """Validates and normalizes one bounded audio recording to WAV bytes."""
  if len(audio_bytes) > MAX_AUDIO_BYTES:
    raise TranscriptionError('audio_too_large', 413, 'Audio is too large')
  if not audio_bytes:
    raise TranscriptionError('invalid_audio', 422, 'Audio could not be decoded')

  if audio_bytes.startswith(b'RIFF') and audio_bytes[8:12] == b'WAVE':
    demuxer = 'wav'
  elif audio_bytes.startswith(b'OggS'):
    demuxer = 'ogg'
  elif audio_bytes.startswith(b'\x1a\x45\xdf\xa3'):
    demuxer = 'matroska'
  elif len(audio_bytes) >= 12 and audio_bytes[4:8] == b'ftyp':
    demuxer = 'mp4'
  else:
    raise TranscriptionError(
        'unsupported_media', 415, 'Audio format is not supported'
    )

  deadline = time.monotonic() + SUBPROCESS_DEADLINE_SECONDS
  with tempfile.TemporaryDirectory(prefix='scene-machine-dictation-') as workdir:
    input_path = os.path.join(workdir, 'input.bin')
    output_path = os.path.join(workdir, 'output.wav')
    with open(input_path, 'wb') as file:
      file.write(audio_bytes)

    probe = _probe(input_path, demuxer, deadline)
    if not _is_allowed_media(probe):
      raise TranscriptionError(
          'unsupported_media', 415, 'Audio format is not supported'
      )
    duration_value = probe.get('format', {}).get('duration')
    try:
      duration = float(duration_value)
    except (TypeError, ValueError):
      duration = None
    if duration is not None and duration > MAX_DURATION_SECONDS:
      raise TranscriptionError('audio_too_long', 422, 'Audio is too long')

    ffmpeg = shutil.which('ffmpeg') or 'ffmpeg'
    result = _run(
        [
            ffmpeg,
            '-v',
            'error',
            '-nostdin',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            demuxer,
            '-y',
            '-threads',
            '1',
            '-i',
            input_path,
            '-map',
            '0:a:0',
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-sample_fmt',
            's16',
            '-t',
            str(MAX_DURATION_SECONDS + 0.25),
            '-f',
            'wav',
            output_path,
        ],
        deadline,
    )
    if result.returncode != 0 or not os.path.isfile(output_path):
      raise TranscriptionError(
          'invalid_audio', 422, 'Audio could not be decoded'
      )
    output_size = os.path.getsize(output_path)
    if output_size > _MAX_WAV_BYTES:
      raise TranscriptionError('audio_too_long', 422, 'Audio is too long')
    try:
      with open(output_path, 'rb') as file:
        normalized = file.read(_MAX_WAV_BYTES + 1)
    except OSError as exc:
      raise TranscriptionError(
          'invalid_audio', 422, 'Audio could not be decoded'
      ) from exc
    if len(normalized) > _MAX_WAV_BYTES:
      raise TranscriptionError('audio_too_long', 422, 'Audio is too long')
    try:
      with wave.open(io.BytesIO(normalized), 'rb') as wav_file:
        if (
            wav_file.getnchannels() != 1
            or wav_file.getsampwidth() != 2
            or wav_file.getframerate() != 16_000
        ):
          raise TranscriptionError(
              'invalid_audio', 422, 'Audio could not be decoded'
          )
        if wav_file.getnframes() <= 0:
          raise TranscriptionError(
              'invalid_audio', 422, 'Audio could not be decoded'
          )
        if wav_file.getnframes() > MAX_DURATION_SECONDS * 16_000:
          raise TranscriptionError('audio_too_long', 422, 'Audio is too long')
    except (EOFError, wave.Error) as exc:
      raise TranscriptionError(
          'invalid_audio', 422, 'Audio could not be decoded'
      ) from exc
    return normalized


def _client(project: str) -> genai.Client:
  return genai.Client(
      vertexai=True,
      project=project,
      location=LOCATION,
      http_options=types.HttpOptions(
          timeout=PROVIDER_TIMEOUT_MILLISECONDS,
          retry_options=types.HttpRetryOptions(attempts=1),
      ),
  )


def _response_parts(response: Any) -> list[Any]:
  candidates = getattr(response, 'candidates', None)
  if candidates is None:
    raise TranscriptionError(
        'malformed_provider_response', 502, 'Transcription response was invalid'
    )
  if not isinstance(candidates, (list, tuple)):
    raise TranscriptionError(
        'malformed_provider_response', 502, 'Transcription response was invalid'
    )
  if not candidates:
    return []
  content = getattr(candidates[0], 'content', None)
  if content is None:
    if _prompt_block_reason(response) is not None:
      raise TranscriptionError(
          'provider_blocked', 502, 'Transcription was blocked'
      )
    if _is_completed_empty(response, candidates[0]):
      return []
    raise TranscriptionError(
        'malformed_provider_response', 502, 'Transcription response was invalid'
    )
  parts = getattr(content, 'parts', None)
  if parts is None or not isinstance(parts, (list, tuple)):
    raise TranscriptionError(
        'malformed_provider_response', 502, 'Transcription response was invalid'
    )
  return list(parts)


def parse_response(response: Any) -> str:
  """Returns non-thought transcript text from the first candidate's parts."""
  values = []
  for part in _response_parts(response):
    if getattr(part, 'thought', False):
      continue
    text = getattr(part, 'text', None)
    audio_transcription = getattr(part, 'audio_transcription', None)
    audio_text = getattr(audio_transcription, 'text', None)
    value = text if isinstance(text, str) and text.strip() else audio_text
    if isinstance(value, str) and value.strip():
      values.append(value.strip())
  return ' '.join(values)


def transcribe(audio_wav: bytes, project: str) -> str:
  """Makes exactly one VERBATIM Gemini transcription request."""
  if not project:
    raise TranscriptionError(
        'provider_not_configured', 503, 'Transcription is not configured'
    )
  client = _client(project)
  try:
    try:
      response = client.models.generate_content(
          model=MODEL,
          contents=[
              types.Part.from_bytes(data=audio_wav, mime_type='audio/wav')
          ],
          config=types.GenerateContentConfig(
              audio_transcription_config=types.AudioTranscriptionConfig(
                  mode='VERBATIM'
              )
          ),
      )
    except Exception as exc:  # pylint: disable=broad-except
      status = getattr(exc, 'status_code', None)
      if status is None:
        status = getattr(exc, 'code', None)
      if status == 429:
        raise TranscriptionError(
            'provider_quota', 429, 'Transcription is temporarily unavailable'
        ) from exc
      if (
          isinstance(exc, (TimeoutError, httpx.TimeoutException))
          or type(exc).__name__ in ('APITimeoutError', 'DeadlineExceeded')
      ):
        raise TranscriptionError(
            'provider_timeout', 504, 'Transcription timed out'
        ) from exc
      raise TranscriptionError(
          'provider_error', 502, 'Transcription failed'
      ) from exc
    return parse_response(response)
  finally:
    close = getattr(client, 'close', None)
    if close is not None:
      try:
        close()
      except Exception:  # pylint: disable=broad-except
        pass


def transcribe_recording(audio_bytes: bytes, project: str) -> str:
  """Normalizes and transcribes one recording under the local admission cap."""
  if not _ADMISSION.acquire(blocking=False):
    raise TranscriptionError(
        'admission_busy', 429, 'Transcription is temporarily busy'
    )
  try:
    return transcribe(normalize(audio_bytes), project)
  finally:
    _ADMISSION.release()
