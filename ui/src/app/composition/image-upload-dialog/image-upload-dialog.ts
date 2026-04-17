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
  OnDestroy,
  OnInit,
  Signal,
  computed,
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
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {ConfigService, GcsFile, toDecimals} from '../../services/config/config';
import {RemixEngineService} from '../../services/remix-engine/remix-engine';
import {SceneTiming} from '../composition';
import {SceneSelector} from '../scene-selector/scene-selector';

/**
 * Dialog component for uploading an image overlay.
 */
@Component({
  selector: 'app-image-upload-dialog',
  templateUrl: './image-upload-dialog.html',
  styleUrls: ['./image-upload-dialog.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSnackBarModule,
    SceneSelector,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageUploadDialog implements OnInit, OnDestroy {
  dialogRef = inject(MatDialogRef<ImageUploadDialog>);
  data = inject(MAT_DIALOG_DATA, {optional: true}) as {
    overlay?: {
      name: string;
      file: GcsFile;
      startSeconds: number;
      durationSeconds: number;
      widthPixels: number;
      heightPixels: number;
      pixelsFromTop: number;
      pixelsFromLeft: number;
    };
    overlayIndex?: number;
    videoDurationSeconds?: Signal<number>;
    sceneTimings: SceneTiming[];
  } | null;
  private matSnackBar = inject(MatSnackBar);
  private remixEngineService = inject(RemixEngineService);
  private configService = inject(ConfigService);

  selectedFile = signal<File | null>(null);
  existingFileName = signal<string | null>(null);
  existingFile = signal<GcsFile | null>(null);
  isEditMode = signal<boolean>(false);

  startSeconds = signal<number>(0);
  endSeconds = signal<number>(
    toDecimals(this.data?.videoDurationSeconds?.() ?? 0, 3),
  );
  isInvalidTimeRange = computed(() => this.endSeconds() < this.startSeconds());
  isUploading = signal(false);

  imageUrl = signal<string | null>(null);
  imageWidthPixels = signal<number>(0);
  imageHeightPixels = signal<number>(0);
  pixelsFromTop = signal<number>(0);
  pixelsFromLeft = signal<number>(0);

  isAspectRatioLocked = signal(true);
  aspectRatio = signal<number | null>(null);

  ngOnInit() {
    if (this.data && this.data.overlay) {
      this.isEditMode.set(true);
      this.existingFileName.set(this.data.overlay.name);
      this.existingFile.set(this.data.overlay.file);
      this.startSeconds.set(this.data.overlay.startSeconds);
      this.endSeconds.set(
        this.data.overlay.durationSeconds + this.data.overlay.startSeconds,
      );
      this.imageWidthPixels.set(this.data.overlay.widthPixels);
      this.imageHeightPixels.set(this.data.overlay.heightPixels);
      this.pixelsFromTop.set(this.data.overlay.pixelsFromTop);
      this.pixelsFromLeft.set(this.data.overlay.pixelsFromLeft);
      if (this.data.overlay.file?.url) {
        this.imageUrl.set(this.data.overlay.file.url);
      }
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
      this.processFile(files[0]);
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.processFile(input.files[0]);
    }
    input.value = '';
  }

  onImageLoad(event: Event) {
    const image = event.target as HTMLImageElement;
    if (!this.isEditMode()) {
      this.imageWidthPixels.set(image.naturalWidth);
      this.imageHeightPixels.set(image.naturalHeight);
    }
    if (image.naturalHeight > 0) {
      this.aspectRatio.set(image.naturalWidth / image.naturalHeight);
    }
  }

  onWidthChange(width: number) {
    this.imageWidthPixels.set(width);
    if (this.isAspectRatioLocked() && this.aspectRatio()) {
      this.imageHeightPixels.set(Math.round(width / this.aspectRatio()!));
    }
  }

  onHeightChange(height: number) {
    this.imageHeightPixels.set(height);
    if (this.isAspectRatioLocked() && this.aspectRatio()) {
      this.imageWidthPixels.set(Math.round(height * this.aspectRatio()!));
    }
  }

  toggleLock() {
    this.isAspectRatioLocked.set(!this.isAspectRatioLocked());
    if (this.isAspectRatioLocked() && this.imageHeightPixels() > 0) {
      this.aspectRatio.set(this.imageWidthPixels() / this.imageHeightPixels());
    }
  }

  processFile(file: File) {
    if (!file.type.startsWith('image/')) {
      console.error('Selected file is not an image file');
      return;
    }
    this.clearFile();
    this.selectedFile.set(file);
    this.existingFileName.set(null);
    this.existingFile.set(null);
    this.imageUrl.set(URL.createObjectURL(file));
  }

  clearFile() {
    this.selectedFile.set(null);
    this.existingFileName.set(null);
    this.existingFile.set(null);
    if (this.imageUrl() && this.imageUrl()?.startsWith('blob:')) {
      URL.revokeObjectURL(this.imageUrl()!);
    }
    this.imageUrl.set(null);
  }

  async onAdd(): Promise<void> {
    if (this.isInvalidTimeRange()) return;

    const file = this.selectedFile();
    let resultFile = this.existingFile();

    if (file) {
      this.isUploading.set(true);
      try {
        resultFile = await this.remixEngineService.uploadMedia(file);
      } catch (error) {
        console.error('Image upload error:', error);
        this.matSnackBar.open('Failed to upload image.', 'Dismiss', {
          duration: 5000,
          panelClass: ['error-snackbar'],
        });
        return;
      } finally {
        this.isUploading.set(false);
      }
    }

    if (!resultFile) return;

    const visualOverlays = [
      ...this.configService.projectConfig.value().visualOverlays,
    ];
    const newOverlay = {
      name: file ? file.name : this.existingFileName() || 'Unknown',
      file: resultFile,
      startSeconds: this.startSeconds(),
      durationSeconds: this.endSeconds() - this.startSeconds(),
      widthPixels: this.imageWidthPixels(),
      heightPixels: this.imageHeightPixels(),
      pixelsFromTop: this.pixelsFromTop(),
      pixelsFromLeft: this.pixelsFromLeft(),
    };

    if (this.isEditMode() && this.data?.overlayIndex !== undefined) {
      visualOverlays[this.data.overlayIndex] = newOverlay;
    } else {
      visualOverlays.push(newOverlay);
    }

    this.configService.updateProjectConfig({visualOverlays});
    this.close();
  }

  close(): void {
    this.dialogRef.close();
  }

  ngOnDestroy(): void {
    this.clearFile();
  }
}
