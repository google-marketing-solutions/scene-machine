/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {Component, SimpleChange, ViewChild} from '@angular/core';
import {
  ComponentFixture,
  TestBed as AngularTestBed,
} from '@angular/core/testing';
import {provideRouter, Router} from '@angular/router';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DictationControl} from './dictation-control';
import {
  DictationConfig,
  DictationService,
  DICTATION_MIME_TYPES,
} from './dictation';

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

@Component({
  standalone: true,
  imports: [DictationControl],
  template: `
    <form (submit)="onSubmit($event)">
      <textarea #target [value]="value"></textarea>
      <app-dictation-control
        [enabled]="enabled"
        [value]="value"
        [revision]="revision"
        [ownerKey]="ownerKey"
        [textarea]="target"
        [maxChars]="maxChars"
        [maxDurationSeconds]="maxDurationSeconds"
        [audioConfig]="audioConfig"
        (valueChange)="onValueChange($event)"
      ></app-dictation-control>
      <button type="submit">Submit</button>
    </form>
  `,
})
class DictationHost {
  @ViewChild(DictationControl) control!: DictationControl;
  enabled = true;
  value = 'Existing';
  revision = 4;
  ownerKey = 'project-a:field';
  maxChars: number | undefined;
  maxDurationSeconds = 120;
  audioConfig: DictationConfig | undefined;
  submitted = 0;

  onValueChange(value: string): void {
    this.value = value;
    this.revision++;
  }

  onSubmit(event: Event): void {
    event.preventDefault();
    this.submitted++;
  }
}

class FakeRecorder {
  static isTypeSupported = vi.fn(() => true);
  static holdStop = false;
  static pendingStops: Array<(() => void) | null> = [];
  static last: FakeRecorder | undefined;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly stream: unknown,
    readonly options?: {mimeType?: string},
  ) {
    FakeRecorder.last = this;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['spoken words'], {type: 'audio/webm'}),
    });
    const onstop = this.onstop;
    if (FakeRecorder.holdStop) {
      FakeRecorder.pendingStops.push(onstop);
    } else {
      queueMicrotask(() => onstop?.());
    }
  }

  static releaseStops(): void {
    const pending = FakeRecorder.pendingStops.splice(0);
    for (const callback of pending) callback?.();
  }
}

