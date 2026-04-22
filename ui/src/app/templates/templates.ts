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

import {CommonModule, Location} from '@angular/common';
import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {RouterModule} from '@angular/router';
import {Template, TemplatesService} from '../services/templates/templates';
import {TemplateCard} from './template-card/template-card';
import {TemplateDialog} from './template-dialog/template-dialog';

/**
 * Component for managing templates.
 */
@Component({
  selector: 'app-templates',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    RouterModule,
    TemplateCard,
  ],
  templateUrl: './templates.html',
  styleUrl: './templates.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Templates {
  dialogRef = inject(MatDialogRef<Templates>, {optional: true});
  dialog = inject(MatDialog);
  templatesService = inject(TemplatesService);
  private readonly location = inject(Location);

  close() {
    this.dialogRef?.close();
  }

  goBack() {
    this.location.back();
  }

  openCreateDialog(template?: Template) {
    this.dialog.open(TemplateDialog, {
      width: '100%',
      height: '100%',
      maxHeight: '80vh',
      maxWidth: 'min(80vw, 1200px)',
      data: template ? {template} : undefined,
    });
  }
}
