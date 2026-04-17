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
import {HttpClient} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {MatBadgeModule} from '@angular/material/badge';
import {MatButtonModule} from '@angular/material/button';
import {MatChipsModule} from '@angular/material/chips';
import {MatIconModule} from '@angular/material/icon';
import {MatMenuModule} from '@angular/material/menu';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatTooltipModule} from '@angular/material/tooltip';
import {
  ConfigService,
  GeneratedScene,
  ProvidedVideoScene,
  RenderRun,
} from '../services/config/config';

/**
 * Component for displaying the output video.
 */
@Component({
  selector: 'app-output-video',
  standalone: true,
  imports: [
    CommonModule,
    MatBadgeModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './output-video.html',
  styleUrl: './output-video.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutputVideo {
  configService = inject(ConfigService);
  private httpClient = inject(HttpClient);

  selectedRenderRun = signal<RenderRun | undefined>(
    this.configService.projectConfig.value().renderRuns?.[0],
  );
  videoUrl = computed(() => this.selectedRenderRun()?.outputVideo?.url);
  previewAspectRatio = computed(() => {
    const ratio = this.configService.projectConfig.value().aspectRatio;
    return ratio ? ratio.replace(':', '/') : '16/9';
  });
  downloading = signal(false);
  downloadingScenes = signal(new Set<string>());

  constructor() {
    effect(() => {
      const renderRun = this.selectedRenderRun();
      if (renderRun && !renderRun.wasPlayed) {
        renderRun.wasPlayed = true;
        this.configService.updateProjectConfig({
          renderRuns: [...this.configService.projectConfig.value().renderRuns!],
        });
      }
    });
  }

  downloadVideo() {
    const url = this.videoUrl();
    if (!url || this.downloading()) {
      return;
    }
    this.downloading.set(true);
    const filename = `${this.configService.projectConfig.value().name}_output.mp4`;
    downloadBlob(this.httpClient, url, filename, () =>
      this.downloading.set(false),
    );
  }

  getSceneVideoUrl(
    scene: GeneratedScene | ProvidedVideoScene,
  ): string | undefined {
    if (this.configService.isGeneratedScene(scene)) {
      return scene.candidates?.[scene.selectedCandidateIndex ?? 0]?.video?.url;
    }
    return scene.video?.url;
  }

  downloadScene(scene: GeneratedScene | ProvidedVideoScene) {
    const url = this.getSceneVideoUrl(scene);
    if (!url || this.downloadingScenes().has(scene.id)) {
      return;
    }

    this.downloadingScenes.update(set => {
      const newSet = new Set(set);
      newSet.add(scene.id);
      return newSet;
    });

    const filename = `${this.configService.projectConfig.value().name}_${scene.name}.mp4`;
    downloadBlob(this.httpClient, url, filename, () => {
      this.downloadingScenes.update(set => {
        const newSet = new Set(set);
        newSet.delete(scene.id);
        return newSet;
      });
    });
  }

  setRenderRunArchiveStatus(run: RenderRun, isArchived: boolean) {
    const config = this.configService.projectConfig.value();
    let removedSelected = false;
    if (run === this.selectedRenderRun()) {
      removedSelected = true;
    }
    const renderRuns =
      config.renderRuns?.map(r => (r === run ? {...r, isArchived} : r)) || [];
    this.configService.updateProjectConfig({renderRuns});
    if (removedSelected) {
      this.selectedRenderRun.set(renderRuns.find(r => !r.isArchived));
    }
  }
}

function downloadBlob(
  httpClient: HttpClient,
  url: string,
  filename: string,
  onComplete: () => void,
) {
  httpClient.get(url, {responseType: 'blob'}).subscribe({
    next: blob => {
      const a = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(objectUrl);
      onComplete();
    },
    error: err => {
      console.error(`Download failed for ${filename}`, err);
      onComplete();
    },
  });
}
