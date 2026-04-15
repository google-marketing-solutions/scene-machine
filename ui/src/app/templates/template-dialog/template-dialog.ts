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

import {CommonModule} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {Template, TemplatesService} from '../../services/templates/templates';

/**
 * Dialog for creating or editing templates.
 */
@Component({
  selector: 'app-template-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    FormsModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './template-dialog.html',
  styleUrl: './template-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplateDialog {
  dialogRef = inject(MatDialogRef<TemplateDialog>);
  templatesService = inject(TemplatesService);

  dialogData = inject<{template?: Template}>(MAT_DIALOG_DATA, {optional: true});

  isEditing = signal(!!this.dialogData?.template);

  name = signal(this.dialogData?.template?.name || '');
  description = signal(this.dialogData?.template?.description || '');
  prompt = signal(this.dialogData?.template?.prompt || '');
  tags = signal(this.dialogData?.template?.tags.join(', ') || '');

  isSubmitting = signal(false);
  isDeleting = signal(false);

  async submit() {
    if (!this.name() || !this.prompt()) return;
    this.isSubmitting.set(true);
    try {
      const tagsArray = this.tags()
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      if (this.isEditing() && this.dialogData?.template?.id) {
        await this.templatesService.updateTemplate(
          this.dialogData.template.id,
          {
            name: this.name(),
            description: this.description(),
            prompt: this.prompt(),
            tags: tagsArray,
          },
        );
      } else {
        await this.templatesService.createTemplate({
          name: this.name(),
          description: this.description(),
          prompt: this.prompt(),
          tags: tagsArray,
          readOnly: false,
          createdAt: Date.now(),
        });
      }
      this.dialogRef.close(true);
    } catch (error) {
      console.error('Error creating or updating template', error);
      this.isSubmitting.set(false);
    }
  }

  async delete() {
    if (!this.dialogData?.template?.id) return;
    this.isDeleting.set(true);
    try {
      await this.templatesService.deleteTemplate(this.dialogData.template.id);
      this.dialogRef.close(true);
    } catch (error) {
      console.error('Error deleting template', error);
      this.isDeleting.set(false);
    }
  }
}
