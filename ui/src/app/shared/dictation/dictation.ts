/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {HttpClient} from '@angular/common/http';
import {inject, Injectable, signal} from '@angular/core';
import {NavigationStart, Router} from '@angular/router';
import {filter, Subscription, timeout} from 'rxjs';

export const DICTATION_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/wav',
] as const;

export const DICTATION_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const DICTATION_REQUEST_TIMEOUT_MS = 70_000;
export const DICTATION_SERVER_MAX_DURATION_SECONDS = 120;
// Leave one second for the 250 ms timer, recorder stop dispatch, and final
// dataavailable chunk. This is a foreground-timing margin, not a guarantee
// against arbitrarily delayed background-tab timers.
export const DICTATION_DURATION_HEADROOM_SECONDS = 1;
export const DICTATION_CLIENT_MAX_DURATION_SECONDS =
  DICTATION_SERVER_MAX_DURATION_SECONDS - DICTATION_DURATION_HEADROOM_SECONDS;

export interface DictationConfig {
  enabled: boolean;
  maxAudioBytes: number;
  maxDurationSeconds: number;
  mimeTypes: readonly string[];
}

export type DictationStatus =
  | 'idle'
  | 'permission'
  | 'recording'
  | 'transcribing'
  | 'complete'
  | 'overflow'
  | 'error';

export interface DictationState {
  status: DictationStatus;
  owner?: string;
  elapsedSeconds: number;
  transcript?: string;
  error?: string;
  code?: string;
  eventId: number;
}

interface TranscriptionResponse {
  text?: unknown;
}

/**
 * Owns the one microphone session allowed in a browser tab.
 *
 * The UI deliberately does not select a provider or add fields to the
 * multipart request. The server's configured Gemini Transcribe adapter is the
 * only model boundary.
 */
@Injectable({providedIn: 'root'})
export class DictationService {
  readonly state = signal<DictationState>({
    status: 'idle',
    elapsedSeconds: 0,
    eventId: 0,
  });

