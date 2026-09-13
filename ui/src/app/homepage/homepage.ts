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
import {MatButtonModule} from '@angular/material/button';
import {MatCardModule} from '@angular/material/card';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {MatMenuModule} from '@angular/material/menu';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {RouterModule} from '@angular/router';
import {env} from '../../env';
import {
  ConfigService,
  ProjectConfig,
  ProjectSummary,
  ThumbnailMaterial,
} from '../services/config/config';
import {CandidateCacheScope} from '../services/media/candidate-video-cache';
import {ConfirmProjectDeleteDialog} from '../shared/confirm-project-delete-dialog';
import {ThumbnailImageDirective} from '../shared/thumbnail-image/thumbnail-image.directive';
import {HomepageAnnouncement} from './homepage-announcement';

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
    MatMenuModule,
    ThumbnailImageDirective,
    HomepageAnnouncement,
  ],
  templateUrl: './homepage.html',
  styleUrl: './homepage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Homepage {
  private config = inject(ConfigService);
  private dialog = inject(MatDialog);
  projects = signal<ProjectSummary[]>([]);
  theme = this.config.theme;
  primaryColor = this.config.primaryColor;
  // Default to "my projects" only when there is a verified identity to filter
  // by. Deployed (controlPlaneMode 'iap') has one, so createdBy=me works. Local
  // dev (controlPlaneMode 'none') has no verified identity and the backend
  // returns 400 for createdBy=me, so default to off and fetch all projects.
  myProjectsOnly = signal<boolean>(env.controlPlaneMode === 'iap');

  constructor() {
    this.fetchProjects();
  }

  fetchProjects() {
    const createdBy = this.myProjectsOnly() || undefined;
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

  getThumbnailMaterial(
    project: ProjectSummary | ProjectConfig,
  ): ThumbnailMaterial {
    if ('thumbnail' in project && project.thumbnail) {
      return project.thumbnail;
    }
    if (
      !('storyboard' in project) ||
      !project.storyboard ||
      project.storyboard.length === 0
    ) {
      return {};
    }
    const firstScene = project.storyboard[0];
    if (this.config.isProvidedVideoScene(firstScene)) {
      return {
        lowQualityThumbnail: firstScene.lowQualityThumbnail,
        highQualityThumbnail: firstScene.highQualityThumbnail,
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
          selectedCandidate?.highQualityThumbnail ||
          firstScene.highQualityThumbnail,
        referenceImage: firstScene.referenceImage,
      };
    }
    return {};
  }

  getThumbnailData(project: ProjectSummary | ProjectConfig) {
    const thumb = this.getThumbnailMaterial(project);
    const hasThumb =
      !!thumb.lowQualityThumbnail || !!thumb.highQualityThumbnail;
    const referenceImage =
      thumb.referenceImage?.preview ?? thumb.referenceImage;

    return {
      ...thumb,
      referenceImage,
      showReference: !hasThumb && referenceImage !== undefined,
      showPlaceholder: !hasThumb && !referenceImage,
    };
  }

  getThumbnailCacheScope(
    project: ProjectSummary | ProjectConfig,
  ): CandidateCacheScope | null {
    const bucket = this.config.globalConfig.value()?.gcsBucket;
    return bucket && project.id ? {bucket, projectId: project.id} : null;
  }

  thumbnailImagesReady(): boolean {
    return !this.config.globalConfig.isLoading();
  }

  thumbnailPersistForProject(project: ProjectSummary | ProjectConfig): boolean {
    if ('thumbnailPersist' in project) {
      return project.thumbnailPersist;
    }
    const scene = project.storyboard?.[0];
    if (!scene || !this.config.isGeneratedScene(scene)) return true;
    return !scene.candidates?.[scene.selectedCandidateIndex ?? 0]?.isArchived;
  }

  getAspectRatio(project: ProjectSummary | ProjectConfig): string {
    return project.aspectRatio ? project.aspectRatio.replace(':', '/') : '16/9';
  }

  deleteProject(projectId: string) {
    const dialogRef = this.dialog.open(ConfirmProjectDeleteDialog);
    dialogRef.afterClosed().subscribe(result => {
      if (!result) {
        return;
      }
      void (async () => {
        try {
          // Await the server delete before re-reading the list, otherwise the
          // refetch GET races the still-in-flight DELETE and the just-deleted
          // project frequently reappears.
          await this.config.deleteProject(projectId);
        } catch {
          // If the delete failed, leave the existing list untouched so the
          // project is not falsely shown as deleted. Skip the refetch.
          return;
        }
        this.fetchProjects();
      })();
    });
  }
}