describe('DictationControl', () => {
  let fixture: ComponentFixture<DictationHost>;
  let host: DictationHost;
  let control: DictationControl;
  let http: HttpTestingController;
  let track: FakeTrack;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    track = new FakeTrack();
    FakeRecorder.isTypeSupported.mockReturnValue(true);
    getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [track],
    });
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {getUserMedia},
    });
    await AngularTestBed.configureTestingModule({
      imports: [DictationHost],
      providers: [
        DictationService,
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    fixture = AngularTestBed.createComponent(DictationHost);
    host = fixture.componentInstance;
    fixture.detectChanges();
    control = host.control;
    http = AngularTestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    FakeRecorder.holdStop = false;
    FakeRecorder.releaseStops();
    FakeRecorder.last = undefined;
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function record(): Promise<
    ReturnType<HttpTestingController['expectOne']>
  > {
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);
    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    return http.expectOne('/api/transcribe');
  }

  it('starts dictation from the first mic click', async () => {
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(control.state().status).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Stop recording"]'),
    );
    http.expectNone('/api/transcribe');
    control.cancel();
  });

  it('keeps the opening caret through immediate recording and shows the result', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');
    fixture.detectChanges();
    expect(document.body.textContent).toContain('Transcribing');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Cancel dictation"]'),
    ).not.toBeNull();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Exspoken wordsisting');
    expect(control.panelOpen()).toBe(true);

    expect(document.body.textContent).toContain('Undo');
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector(
        '[aria-label="Undo inserted transcript"]',
      ),
    );
    const close = fixture.nativeElement.querySelector(
      '[aria-label="Close dictation message"]',
    ) as HTMLButtonElement;
    close.click();
    fixture.detectChanges();
    expect(control.panelOpen()).toBe(false);
    await Promise.resolve();
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[aria-label="Start dictation"]'),
    );
  });

  it('closes the panel without cancelling an active recording', async () => {
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    control.closePanel();
    fixture.detectChanges();

    expect(control.panelOpen()).toBe(false);
    expect(control.isRecording()).toBe(true);

    const reopen = fixture.nativeElement.querySelector(
      '[aria-label="Open dictation controls"]',
    ) as HTMLButtonElement;
    reopen.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(
      document.querySelector('[aria-label="Stop recording"]'),
    ).not.toBeNull();

    const stop = Array.from(
      document.querySelectorAll('.dictation-panel button'),
    ).find(button => button.getAttribute('aria-label') === 'Stop recording') as
      | HTMLButtonElement
      | undefined;
    stop?.click();
    control.cancel();
  });

  it('cancels an active recording from the compact close action', async () => {
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    const cancel = fixture.nativeElement.querySelector(
      '[aria-label="Cancel dictation"]',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();

    expect(control.panelOpen()).toBe(false);
    expect(control.state().status).toBe('idle');
    expect(track.stopped).toBe(true);
  });

  it('inserts the returned transcript at the textarea end without submitting', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(host.value.length, host.value.length);
    const request = await record();

    expect(request.request.body).toBeInstanceOf(FormData);
    expect((request.request.body as FormData).getAll('audio')).toHaveLength(1);
    expect(
      (request.request.body as FormData).getAll('audio')[0],
    ).toBeInstanceOf(Blob);
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Existing\nspoken words');
    expect(host.submitted).toBe(0);
    expect(control.canUndo()).toBe(true);
    expect(fixture.nativeElement.textContent).not.toContain('Retry');
    expect(
      fixture.nativeElement.querySelector(
        '[aria-label="Dismiss dictation message"]',
      ),
    ).toBeNull();

    control.undo();
    fixture.detectChanges();
    expect(host.value).toBe('Existing');
    expect(control.canUndo()).toBe(false);
    expect(control.panelOpen()).toBe(false);
    expect(
      fixture.nativeElement.querySelector('[aria-label="Start dictation"]'),
    ).not.toBeNull();
  });

  it('falls back to the end when the textarea has never been focused', async () => {
    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Existing\nspoken words');
  });

  it('falls back to the end when focus moved to an unrelated field', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    const unrelated = document.createElement('textarea');
    document.body.appendChild(unrelated);
    unrelated.focus();

    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Existing\nspoken words');
    unrelated.remove();
  });

  it('preserves the caret when focus moves from the textarea to its mic', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    const mic = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    mic.focus();

    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Exspoken wordsisting');
  });

  it('clears a remembered selection when blur has no related target', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new FocusEvent('blur', {relatedTarget: null}));
    const unrelated = document.createElement('textarea');
    document.body.appendChild(unrelated);
    unrelated.focus();

    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Existing\nspoken words');
    unrelated.remove();
  });

  it('closes recovery details when the owner changes', async () => {
    control.maxChars = 5;
    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();
    const details = Array.from(
      document.querySelectorAll('.dictation-panel button'),
    ).find(button => button.textContent?.trim() === 'Details') as
      | HTMLButtonElement
      | undefined;
    details?.click();
    fixture.detectChanges();
    expect(document.querySelector('mat-dialog-container')).not.toBeNull();

    control.ngOnChanges({
      ownerKey: new SimpleChange(host.ownerKey, 'project-a:other', false),
    });
    expect(control.panelOpen()).toBe(false);
    await vi.waitFor(() =>
      expect(document.querySelector('mat-dialog-container')).toBeNull(),
    );
  });

  it('closes recovery details when the control is destroyed', async () => {
    control.maxChars = 5;
    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();
    const details = Array.from(
      document.querySelectorAll('.dictation-panel button'),
    ).find(button => button.textContent?.trim() === 'Details') as
      | HTMLButtonElement
      | undefined;
    details?.click();
    fixture.detectChanges();
    expect(document.querySelector('mat-dialog-container')).not.toBeNull();

    fixture.destroy();
    await vi.waitFor(() =>
      expect(document.querySelector('mat-dialog-container')).toBeNull(),
    );
  });

  it('inserts the returned transcript at the textarea caret', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Exspoken wordsisting');
  });

  it('replaces the selected textarea text', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, host.value.length);

    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('spoken words');
    control.undo();
    expect(host.value).toBe('Existing');
  });

  it('keeps the caret captured at start when focus moves during transcription', async () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 0);

    const request = await record();
    textarea.focus();
    textarea.setSelectionRange(host.value.length, host.value.length);
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('spoken wordsExisting');
  });

  it('allows a replacement that fits the field limit', async () => {
    host.maxChars = host.value.length;
    fixture.componentRef.changeDetectorRef.detectChanges();
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, host.value.length);

    const request = await record();
    request.flush({text: 'New'});
    fixture.detectChanges();

    expect(host.value).toBe('New');
    expect(control.overflowText()).toBeUndefined();
  });

  it('shows the transcription error without exposing a Retry action', async () => {
    const request = await record();
    request.flush(
      {error: 'busy', code: 'quota'},
      {status: 429, statusText: 'Too Many Requests'},
    );
    fixture.detectChanges();
    expect(control.state().status).toBe('error');
    expect(document.body.textContent).toContain('Transcription failed');
    expect(document.body.textContent).not.toContain('Retry');
    expect(
      fixture.nativeElement.querySelector(
        '[aria-label="Dismiss dictation message"]',
      ),
    ).toBeNull();
  });

  it('shows a recording overflow error before a deferred recorder stop', async () => {
    host.audioConfig = {
      enabled: true,
      maxAudioBytes: 1,
      maxDurationSeconds: 120,
      mimeTypes: DICTATION_MIME_TYPES,
    };
    fixture.componentRef.changeDetectorRef.detectChanges();
    FakeRecorder.holdStop = true;
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    control.stop();
    fixture.detectChanges();

    expect(control.state().status).toBe('overflow');
    expect(document.body.textContent).toContain(
      'Recording exceeded the 4 MiB audio limit.',
    );
    FakeRecorder.releaseStops();
    fixture.detectChanges();
    expect(control.state().status).toBe('overflow');
    http.expectNone('/api/transcribe');
  });

  it('keeps a recording failure visible before a deferred recorder stop', async () => {
    FakeRecorder.holdStop = true;
    vi.useFakeTimers();
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    FakeRecorder.last?.onerror?.();
    fixture.detectChanges();
    expect(control.state().status).toBe('error');
    expect(document.body.textContent).toContain(
      'Recording failed. Please try again.',
    );
    vi.advanceTimersByTime(1000);
    expect(control.state().status).toBe('error');
    FakeRecorder.releaseStops();
    http.expectNone('/api/transcribe');
  });

  it('keeps an overflowing transcript in review without exposing Retry', async () => {
    host.maxChars = 'Existing'.length;
    fixture.componentRef.changeDetectorRef.detectChanges();
    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect(host.value).toBe('Existing');
    expect(document.body.textContent).toContain(
      'Transcript exceeds field limit.',
    );
    expect(fixture.nativeElement.textContent).not.toContain('Retry');
    expect(document.querySelector('mat-dialog-container')).toBeNull();

    const details = Array.from(
      document.querySelectorAll('.dictation-panel button'),
    )
      .map(button => button as HTMLButtonElement)
      .find(button => button.textContent?.trim() === 'Details') as
      | HTMLButtonElement
      | undefined;
    expect(details).toBeDefined();
    details?.click();
    fixture.detectChanges();
    expect(document.querySelector('mat-dialog-container')).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Transcript to review"]'),
    ).not.toBeNull();
    control.discard();
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('mat-dialog-container')).toBeNull(),
    );
  });

  it('cancels the HTTP request and microphone tracks when the control is destroyed', async () => {
    const request = await record();
    fixture.destroy();

    expect(request.cancelled).toBe(true);
    expect(track.stopped).toBe(true);
  });

  it('cancels a pending POST when the bound field is edited externally', async () => {
    const request = await record();
    host.value = 'Changed by typing';
    host.revision++;
    fixture.componentRef.changeDetectorRef.detectChanges();

    expect(request.cancelled).toBe(true);
    expect(host.value).toBe('Changed by typing');
    http.expectNone('/api/transcribe');
  });

  it('keeps an inserted transcript when the field changes before Undo', async () => {
    const request = await record();
    request.flush({text: 'first transcript'});
    fixture.detectChanges();
    expect(host.value).toBe('Existing\nfirst transcript');

    host.value = 'Existing\nfirst transcript plus an edit';
    host.revision++;
    fixture.componentRef.changeDetectorRef.detectChanges();
    control.undo();

    expect(host.value).toBe('Existing\nfirst transcript plus an edit');
    expect(control.canUndo()).toBe(false);
    expect(http.match('/api/transcribe')).toHaveLength(0);
  });

  it('stops a late permission stream after Cancel without posting audio', async () => {
    let resolvePermission!: (stream: {getTracks: () => FakeTrack[]}) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePermission = resolve;
        }),
    );
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Start dictation"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(control.state().status).toBe('permission');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Cancel dictation"]'),
    ).not.toBeNull();
    (
      fixture.nativeElement.querySelector(
        '[aria-label="Cancel dictation"]',
      ) as HTMLButtonElement
    ).click();

    const lateTrack = new FakeTrack();
    resolvePermission({getTracks: () => [lateTrack]});
    await Promise.resolve();
    await Promise.resolve();

    expect(lateTrack.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('ignores a stale delayed Stop while a newer recording is live', async () => {
    const oldTrack = new FakeTrack();
    const newTrack = new FakeTrack();
    let permissionCalls = 0;
    getUserMedia.mockImplementation(() =>
      Promise.resolve({
        getTracks: () => [permissionCalls++ === 0 ? oldTrack : newTrack],
      }),
    );
    FakeRecorder.holdStop = true;
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    control.stop();
    control.cancel();
    control.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.isRecording()).toBe(true);
    expect(oldTrack.stopped).toBe(true);
    FakeRecorder.releaseStops();
    expect(newTrack.stopped).toBe(false);
    expect(control.isRecording()).toBe(true);
    FakeRecorder.holdStop = false;
    control.cancel();
    http.expectNone('/api/transcribe');
  });

  it('reports unsupported formats instead of falling back to an unconfigured recorder', async () => {
    FakeRecorder.isTypeSupported.mockReturnValue(false);
    control.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.state().status).toBe('error');
    expect(control.state().code).toBe('unsupported_format');
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('reports a useful error when MediaRecorder is unavailable after permission', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    control.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.state().status).toBe('error');
    expect(control.state().code).toBe('unsupported_format');
    expect(control.state().error).toContain('allowed audio format');
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('clears the timer before a deferred recorder stop', async () => {
    FakeRecorder.holdStop = true;
    vi.useFakeTimers();
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    control.stop();
    expect(control.state().status).toBe('transcribing');
    vi.advanceTimersByTime(1000);
    expect(control.state().status).toBe('transcribing');

    FakeRecorder.releaseStops();
    const request = http.expectOne('/api/transcribe');
    request.flush({text: 'spoken words'});
  });

  it('uses the smaller product field cap when server config allows 120 seconds', async () => {
    host.maxDurationSeconds = 30;
    host.audioConfig = {
      enabled: true,
      maxAudioBytes: 4 * 1024 * 1024,
      maxDurationSeconds: 120,
      mimeTypes: DICTATION_MIME_TYPES,
    };
    fixture.componentRef.changeDetectorRef.detectChanges();
    vi.useFakeTimers();
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    vi.advanceTimersByTime(30_001);
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/transcribe');
  });

  it('stops before the server hard cap and still uploads a delayed final chunk', async () => {
    host.maxDurationSeconds = 120;
    host.audioConfig = {
      enabled: true,
      maxAudioBytes: 4 * 1024 * 1024,
      maxDurationSeconds: 120,
      mimeTypes: DICTATION_MIME_TYPES,
    };
    fixture.componentRef.changeDetectorRef.detectChanges();
    FakeRecorder.holdStop = true;
    vi.useFakeTimers();
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);

    vi.advanceTimersByTime(119_001);

    expect(control.state().status).toBe('transcribing');
    FakeRecorder.releaseStops();
    const request = http.expectOne('/api/transcribe');
    expect((request.request.body as FormData).get('audio')).toBeInstanceOf(
      Blob,
    );
    request.flush({text: 'near-limit transcript'});
  });

  it('invalidates Undo recovery on navigation, including a later A-to-B-to-A return', async () => {
    const request = await record();
    request.flush({text: 'spoken words'});
    fixture.detectChanges();
    expect(control.canUndo()).toBe(true);

    const router = AngularTestBed.inject(Router);
    await router.navigateByUrl('/project-b').catch(() => false);
    fixture.detectChanges();

    expect(control.canUndo()).toBe(false);
    expect(host.value).toBe('Existing\nspoken words');
  });
});
