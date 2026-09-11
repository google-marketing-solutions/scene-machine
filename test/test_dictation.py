# Copyright 2026 Google LLC

"""Vertical tests for the bounded dictation front-door route."""

import io
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import types
import wave

import httpx
import pytest
from google.genai import types as genai_types
from werkzeug.datastructures import MultiDict

from test.test_frontdoor import _load_orch
from test.test_frontdoor import orchestrator_module  # noqa: F401
from test.test_frontdoor_data import _load_app
from util import model_allowlist


def _wav(seconds=0.1):
  frames = b'\x00\x00' * int(16_000 * seconds)
  output = io.BytesIO()
  with wave.open(output, 'wb') as wav_file:
    wav_file.setnchannels(1)
    wav_file.setsampwidth(2)
    wav_file.setframerate(16_000)
    wav_file.writeframes(frames)
  return output.getvalue()


class _FakeClient:

  def __init__(self, response):
    self.response = response
    self.models = types.SimpleNamespace(
        generate_content=self._generate_content
    )
    self.calls = []
    self.closed = False

  def close(self):
    self.closed = True

  def _generate_content(self, **kwargs):
    self.calls.append(kwargs)
    return self.response


def _response(*parts):
  return types.SimpleNamespace(
      candidates=[
          types.SimpleNamespace(
              content=types.SimpleNamespace(parts=list(parts))
          )
      ]
  )


def _part(text=None, *, thought=False, audio_text=None):
  return types.SimpleNamespace(
      text=text,
      thought=thought,
      audio_transcription=(
          types.SimpleNamespace(text=audio_text) if audio_text is not None else None
      ),
  )


def _load_enabled(monkeypatch):
  monkeypatch.setenv('DICTATION_ENABLED', 'true')
  orch = _load_orch(monkeypatch, ROLE='all')
  orch.config['gcpProject'] = 'dictation-test-project'
  return orch


