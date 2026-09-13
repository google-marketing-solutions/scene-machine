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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  signal,
  SimpleChanges,
  TemplateRef,
  ViewChild,
} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import {
  DictationConfig,
  DictationService,
  DictationState,
  DICTATION_MAX_AUDIO_BYTES,
  DICTATION_MIME_TYPES,
} from './dictation';

@Component({
  selector: 'app-dictation-control',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatDialogModule],
  template: `
    @if (enabled) {
      <div class="dictation-control" [class.busy]="isBusy()">
        @if (overflowText() !== undefined) {
          <span class="dictation-status" role="status"
            >Transcript exceeds field limit.</span
          >
          <button type="button" mat-button (click)="openRecoveryDetails()">
            Details
          </button>
        } @else if (failureMessage(); as message) {
          <span class="dictation-status" role="status">{{ message }}</span>
          <button type="button" mat-button (click)="openRecoveryDetails()">
            Details
          </button>
        }
        @if (statusText(); as status) {
          <span class="dictation-status" role="status">{{ status }}</span>
        }
        @if (insertedMessage(); as message) {
          <span class="dictation-status" role="status">{{ message }}</span>
          <div class="dictation-inline-actions">
            @if (canUndo()) {
              <button
                type="button"
                mat-icon-button
                aria-label="Undo inserted transcript"
                title="Undo inserted transcript"
                [disabled]="isBusy()"
                (click)="undo()"
              >
                <mat-icon>undo</mat-icon>
              </button>
            }
          </div>
        }
        <button
          type="button"
          mat-icon-button
          [attr.aria-label]="
            isRecording()
              ? 'Stop recording'
              : isCancelable()
                ? 'Cancel dictation'
                : 'Start dictation'
          "
          [disabled]="isDisabled()"
          (mousedown)="$event.preventDefault()"
          (click)="isRecording() ? stop() : isCancelable() ? cancel() : start()"
        >
          <mat-icon>{{
            isRecording() || isCancelable() ? 'stop' : 'mic'
          }}</mat-icon>
        </button>
      </div>
      <ng-template #recoveryDetails>
        <h2 mat-dialog-title>Dictation details</h2>
        <mat-dialog-content>
          @if (overflowText(); as transcript) {
            <p>This transcript is longer than this field allows.</p>
            <textarea
              readonly
              [value]="transcript"
              aria-label="Transcript to review"
            ></textarea>
          } @else if (failureMessage(); as details) {
            <p>{{ details }}</p>
          }
        </mat-dialog-content>
        <mat-dialog-actions align="end">
          @if (overflowText() !== undefined) {
            <button type="button" mat-button (click)="copyOverflow()">
              Copy
            </button>
          }
          <button type="button" mat-button (click)="discard()">Discard</button>
          <button type="button" mat-button mat-dialog-close>Close</button>
        </mat-dialog-actions>
      </ng-template>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        z-index: 1;
        width: 100%;
        box-sizing: border-box;
        padding: 0 8px 6px;
        display: flex;
        justify-content: flex-end;
        pointer-events: none;
      }
      .dictation-control {
        display: flex;
        align-items: center;
        gap: 4px;
        min-height: 36px;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
        box-sizing: border-box;
        padding: 0 4px;
        border-radius: 8px;
        background: color-mix(
          in srgb,
          var(--mat-sys-surface-container-high) 94%,
          transparent
        );
        pointer-events: auto;
      }
      .dictation-control > button[mat-icon-button] {
        margin-left: auto;
      }
      .dictation-control.busy {
        color: var(--mat-sys-primary);
      }
      .dictation-status {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.8rem;
        color: var(--mat-sys-on-surface-variant);
      }
      .dictation-inline-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        margin-left: auto;
      }
      mat-dialog-content textarea {
        width: 100%;
        min-height: 52px;
        max-height: 70px;
        box-sizing: border-box;
        resize: vertical;
      }
      .dictation-actions {
        display: flex;
        justify-content: flex-end;
        gap: 4px;
        margin-top: 4px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DictationControl implements OnChanges, OnDestroy {
  private readonly service = inject(DictationService);
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private readonly dialog = inject(MatDialog);
  private recoveryDialogRef: MatDialogRef<unknown> | undefined;
  @ViewChild('recoveryDetails') recoveryDetails!: TemplateRef<unknown>;

  @Input() enabled = false;
  @Input() value = '';
  @Input() textarea: HTMLTextAreaElement | undefined;
  @Input() revision = 0;
  @Input() ownerKey = '';
  @Input() maxDurationSeconds = 120;
  @Input() maxChars: number | undefined;
  @Input() audioConfig: DictationConfig | undefined;
  @Output() readonly valueChange = new EventEmitter<string>();

  readonly state = () => {
    const current = this.service.state();
    return current.owner === this.ownerKey ? current : IDLE_STATE;
  };
  readonly isRecording = () => this.state().status === 'recording';
  readonly isBusy = () =>
    ['permission', 'recording', 'transcribing'].includes(this.state().status);
  readonly isCancelable = () =>
    ['permission', 'transcribing'].includes(this.state().status);
  readonly isDisabled = () => {
    const globalState = this.service.state();
    return (
      this.ownerKey === '' ||
      (['permission', 'recording', 'transcribing'].includes(
        globalState.status,
      ) &&
        globalState.owner !== undefined &&
        globalState.owner !== this.ownerKey &&
        globalState.status !== 'idle')
    );
  };
  readonly statusText = () => {
    const current = this.state();
    if (current.status === 'permission') return 'Requesting microphone…';
    if (current.status === 'recording')
      return `Recording ${this.formatTime(current.elapsedSeconds)}`;
    if (current.status === 'transcribing') return 'Transcribing…';
    return undefined;
  };

  private readonly recovery = signal<Recovery | undefined>(undefined);
  private handledEventId = 0;
  private expectedFieldChange: {value: string; revision: number} | undefined;
  private insertionSelection:
    | {value: string; revision: number; start: number; end: number}
    | undefined;
  private textareaWithListeners: HTMLTextAreaElement | undefined;
  private blurredSelection:
    | {value: string; revision: number; start: number; end: number}
    | undefined;
  private lastOwner = '';
  private lastValue = '';
  private lastRevision = 0;

  constructor() {
    effect(() => {
      const current = this.state();
      if (current.status === 'idle' && current.owner === this.ownerKey) {
        this.recovery.set(undefined);
      }
      if (current.status === 'recording') {
        this.recovery.set(undefined);
      }
      if (current.status === 'overflow') {
        this.recovery.set({
          kind: 'failed',
          message: current.error ?? 'Recording exceeded the 4 MiB audio limit.',
        });
      }
      if (
        current.eventId === this.handledEventId ||
        current.status !== 'complete'
      )
        return;
      this.handledEventId = current.eventId;
      this.acceptTranscript(current.transcript ?? '');
    });
    effect(() => {
      const current = this.state();
      if (current.eventId === this.handledEventId || current.status !== 'error')
        return;
      this.handledEventId = current.eventId;
      this.recovery.set({
        kind: 'failed',
        message: current.error ?? 'Transcription failed. Please try again.',
      });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['textarea'] && this.textarea !== this.textareaWithListeners) {
      this.textareaWithListeners?.removeEventListener(
        'blur',
        this.rememberBlurredSelection,
      );
      this.textareaWithListeners = this.textarea;
      this.textareaWithListeners?.addEventListener(
        'blur',
        this.rememberBlurredSelection,
      );
    }
    const ownerChanged =
      changes['ownerKey'] && !changes['ownerKey'].firstChange;
    const valueChanged = changes['value'] && !changes['value'].firstChange;
    const revisionChanged =
      changes['revision'] && !changes['revision'].firstChange;
    if (ownerChanged) {
      this.recoveryDialogRef?.close();
      this.recoveryDialogRef = undefined;
      this.recovery.set(undefined);
      this.insertionSelection = undefined;
      this.blurredSelection = undefined;
      this.service.dismiss(this.lastOwner || this.ownerKey);
    } else if (this.lastOwner && (valueChanged || revisionChanged)) {
      const selfWrite =
        this.expectedFieldChange?.value === this.value &&
        this.expectedFieldChange.revision === this.revision;
      this.expectedFieldChange = undefined;
      const expected = this.recovery();
      const stillInserted =
        expected?.kind === 'inserted' &&
        this.value === expected.insertedValue &&
        this.revision === expected.insertedRevision;
      if (!selfWrite && !stillInserted) {
        this.recovery.set(undefined);
        this.insertionSelection = undefined;
        this.service.dismiss(this.lastOwner || this.ownerKey);
      }
    }
    this.lastOwner = this.ownerKey;
    this.lastValue = this.value;
    this.lastRevision = this.revision;
  }

  ngOnDestroy(): void {
    this.recoveryDialogRef?.close();
    this.textareaWithListeners?.removeEventListener(
      'blur',
      this.rememberBlurredSelection,
    );
    this.service.cancel(this.ownerKey);
    this.service.dismiss(this.ownerKey);
  }

  start(): void {
    this.recovery.set(undefined);
    this.insertionSelection = this.captureSelection();
    this.service.start(this.ownerKey, this.config());
  }

  stop(): void {
    this.service.stop(this.ownerKey);
  }

  cancel(): void {
    this.recovery.set(undefined);
    this.insertionSelection = undefined;
    this.service.cancel(this.ownerKey);
  }

  undo(): void {
    const current = this.recovery();
    if (
      this.isBusy() ||
      current?.kind !== 'inserted' ||
      this.value !== current.insertedValue ||
      this.revision !== current.insertedRevision
    ) {
      this.discard();
      return;
    }
    this.expectedFieldChange = {
      value: current.beforeValue,
      revision: current.insertedRevision + 1,
    };
    this.valueChange.emit(current.beforeValue);
    this.recovery.set(undefined);
    this.service.dismiss(this.ownerKey);
  }

  discard(): void {
    this.recoveryDialogRef?.close();
    this.recoveryDialogRef = undefined;
    this.recovery.set(undefined);
    this.insertionSelection = undefined;
    this.service.dismiss(this.ownerKey);
  }

  openRecoveryDetails(): void {
    this.recoveryDialogRef = this.dialog.open(this.recoveryDetails, {
      width: 'min(460px, calc(100vw - 32px))',
    });
    this.recoveryDialogRef.afterClosed().subscribe(() => {
      this.recoveryDialogRef = undefined;
    });
  }

  async copyOverflow(): Promise<void> {
    const transcript = this.overflowText();
    if (transcript === undefined) return;
    await navigator.clipboard?.writeText(transcript);
  }

  readonly overflowText = () => {
    const current = this.recovery();
    return current?.kind === 'overflow' ? current.transcript : undefined;
  };

  readonly insertedMessage = () => {
    const current = this.recovery();
    if (current?.kind === 'inserted') return 'Transcript added.';
    return undefined;
  };

  readonly failureMessage = () => {
    const current = this.recovery();
    if (current?.kind === 'failed') return current.message;
    return undefined;
  };

  readonly canUndo = () => {
    const current = this.recovery();
    return (
      !this.isBusy() &&
      current?.kind === 'inserted' &&
      this.value === current.insertedValue &&
      this.revision === current.insertedRevision
    );
  };

  private config(): DictationConfig {
    const configured = this.audioConfig;
    return {
      enabled: configured?.enabled ?? this.enabled,
      maxAudioBytes: configured?.maxAudioBytes ?? DICTATION_MAX_AUDIO_BYTES,
      maxDurationSeconds: Math.min(
        this.maxDurationSeconds,
        configured?.maxDurationSeconds ?? this.maxDurationSeconds,
      ),
      mimeTypes: configured ? configured.mimeTypes : DICTATION_MIME_TYPES,
    };
  }

  private acceptTranscript(transcript: string): void {
    const trimmed = transcript.trim();
    if (!trimmed) {
      this.recovery.set({
        kind: 'failed',
        message: 'No speech was detected. Please try again.',
      });
      return;
    }
    const selection = this.insertionSelection;
    const hasCurrentSelection =
      selection?.value === this.value && selection.revision === this.revision;
    const separator =
      hasCurrentSelection &&
      selection.start === selection.end &&
      selection.end === this.value.length &&
      this.value &&
      !/\s$/.test(this.value)
        ? '\n'
        : '';
    const insertedValue = hasCurrentSelection
      ? `${this.value.slice(0, selection.start)}${separator}${trimmed}${this.value.slice(selection.end)}`
      : `${this.value}${this.value && !/\s$/.test(this.value) ? '\n' : ''}${trimmed}`;
    if (this.maxChars !== undefined && insertedValue.length > this.maxChars) {
      this.recovery.set({kind: 'overflow', transcript: trimmed});
      return;
    }
    const beforeValue = this.value;
    const beforeRevision = this.revision;
    this.insertionSelection = undefined;
    this.expectedFieldChange = {
      value: insertedValue,
      revision: beforeRevision + 1,
    };
    this.valueChange.emit(insertedValue);
    this.recovery.set({
      kind: 'inserted',
      beforeValue,
      beforeRevision,
      insertedValue,
      insertedRevision: beforeRevision + 1,
    });
  }

  private captureSelection():
    | {value: string; revision: number; start: number; end: number}
    | undefined {
    const textarea = this.textarea;
    if (!textarea) return undefined;
    if (document.activeElement !== textarea) {
      const activeInControl =
        document.activeElement instanceof Node &&
        this.hostElement.nativeElement.contains(document.activeElement);
      return activeInControl && this.blurredSelection
        ? this.blurredSelection
        : {
            value: this.value,
            revision: this.revision,
            start: this.value.length,
            end: this.value.length,
          };
    }
    const start = textarea.selectionStart ?? this.value.length;
    const end = textarea.selectionEnd ?? start;
    return {
      value: this.value,
      revision: this.revision,
      start: Math.max(0, Math.min(start, this.value.length)),
      end: Math.max(0, Math.min(end, this.value.length)),
    };
  }

  private readonly rememberBlurredSelection = (event: FocusEvent) => {
    const textarea = this.textarea;
    if (!textarea) return;
    const relatedTarget = event.relatedTarget;
    if (
      !(relatedTarget instanceof Node) ||
      !this.hostElement.nativeElement.contains(relatedTarget)
    ) {
      this.blurredSelection = undefined;
      return;
    }
    this.blurredSelection = {
      value: this.value,
      revision: this.revision,
      start: Math.max(0, Math.min(textarea.selectionStart, this.value.length)),
      end: Math.max(0, Math.min(textarea.selectionEnd, this.value.length)),
    };
  };

  private formatTime(seconds: number): string {
    const whole = Math.floor(seconds);
    return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  }
}

type Recovery =
  | {
      kind: 'inserted';
      beforeValue: string;
      beforeRevision: number;
      insertedValue: string;
      insertedRevision: number;
    }
  | {kind: 'overflow'; transcript: string}
  | {kind: 'failed'; message: string};

const IDLE_STATE: DictationState = {
  status: 'idle',
  elapsedSeconds: 0,
  eventId: -1,
};