  private readonly httpClient: HttpClient;
  private activeOwner: string | undefined;
  private activeToken = 0;
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: BlobPart[] = [];
  private encodedBytes = 0;
  private recordingTooLarge = false;
  private recordingFailed = false;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private upload: Subscription | undefined;
  private maxAudioBytes = DICTATION_MAX_AUDIO_BYTES;
  private maxDurationSeconds = DICTATION_CLIENT_MAX_DURATION_SECONDS;
  private mimeTypes: readonly string[] = DICTATION_MIME_TYPES;
  private eventId = 0;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
    const router = inject(Router, {optional: true});
    router?.events
      .pipe(filter(event => event instanceof NavigationStart))
      .subscribe(() => {
        if (this.activeOwner) {
          this.cancel(this.activeOwner);
        } else if (this.state().owner) {
          this.setState({
            status: 'idle',
            owner: this.state().owner,
            elapsedSeconds: 0,
          });
        }
      });
  }

  start(owner: string, config: DictationConfig): void {
    if (!config.enabled || this.activeOwner !== undefined) {
      return;
    }
    this.activeOwner = owner;
    const token = ++this.activeToken;
    this.maxAudioBytes = config.maxAudioBytes;
    this.maxDurationSeconds = Math.min(
      config.maxDurationSeconds,
      DICTATION_CLIENT_MAX_DURATION_SECONDS,
    );
    this.mimeTypes = config.mimeTypes;
    this.chunks = [];
    this.encodedBytes = 0;
    this.recordingTooLarge = false;
    this.recordingFailed = false;
    this.setState({status: 'permission', owner, elapsedSeconds: 0});

    if (!navigator.mediaDevices?.getUserMedia) {
      this.releaseActive(owner);
      this.setState({
        status: 'error',
        owner,
        elapsedSeconds: 0,
        error: 'This browser does not provide microphone access.',
        code: 'unsupported',
      });
      return;
    }

    void navigator.mediaDevices
      .getUserMedia({audio: true})
      .then(stream => {
        if (token !== this.activeToken || this.activeOwner !== owner) {
          this.stopTracks(stream);
          return;
        }
        this.stream = stream;
        const mimeType = this.supportedMimeType();
        if (!mimeType) {
          this.stopTracks(stream);
          this.releaseActive(owner);
          this.setState({
            status: 'error',
            owner,
            elapsedSeconds: 0,
            error: 'This browser does not support an allowed audio format.',
            code: 'unsupported_format',
          });
          return;
        }
        try {
          this.recorder = new MediaRecorder(stream, {mimeType});
          this.recorder.ondataavailable = event =>
            this.collectChunk(event.data);
          this.recorder.onerror = () =>
            this.fail(
              'Recording failed. Please try again.',
              'recording_failed',
            );
          this.recorder.onstop = () => this.finishRecording(token, owner);
          this.recorder.start(250);
        } catch {
          this.fail('This browser cannot record audio.', 'unsupported');
          return;
        }
        this.startedAt = Date.now();
        this.setState({status: 'recording', owner, elapsedSeconds: 0});
        this.timer = setInterval(() => this.updateTimer(token, owner), 250);
      })
      .catch(error => {
        if (token !== this.activeToken || this.activeOwner !== owner) return;
        const code =
          error?.name === 'NotAllowedError' ? 'permission' : 'microphone';
        this.fail(
          code === 'permission'
            ? 'Microphone permission was not granted.'
            : 'Microphone could not be started.',
          code,
        );
      });
  }

  stop(owner: string): void {
    if (this.activeOwner !== owner) return;
    if (!this.recorder) {
      this.cancel(owner);
      return;
    }
    if (this.recorder.state === 'recording') {
      this.clearTimer();
      this.setState({
        status: 'transcribing',
        owner,
        elapsedSeconds: this.elapsedSeconds(),
      });
      this.recorder.stop();
    }
  }

  cancel(owner: string): void {
    if (this.activeOwner !== owner) return;
    ++this.activeToken;
    this.upload?.unsubscribe();
    this.upload = undefined;
    const recorder = this.recorder;
    this.recorder = undefined;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.stopTracks(this.stream);
    this.stream = undefined;
    this.clearTimer();
    this.activeOwner = undefined;
    this.chunks = [];
    this.encodedBytes = 0;
    this.recordingTooLarge = false;
    this.recordingFailed = false;
    this.setState({status: 'idle', elapsedSeconds: 0});
  }

  dismiss(owner: string): void {
    if (this.activeOwner === owner) this.cancel(owner);
    else if (this.state().owner === owner)
      this.setState({status: 'idle', elapsedSeconds: 0});
  }

  private supportedMimeType(): string | undefined {
    if (
      typeof MediaRecorder === 'undefined' ||
      typeof MediaRecorder.isTypeSupported !== 'function'
    ) {
      return undefined;
    }
    return this.mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
  }

  private collectChunk(chunk: Blob): void {
    if (!chunk.size) return;
    this.encodedBytes += chunk.size;
    if (this.encodedBytes > this.maxAudioBytes) {
      this.recordingTooLarge = true;
      this.clearTimer();
      this.setState({
        status: 'overflow',
        owner: this.activeOwner,
        elapsedSeconds: this.elapsedSeconds(),
        error: 'Recording exceeded the 4 MiB audio limit.',
        code: 'audio_too_large',
      });
      const recorder = this.recorder;
      if (recorder?.state === 'recording') recorder.stop();
      return;
    }
    this.chunks.push(chunk);
  }

  private updateTimer(token: number, owner: string): void {
    if (token !== this.activeToken || this.activeOwner !== owner) return;
    const elapsed = this.elapsedSeconds();
    this.setState({status: 'recording', owner, elapsedSeconds: elapsed});
    if (elapsed >= this.maxDurationSeconds) this.stop(owner);
  }

  private elapsedSeconds(): number {
    return this.startedAt
      ? Math.min(this.maxDurationSeconds, (Date.now() - this.startedAt) / 1000)
      : 0;
  }

  private finishRecording(token: number, owner: string): void {
    if (token !== this.activeToken || this.activeOwner !== owner) return;
    this.clearTimer();
    const stream = this.stream;
    this.stream = undefined;
    this.stopTracks(stream);
    this.recorder = undefined;
    if (
      this.recordingTooLarge ||
      this.recordingFailed ||
      this.encodedBytes > this.maxAudioBytes ||
      this.chunks.length === 0
    ) {
      const failed = this.recordingFailed;
      const tooLarge =
        this.recordingTooLarge || this.encodedBytes > this.maxAudioBytes;
      const error = tooLarge
        ? 'Recording exceeded the 4 MiB audio limit.'
        : failed
          ? 'Recording failed. Please try again.'
          : 'No audio was recorded.';
      const code = tooLarge
        ? 'audio_too_large'
        : failed
          ? 'recording_failed'
          : 'empty_recording';
      const elapsedSeconds = this.elapsedSeconds();
      this.releaseActive(owner);
      this.setState({
        status: tooLarge ? 'overflow' : 'error',
        owner,
        elapsedSeconds,
        error,
        code,
      });
      return;
    }
    const type =
      this.chunks[0] instanceof Blob ? (this.chunks[0] as Blob).type : '';
    const blob = new Blob(this.chunks, {type});
    this.chunks = [];
    if (blob.size > this.maxAudioBytes) {
      this.releaseActive(owner);
      this.setState({
        status: 'overflow',
        owner,
        elapsedSeconds: this.elapsedSeconds(),
      });
      return;
    }
    this.postBlob(blob, owner, token);
  }

  private postBlob(blob: Blob, owner: string, token: number): void {
    const form = new FormData();
    form.append('audio', blob, this.filename(blob.type));
    this.upload = this.httpClient
      .post<TranscriptionResponse>('/api/transcribe', form)
      .pipe(timeout({each: DICTATION_REQUEST_TIMEOUT_MS}))
      .subscribe({
        next: response => {
          if (token !== this.activeToken || this.activeOwner !== owner) return;
          if (typeof response.text !== 'string') {
            this.releaseActive(owner);
            this.setState({
              status: 'error',
              owner,
              elapsedSeconds: 0,
              error: 'Transcription returned an invalid response.',
              code: 'bad_response',
            });
            return;
          }
          this.setState({
            status: 'complete',
            owner,
            elapsedSeconds: this.elapsedSeconds(),
            transcript: response.text,
          });
          this.releaseActive(owner);
        },
        error: error => {
          if (token !== this.activeToken || this.activeOwner !== owner) return;
          const code =
            error?.name === 'TimeoutError' ? 'timeout' : 'transcription_failed';
          this.releaseActive(owner);
          this.setState({
            status: 'error',
            owner,
            elapsedSeconds: 0,
            error:
              code === 'timeout'
                ? 'Transcription timed out. Please try again.'
                : 'Transcription failed. Please try again.',
            code,
          });
        },
      });
  }

  private filename(type: string): string {
    if (type.includes('mp4')) return 'recording.mp4';
    if (type.includes('ogg')) return 'recording.ogg';
    if (type.includes('wav')) return 'recording.wav';
    return 'recording.webm';
  }

  private fail(message: string, code: string): void {
    const owner = this.activeOwner;
    if (!owner) return;
    this.recordingFailed = true;
    const recorder = this.recorder;
    this.clearTimer();
    this.setState({
      status: 'error',
      owner,
      elapsedSeconds: this.elapsedSeconds(),
      error: message,
      code,
    });
    if (recorder?.state === 'recording') recorder.stop();
    else {
      this.stopTracks(this.stream);
      this.releaseActive(owner);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private stopTracks(stream: MediaStream | undefined): void {
    stream?.getTracks().forEach(track => track.stop());
  }

  private releaseActive(owner: string): void {
    if (this.activeOwner !== owner) return;
    this.upload = undefined;
    this.activeOwner = undefined;
    this.stream = undefined;
    this.recorder = undefined;
    this.clearTimer();
    this.chunks = [];
    this.encodedBytes = 0;
    this.recordingTooLarge = false;
    this.recordingFailed = false;
  }

  private setState(next: Omit<DictationState, 'eventId'>): void {
    this.state.set({...next, eventId: ++this.eventId});
  }
}