def test_route_normalizes_real_wav_and_sends_audio_only_to_gemini(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.delenv('DICTATION_MODE', raising=False)
  orch = _load_enabled(monkeypatch)
  fake_client = _FakeClient(_response(_part(text='hello world')))
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 200
  assert response.get_json() == {'text': 'hello world'}
  assert response.headers['Cache-Control'] == 'no-store'
  call = fake_client.calls[0]
  assert call['model'] == 'gemini-3.5-transcribe-preview'
  assert len(call['contents']) == 1
  assert call['contents'][0].inline_data.mime_type == 'audio/wav'
  assert call['config'].audio_transcription_config.mode.value == 'SMART'
  assert call['config'].system_instruction is None
  assert fake_client.closed


def test_explicit_verbatim_mode_is_sent_to_gemini(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.setenv('DICTATION_MODE', 'VERBATIM')
  orch = _load_enabled(monkeypatch)
  fake_client = _FakeClient(_response(_part(text='verbatim mode')))
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 200
  assert fake_client.calls[0]['config'].audio_transcription_config.mode.value == 'VERBATIM'
  assert fake_client.closed


@pytest.mark.parametrize('value', ['', 'smart', 'OTHER'])
def test_invalid_dictation_mode_rejects_before_provider(
    monkeypatch, orchestrator_module, value
):
  del orchestrator_module
  monkeypatch.setenv('DICTATION_MODE', value)
  orch = _load_enabled(monkeypatch)
  monkeypatch.setattr(
      orch.transcription.genai,
      'Client',
      lambda **_: pytest.fail('provider client must not be constructed'),
  )
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 503
  assert response.get_json() == {
      'error': 'Transcription mode is not configured',
      'code': 'invalid_dictation_mode',
  }
  assert response.headers['Cache-Control'] == 'no-store'


def test_provider_parser_deduplicates_nonthought_parts_and_allows_empty(
    orchestrator_module
):
  del orchestrator_module
  from transcription import parse_response
  assert parse_response(
      _response(
          _part(text='think', thought=True),
          _part(text='hello'),
          _part(text='hello', audio_text='hello'),
          _part(audio_text='world'),
      )
  ) == 'hello hello world'
  assert parse_response(_response()) == ''


def test_missing_flag_enables_valid_transcription_request(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.delenv('DICTATION_ENABLED', raising=False)
  orch = _load_orch(monkeypatch, ROLE='all')
  orch.config['gcpProject'] = 'dictation-test-project'
  fake_client = _FakeClient(_response(_part(text='default enabled')))
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 200
  assert response.get_json() == {'text': 'default enabled'}
  assert fake_client.calls


@pytest.mark.parametrize('value', ['', '2', 'unexpected'])
def test_invalid_flag_fails_closed(monkeypatch, value):
  import transcription
  monkeypatch.setenv('DICTATION_ENABLED', value)
  assert transcription.enabled() is False


def test_malformed_provider_response_is_safe_502(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  fake_client = _FakeClient(types.SimpleNamespace(candidates=None))
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 502
  assert response.get_json() == {
      'error': 'Transcription response was invalid',
      'code': 'malformed_provider_response',
  }
  assert fake_client.closed


def test_completed_stop_without_content_is_valid_empty_transcript(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = genai_types.GenerateContentResponse(
      candidates=[genai_types.Candidate(finish_reason='STOP', content=None)]
  )
  fake_client = _FakeClient(response)
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  result = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert result.status_code == 200
  assert result.get_json() == {'text': ''}
  assert fake_client.closed


def test_non_stop_without_content_remains_malformed_502(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = genai_types.GenerateContentResponse(
      candidates=[genai_types.Candidate(finish_reason='MAX_TOKENS', content=None)]
  )
  fake_client = _FakeClient(response)
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  result = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert result.status_code == 502
  assert result.get_json()['code'] == 'malformed_provider_response'
  assert fake_client.closed


def test_blocked_without_content_remains_distinct_502(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = genai_types.GenerateContentResponse(
      candidates=[genai_types.Candidate(finish_reason='STOP', content=None)],
      prompt_feedback=genai_types.GenerateContentResponsePromptFeedback(
          block_reason='SAFETY'
      ),
  )
  fake_client = _FakeClient(response)
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  result = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert result.status_code == 502
  assert result.get_json()['code'] == 'provider_blocked'
  assert fake_client.closed


def test_prompt_feedback_block_with_no_candidates_is_safe_502(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = types.SimpleNamespace(
      candidates=[],
      prompt_feedback=types.SimpleNamespace(block_reason='SAFETY'),
  )
  fake_client = _FakeClient(response)
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  result = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert result.status_code == 502
  assert result.get_json()['code'] == 'provider_blocked'
  assert fake_client.closed


def test_prompt_feedback_block_with_missing_candidates_is_safe_502(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = types.SimpleNamespace(
      candidates=None,
      prompt_feedback=types.SimpleNamespace(block_reason='SAFETY'),
  )
  fake_client = _FakeClient(response)
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  result = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert result.status_code == 502
  assert result.get_json()['code'] == 'provider_blocked'
  assert fake_client.closed


def test_prompt_feedback_block_wins_over_stop_content():
  from transcription import TranscriptionError, parse_response

  response = genai_types.GenerateContentResponse(
      candidates=[
          genai_types.Candidate(
              finish_reason='STOP',
              content=genai_types.Content(
                  parts=[genai_types.Part(text='blocked content')]
              ),
          )
      ],
      prompt_feedback=genai_types.GenerateContentResponsePromptFeedback(
          block_reason='SAFETY'
      ),
  )
  with pytest.raises(TranscriptionError) as error:
    parse_response(response)
  assert error.value.code == 'provider_blocked'


@pytest.mark.parametrize(
    'finish_reason', ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']
)
@pytest.mark.parametrize('with_content', [False, True])
def test_blocked_finish_reason_is_safe_even_with_content(
    finish_reason, with_content
):
  from transcription import TranscriptionError, parse_response

  content = types.SimpleNamespace(parts=[_part(text='blocked')]) if with_content else None
  response = types.SimpleNamespace(
      candidates=[
          types.SimpleNamespace(finish_reason=finish_reason, content=content)
      ]
  )
  with pytest.raises(TranscriptionError) as error:
    parse_response(response)
  assert error.value.code == 'provider_blocked'


def test_explicit_zero_disables_route_before_parse_or_provider(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.setenv('DICTATION_ENABLED', '0')
  orch = _load_orch(monkeypatch, ROLE='all')
  monkeypatch.setattr(
      orch.transcription, 'transcribe_recording',
      lambda *_: pytest.fail('provider must not be called'),
  )
  response = orch.app.test_client().post('/api/transcribe', data=b'not multipart')
  assert response.status_code == 503
  assert response.get_json()['code'] == 'dictation_disabled'


def test_explicit_zero_advertises_disabled_capability(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.setenv('DICTATION_ENABLED', '0')
  orch, fake_db, _ = _load_app(monkeypatch)
  fake_db.collection('config').docs['global'] = {'gcpProject': 'project'}
  monkeypatch.setattr(
      model_allowlist,
      '_fetch_live_catalog',
      lambda: model_allowlist.load_shipped_allowlist(),
  )
  payload = orch.app.test_client().get('/api/config').get_json()
  assert payload['dictation']['enabled'] is False


def test_worker_has_no_transcription_route(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='worker')
  assert '/api/transcribe' not in {
      rule.rule for rule in orch.app.url_map.iter_rules()
  }


def test_iap_auth_failure_is_dictation_safe_and_noncacheable(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  monkeypatch.setenv('DICTATION_ENABLED', 'true')
  orch = _load_orch(
      monkeypatch,
      ROLE='app',
      AUTH_MODE='iap',
      WORKER_URL='https://worker-test.a.run.app',
      IAP_AUDIENCE='/projects/123/locations/global/services/app',
  )
  response = orch.app.test_client().post('/api/transcribe')
  assert response.status_code == 401
  assert response.get_json()['code'] == 'unauthorized'
  assert response.headers['Cache-Control'] == 'no-store'
  other = orch.app.test_client().get('/api/config')
  assert other.status_code == 401
  assert 'code' not in other.get_json()


def test_rejects_extra_form_field_before_provider(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  monkeypatch.setattr(
      orch.transcription, 'transcribe_recording',
      lambda *_: pytest.fail('provider must not be called'),
  )
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={
          'audio': (io.BytesIO(_wav()), 'voice.wav'),
          'extra': 'nope',
      },
      content_type='multipart/form-data',
  )
  assert response.status_code == 400
  assert response.get_json()['code'] == 'unexpected_form_field'


def test_rejects_audio_over_limit(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(b'x' * (4 * 1024 * 1024 + 1)), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 413
  assert response.get_json()['code'] in ('request_too_large', 'audio_too_large')


def test_real_decoder_rejects_recording_over_120_seconds(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav(120.1)), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 422
  assert response.get_json()['code'] == 'audio_too_long'


def test_provider_deadline_is_safe_504(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)

  class _TimeoutClient(_FakeClient):

    def _generate_content(self, **_kwargs):
      raise TimeoutError('provider deadline')

  monkeypatch.setattr(
      orch.transcription.genai,
      'Client',
      lambda **_: _TimeoutClient(_response()),
  )
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 504
  assert response.get_json()['code'] == 'provider_timeout'


def test_httpx_provider_timeout_is_safe_504_and_closes_client(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)

  class _HttpxTimeoutClient(_FakeClient):

    def _generate_content(self, **_kwargs):
      raise httpx.ReadTimeout('provider deadline')

  fake_client = _HttpxTimeoutClient(_response())
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 504
  assert response.get_json()['code'] == 'provider_timeout'
  assert fake_client.closed


def test_provider_quota_is_safe_429_and_closes_client(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)

  class _QuotaError(Exception):
    status_code = 429

  class _QuotaClient(_FakeClient):

    def _generate_content(self, **_kwargs):
      raise _QuotaError('quota')

  fake_client = _QuotaClient(_response())
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert response.status_code == 429
  assert response.get_json()['code'] == 'provider_quota'
  assert fake_client.closed


def test_missing_and_duplicate_audio_parts_are_rejected(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  client = orch.app.test_client()
  missing = client.post(
      '/api/transcribe', data={}, content_type='multipart/form-data'
  )
  assert missing.status_code == 400
  assert missing.get_json()['code'] == 'invalid_multipart'
  duplicate = client.post(
      '/api/transcribe',
      data=MultiDict([
          ('audio', (io.BytesIO(_wav()), 'one.wav')),
          ('audio', (io.BytesIO(_wav()), 'two.wav')),
      ]),
      content_type='multipart/form-data',
  )
  assert duplicate.status_code == 400
  assert duplicate.get_json()['code'] == 'invalid_multipart'


def test_parser_count_and_malformed_multipart_errors_are_safe(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  client = orch.app.test_client()
  too_many_parts = client.post(
      '/api/transcribe',
      data=MultiDict([
          ('audio', (io.BytesIO(_wav()), 'one.wav')),
          ('audio', (io.BytesIO(_wav()), 'two.wav')),
          ('extra', 'field'),
      ]),
      content_type='multipart/form-data',
  )
  assert too_many_parts.status_code == 413
  assert too_many_parts.get_json()['code'] == 'request_too_large'
  malformed = client.post(
      '/api/transcribe',
      data=b'not a multipart body',
      content_type='multipart/form-data; boundary=missing',
  )
  assert malformed.status_code == 400
  assert malformed.get_json()['code'] == 'invalid_multipart'


def test_mime_label_is_untrusted_but_video_stream_is_rejected(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_enabled(monkeypatch)
  fake_client = _FakeClient(_response(_part(text='wav despite label')))
  monkeypatch.setattr(orch.transcription.genai, 'Client', lambda **_: fake_client)
  wav_response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(_wav()), 'voice.mp4')},
      content_type='multipart/form-data',
  )
  assert wav_response.status_code == 200
  video_path = (
      pathlib.Path(__file__).parents[1]
      / 'workflow_examples/input/GenericOutro.mp4'
  )
  video_response = orch.app.test_client().post(
      '/api/transcribe',
      data={'audio': (io.BytesIO(video_path.read_bytes()), 'voice.wav')},
      content_type='multipart/form-data',
  )
  assert video_response.status_code == 415
  assert video_response.get_json()['code'] == 'unsupported_media'


def test_admission_is_nonblocking_and_released_after_provider_error(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  import transcription

  held = [transcription._ADMISSION.acquire(blocking=False) for _ in range(2)]
  assert all(held)
  try:
    with pytest.raises(transcription.TranscriptionError) as busy:
      transcription.transcribe_recording(b'ignored', 'project')
    assert busy.value.code == 'admission_busy'
  finally:
    transcription._ADMISSION.release()
    transcription._ADMISSION.release()

  monkeypatch.setattr(transcription, 'normalize', lambda _audio: b'wav')

  def fail(_audio, _project):
    raise transcription.TranscriptionError('provider_error', 502, 'failed')

  monkeypatch.setattr(transcription, 'transcribe', fail)
  with pytest.raises(transcription.TranscriptionError):
    transcription.transcribe_recording(b'ignored', 'project')
  assert transcription._ADMISSION.acquire(blocking=False)
  transcription._ADMISSION.release()


def test_media_process_deadline_covers_child_after_stdout_eof():
  import transcription

  started = time.monotonic()
  with pytest.raises(transcription.TranscriptionError) as timeout:
    transcription._run(
        [
            sys.executable,
            '-c',
            'import sys,time; sys.stdout.close(); time.sleep(2)',
        ],
        time.monotonic() + 0.05,
    )
  assert timeout.value.code == 'normalization_timeout'
  assert time.monotonic() - started < 1


@pytest.mark.parametrize(
    ('container', 'codec', 'extension'),
    (
        ('webm', 'libopus', '.webm'),
        ('ogg', 'libopus', '.ogg'),
        ('mp4', 'aac', '.mp4'),
    ),
)
def test_real_browser_audio_containers_normalize_without_cloud(
    container, codec, extension
):
  import transcription

  ffmpeg = shutil.which('ffmpeg')
  assert ffmpeg, 'ffmpeg is required for dictation normalization'
  with tempfile.TemporaryDirectory(prefix='dictation-fixture-') as workdir:
    input_path = pathlib.Path(workdir) / 'input.wav'
    output_path = pathlib.Path(workdir) / f'output{extension}'
    input_path.write_bytes(_wav())
    subprocess.run(
        [
            ffmpeg,
            '-v',
            'error',
            '-y',
            '-i',
            str(input_path),
            '-c:a',
            codec,
            '-f',
            container,
            str(output_path),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    normalized = transcription.normalize(output_path.read_bytes())
    with wave.open(io.BytesIO(normalized), 'rb') as wav_file:
      assert wav_file.getnchannels() == 1
      assert wav_file.getsampwidth() == 2
      assert wav_file.getframerate() == 16_000
      assert wav_file.getnframes() > 0


@pytest.mark.parametrize('flag, expected', [(None, True), ('1', True)])
def test_config_exposes_only_nonsecret_dictation_capability(
    monkeypatch, orchestrator_module, flag, expected
):
  del orchestrator_module
  if flag is None:
    monkeypatch.delenv('DICTATION_ENABLED', raising=False)
  else:
    monkeypatch.setenv('DICTATION_ENABLED', flag)
  orch, fake_db, _ = _load_app(monkeypatch)
  fake_db.collection('config').docs['global'] = {'gcpProject': 'project'}
  monkeypatch.setattr(
      model_allowlist,
      '_fetch_live_catalog',
      lambda: model_allowlist.load_shipped_allowlist(),
  )
  payload = orch.app.test_client().get('/api/config').get_json()
  assert payload['dictation'] == {
      'enabled': expected,
      'maxAudioBytes': 4 * 1024 * 1024,
      'maxDurationSeconds': 120,
      'mimeTypes': [
          'audio/webm;codecs=opus',
          'audio/mp4',
          'audio/ogg;codecs=opus',
          'audio/wav',
      ],
  }
