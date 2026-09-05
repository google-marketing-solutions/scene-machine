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

/**
 * Dialog for entering the text instruction that drives the Edit button.
 * Closes with the trimmed instruction, or undefined on cancel.
 */
@Component({
  selector: 'app-edit-candidate-dialog',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatDialogClose,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <div class="dialog-container">
      <h2 mat-dialog-title>Edit candidate</h2>
      <mat-dialog-content>
        <mat-form-field appearance="outline">
          <mat-label>What should change?</mat-label>
          <textarea
            matInput
            rows="3"
            placeholder="Make the sky purple"
            [ngModel]="editPrompt()"
            (ngModelChange)="editPrompt.set($event)"
            cdkFocusInitial
          ></textarea>
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
          Edit
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      .dialog-container {
        background: var(--mat-sys-surface-container-highest);
      }

      mat-form-field {
        width: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditCandidateDialog {
  readonly dialogRef = inject(MatDialogRef<EditCandidateDialog>);
  readonly editPrompt = signal('');
}
