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
  ThumbnailMaterial,
} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {MediaSrcPipe} from '../services/media/media-src.pipe';
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
    MatMenuModule,
    MediaSrcPipe,
  ],
  templateUrl: './homepage.html',
  styleUrl: './homepage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Homepage {
  private config = inject(ConfigService);
  private dialog = inject(MatDialog);
  private mediaService = inject(MediaService);
  projects = signal<ProjectConfig[]>([]);
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
      this.presignThumbnails(projects);
    });
  }

  /**
   * Pre-warms the signed-URL cache for every visible thumbnail with one batch
   * `/api/signUrl` request, so each card's `| mediaSrc` resolves from the cache
   * instead of firing its own request (one IAM signBlob RPC per card).
   */
  private presignThumbnails(projects: ProjectConfig[]) {
    const paths: string[] = [];
    for (const project of projects) {
      const thumb = this.getThumbnailData(project);
      if (thumb.highQualityThumbnail?.path) {
        paths.push(thumb.highQualityThumbnail.path);
      }
      if (thumb.showReference && thumb.referenceImage?.path) {
        paths.push(thumb.referenceImage.path);
      }
      if (thumb.showVideo && thumb.videoUrl?.path) {
        paths.push(thumb.videoUrl.path);
      }
    }
    if (paths.length === 0) {
      return;
    }
    // Best-effort: each mediaSrc pipe re-signs its own path on a cache miss.
    void this.mediaService.signUrls(paths).catch((error: unknown) => {
      console.error('Failed to pre-sign project thumbnails', error);
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

  getThumbnailMaterial(project: ProjectConfig): ThumbnailMaterial {
    if (!project.storyboard || project.storyboard.length === 0) {
      return {};
    }
    const firstScene = project.storyboard[0];
    if (this.config.isProvidedVideoScene(firstScene)) {
      return {
        lowQualityThumbnail: firstScene.lowQualityThumbnail,
        highQualityThumbnail: firstScene.highQualityThumbnail,
        videoUrl: firstScene.video,
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
        videoUrl: selectedCandidate?.video,
      };
    }
    return {};
  }

  getThumbnailData(project: ProjectConfig) {
    const thumb = this.getThumbnailMaterial(project);
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
