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
import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import {MatDialogModule, MatDialogRef} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';

/**
 * Result type for the Add Scene dialog.
 */
export type AddSceneResult = {type: 'generate'} | {type: 'upload'; file: File};

/**
 * Dialog component for adding a new scene.
 */
@Component({
  selector: 'app-add-scene-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  templateUrl: './add-scene-dialog.html',
  styleUrl: './add-scene-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddSceneDialog {
  dialogRef = inject(MatDialogRef<AddSceneDialog, AddSceneResult>);

  selectGenerate() {
    this.dialogRef.close({type: 'generate'});
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
  }

  handleFile(file: File) {
    if (file.type.startsWith('video/')) {
      this.dialogRef.close({type: 'upload', file});
    } else {
      console.warn('Selected file is not a video, ignoring');
    }
  }
}
