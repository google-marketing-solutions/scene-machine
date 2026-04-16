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
  OnInit,
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
import {MatSnackBar} from '@angular/material/snack-bar';
import {MatTooltipModule} from '@angular/material/tooltip';
import {
  ASPECT_RATIO_DEVIATION_THRESHOLD,
  AspectRatio,
  GeneratedScene,
  Product,
} from '../../services/config/config';
import {RemixEngineService} from '../../services/remix-engine/remix-engine';

/**
 * Dialog component for generating a storyboard.
 */
@Component({
  selector: 'app-generate-storyboard-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    FormsModule,
  ],
  templateUrl: './generate-storyboard-dialog.html',
  styleUrl: './generate-storyboard-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GenerateStoryboardDialog implements OnInit {
  private remixEngineService = inject(RemixEngineService);
  private matSnackBar = inject(MatSnackBar);

  dialogRef = inject(MatDialogRef<GenerateStoryboardDialog>);
  data = inject(MAT_DIALOG_DATA) as {
    aspectRatio: AspectRatio;
    products: Product[];
    briefing: string;
    overwriteSystemPrompt: boolean;
  };
  isLoading = signal(true);
  imageDecision = signal<null | 'none' | 'crop' | 'outpaint'>(null);

  get aspectRatio() {
    return this.data?.aspectRatio?.replace(':', '/') || '16/9';
  }

  generatedScenes: GeneratedScene[] = [];

  async ngOnInit() {
    const productsWithInvalidAspectRatios = this.data.products.some(p =>
      p.images.some(
        i => (i.aspectRatioDeviation ?? 0) > ASPECT_RATIO_DEVIATION_THRESHOLD,
      ),
    );
    if (productsWithInvalidAspectRatios) {
      return;
    }
    this.imageDecision.set('none');
    this.dialogRef.disableClose = true;
    void this.generateStoryboard();
  }

  async generateStoryboard() {
    const scenes = await this.remixEngineService.generateStoryboard(
      this.data.products,
      this.data.briefing,
      this.imageDecision() ?? 'none',
    );
    if (scenes === undefined) {
      // TODO: Maybe show a nicer message if the project changed
      console.error('Storyboard generation failed');
      this.matSnackBar.open(
        'Storyboard generation failed. Please try again.',
        'Close',
        {
          duration: 10000,
        },
      );
      this.dialogRef.close();
    } else {
      this.generatedScenes = scenes;
    }
    this.isLoading.set(false);
    this.dialogRef.disableClose = false;
  }

  removeScene(index: number) {
    this.generatedScenes.splice(index, 1);
  }

  onGenerateVideos() {
    this.dialogRef.close(this.generatedScenes);
  }

  onCancel() {
    this.dialogRef.close();
  }
}
