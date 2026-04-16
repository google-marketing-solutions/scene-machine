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
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  computed,
  signal,
  ViewChild,
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
 * Dialog component for uploading an audio track.
 */
@Component({
  selector: 'app-audio-upload-dialog',
  templateUrl: './audio-upload-dialog.html',
  styleUrls: ['./audio-upload-dialog.scss'],
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
export class AudioUploadDialog implements OnInit, OnDestroy {
  dialogRef = inject(MatDialogRef<AudioUploadDialog>);
  data = inject(MAT_DIALOG_DATA, {optional: true}) as {
    track?: {
      name: string;
      file: GcsFile;
      startSeconds: number;
      durationSeconds: number;
    };
    trackIndex?: number;
    sceneTimings: SceneTiming[];
  } | null;
  private matSnackBar = inject(MatSnackBar);
  private remixEngineService = inject(RemixEngineService);
  private configService = inject(ConfigService);

  @ViewChild('audioPlayer') audioPlayer!: ElementRef<HTMLAudioElement>;

  selectedFile = signal<File | null>(null);
  existingFileName = signal<string | null>(null);
  existingFile = signal<GcsFile | null>(null);
  isEditMode = signal<boolean>(false);

  startSeconds = signal<number>(0);
  endSeconds = signal<number>(0);
  isInvalidTimeRange = computed(() => this.endSeconds() < this.startSeconds());
  isUploading = signal(false);

  audioUrl = signal<string | null>(null);
  audioDuration: number | null = null;

  ngOnInit() {
    if (this.data && this.data.track) {
      this.isEditMode.set(true);
      this.existingFileName.set(this.data.track.name);
      this.existingFile.set(this.data.track.file);
      this.startSeconds.set(this.data.track.startSeconds);
      this.endSeconds.set(
        this.data.track.durationSeconds + this.data.track.startSeconds,
      );
      if (this.data.track.file?.url) {
        this.audioUrl.set(this.data.track.file.url);
      }
    }
  }

  loadedMetadataHandler() {
    if (this.audioPlayer && this.audioPlayer.nativeElement) {
      this.audioDuration = this.audioPlayer.nativeElement.duration;
      if (!this.isEditMode()) {
        this.endSeconds.set(toDecimals(this.audioDuration, 3));
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

  processFile(file: File) {
    this.clearFile();
    this.selectedFile.set(file);
    this.existingFileName.set(null);
    this.existingFile.set(null);
    this.audioUrl.set(URL.createObjectURL(file));
  }

  clearFile() {
    this.selectedFile.set(null);
    this.existingFileName.set(null);
    this.existingFile.set(null);
    if (this.audioUrl() && this.audioUrl()?.startsWith('blob:')) {
      URL.revokeObjectURL(this.audioUrl()!);
    }
    this.audioUrl.set(null);
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
        console.error('Audio upload error:', error);
        this.matSnackBar.open('Failed to upload audio track.', 'Dismiss', {
          duration: 5000,
          panelClass: ['error-snackbar'],
        });
        return;
      } finally {
        this.isUploading.set(false);
      }
    }

    if (!resultFile) return;

    const audioTracks = [
      ...this.configService.projectConfig.value().audioTracks,
    ];
    const newTrack = {
      name: file ? file.name : this.existingFileName() || 'Unknown',
      file: resultFile,
      startSeconds: this.startSeconds(),
      durationSeconds: this.endSeconds() - this.startSeconds(),
    };

    if (this.isEditMode() && this.data?.trackIndex !== undefined) {
      audioTracks[this.data.trackIndex] = newTrack;
    } else {
      audioTracks.push(newTrack);
    }

    this.configService.updateProjectConfig({audioTracks});
    this.close();
  }

  close(): void {
    this.dialogRef.close();
  }

  ngOnDestroy(): void {
    this.clearFile();
  }
}
