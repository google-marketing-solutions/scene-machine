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

import {DatePipe} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {Auth} from '@angular/fire/auth';
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {RouterModule} from '@angular/router';
import {
  ConfigService,
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
} from '../services/config/config';
import {ConfirmProjectDeleteDialog} from '../shared/confirm-project-delete-dialog';

/**
 * Component for the homepage, displaying projects.
 */
@Component({
  selector: 'app-homepage',
  imports: [
    MatCardModule,
    MatButtonModule,
    RouterModule,
    MatIconModule,
    MatSlideToggleModule,
    DatePipe,
    MatDialogModule,
  ],
  templateUrl: './homepage.html',
  styleUrl: './homepage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Homepage {
  private config = inject(ConfigService);
  private auth = inject(Auth);
  private dialog = inject(MatDialog);
  projects = signal<ProjectConfig[]>([]);
  myProjectsOnly = signal<boolean>(true);

  constructor() {
    void this.auth.authStateReady().then(() => {
      this.fetchProjects();
    });
  }

  fetchProjects() {
    const createdBy = this.myProjectsOnly()
      ? (this.auth.currentUser?.email ?? undefined)
      : undefined;
    void this.config.getProjects(createdBy).then(projects => {
      // Sort by lastEdited descending
      projects.sort((a, b) => {
        const dateA = a.lastEdited ? new Date(a.lastEdited).getTime() : 0;
        const dateB = b.lastEdited ? new Date(b.lastEdited).getTime() : 0;
        return dateB - dateA;
      });
      this.projects.set(projects);
    });
  }

  toggleFilter(checked: boolean) {
    this.myProjectsOnly.set(checked);
    this.fetchProjects();
  }

  getUsername(email?: string): string {
    if (!email) return 'Unknown';
    return email.split('@')[0];
  }

  getThumbnail(project: ProjectConfig): {
    lowQualityThumbnail?: string;
    highQualityThumbnail?: string;
    referenceImage?: string;
    videoUrl?: string;
  } {
    if (!project.storyboard || project.storyboard.length === 0) {
      return {};
    }
    const firstScene = project.storyboard[0];
    if (this.config.isProvidedVideoScene(firstScene)) {
      return {
        lowQualityThumbnail: firstScene.lowQualityThumbnail,
        highQualityThumbnail: firstScene.highQualityThumbnail?.url,
        videoUrl: firstScene.video?.url,
      };
    }
    if (this.config.isGeneratedScene(firstScene)) {
      const selectedCandidate =
        firstScene.candidates?.[firstScene.selectedCandidateIndex ?? 0];

      return {
        lowQualityThumbnail:
          selectedCandidate?.lowQualityThumbnail ||
          firstScene.lowQualityThumbnail,
        highQualityThumbnail:
          selectedCandidate?.highQualityThumbnail?.url ||
          firstScene.highQualityThumbnail?.url,
        referenceImage: firstScene.referenceImage?.url,
        videoUrl: selectedCandidate?.video?.url,
      };
    }
    return {};
  }

  getThumbnailData(project: ProjectConfig) {
    const thumb = this.getThumbnail(project);
    const hasThumb =
      !!thumb.lowQualityThumbnail || !!thumb.highQualityThumbnail;

    return {
      ...thumb,
      showReference: thumb.referenceImage !== undefined,
      showVideo: !hasThumb && !thumb.referenceImage && !!thumb.videoUrl,
      showPlaceholder: !hasThumb && !thumb.referenceImage && !thumb.videoUrl,
    };
  }

  getAspectRatio(project: ProjectConfig): string {
    return project.aspectRatio ? project.aspectRatio.replace(':', '/') : '16/9';
  }

  isGeneratedScene(
    scene: GeneratedScene | ProvidedVideoScene | null,
  ): scene is GeneratedScene {
    return this.config.isGeneratedScene(scene);
  }

  isProvidedVideoScene(
    scene: GeneratedScene | ProvidedVideoScene | null,
  ): boolean {
    return this.config.isProvidedVideoScene(scene);
  }

  deleteProject(projectId: string) {
    const dialogRef = this.dialog.open(ConfirmProjectDeleteDialog);
    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        void this.config.deleteProject(projectId);
        this.fetchProjects();
      }
    });
  }
}
