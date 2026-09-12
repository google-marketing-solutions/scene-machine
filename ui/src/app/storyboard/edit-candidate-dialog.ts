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
  inject,
  signal,
} from '@angular/core';
import {MAT_DIALOG_DATA} from '@angular/material/dialog';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {DictationControl} from '../shared/dictation/dictation-control';
import {DictationConfig} from '../shared/dictation/dictation';

/**
 * Dialog for entering the text instruction that drives the Generate button.
 * Closes with the trimmed instruction, or undefined on cancel.
 */
@Component({
  selector: 'app-edit-candidate-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatDialogClose,
    MatFormFieldModule,
    MatInputModule,
    DictationControl,
  ],
  template: `
    <div class="dialog-container">
      <h2 mat-dialog-title>Edit candidate</h2>
      <mat-dialog-content>
        <mat-form-field
          appearance="outline"
          [class.dictation-enabled]="dictationEnabled"
        >
          <mat-label>Describe your edit</mat-label>
          <textarea
            #editPromptInput
            matInput
            rows="3"
            style="resize: none"
            placeholder="e.g., Make the sky purple"
            [ngModel]="editPrompt()"
            (ngModelChange)="updateEditPrompt($event)"
            cdkFocusInitial
          ></textarea>
          <app-dictation-control
            [enabled]="dictationEnabled"
            [audioConfig]="dictationConfig"
            [value]="editPrompt()"
            [revision]="editPromptRevision()"
            [ownerKey]="ownerKey"
            [textarea]="editPromptInput"
            (valueChange)="updateEditPrompt($event)"
          ></app-dictation-control>
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button [mat-dialog-close]="undefined">Cancel</button>
        <button
          mat-button
          color="primary"
          [disabled]="!editPrompt().trim()"
          [mat-dialog-close]="editPrompt().trim()"
        >
          Generate
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      .dialog-container {
        background: var(--mat-sys-surface-container-highest);
        width: min(460px, calc(100vw - 32px));

        mat-form-field {
          margin-top: 8px;
        }
      }

      mat-form-field {
        width: 100%;
        position: relative;

        &.dictation-enabled textarea {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding-inline-end: 64px !important;
          scrollbar-gutter: stable;
        }

        &.dictation-enabled ::ng-deep .mat-mdc-form-field-infix {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }

        &.dictation-enabled ::ng-deep app-dictation-control {
          position: absolute;
          inset-inline-end: 16px;
          bottom: 4px;
          z-index: 2;
        }
      }

      :host textarea {
        resize: none !important;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditCandidateDialog {
  readonly dialogRef = inject(MatDialogRef<EditCandidateDialog>);
  private readonly data = inject<{
    dictationEnabled?: boolean;
    dictationConfig?: DictationConfig;
  }>(MAT_DIALOG_DATA, {
    optional: true,
  });
  readonly editPrompt = signal('');
  readonly editPromptRevision = signal(0);
  readonly dictationEnabled = this.data?.dictationEnabled === true;
  readonly dictationConfig = this.data?.dictationConfig;
  readonly ownerKey = `edit-dialog-${++dialogOwnerCounter}`;

  updateEditPrompt(value: string): void {
    this.editPrompt.set(value);
    this.editPromptRevision.update(revision => revision + 1);
  }
}

let dialogOwnerCounter = 0;
