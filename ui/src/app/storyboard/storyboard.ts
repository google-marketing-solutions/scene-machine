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

import {
  CdkDragDrop,
  DragDropModule,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import {DatePipe, DecimalPipe} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import {MatCardModule} from '@angular/material/card';
import {MatChipsModule} from '@angular/material/chips';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatExpansionModule} from '@angular/material/expansion';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatListModule} from '@angular/material/list';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSelectModule} from '@angular/material/select';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {MatSliderModule} from '@angular/material/slider';
import {MatTabsModule} from '@angular/material/tabs';
import {MatTooltipModule} from '@angular/material/tooltip';
import {ClientMediaService} from '../services/client-media/client-media';
import {
  ConfigService,
  GeneratedScene,
  ProvidedVideoScene,
  toDecimals,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {
  AddSceneDialog,
  AddSceneResult,
} from './add-scene-dialog/add-scene-dialog';
import {ConfirmDialog} from './confirm-dialog';

/**
 * Component for the storyboard view.
 */
@Component({
  selector: 'app-storyboard',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    DragDropModule,
    MatDialogModule,
    MatExpansionModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatSliderModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatButtonToggleModule,
    MatTabsModule,
    MatListModule,
    MatSelectModule,
    MatChipsModule,
    MatTooltipModule,
    FormsModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './storyboard.html',
  styleUrl: './storyboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Storyboard {
  config = inject(ConfigService);
  protected remixEngineService = inject(RemixEngineService);
  private dialog = inject(MatDialog);
  private clientMediaService = inject(ClientMediaService);

  videoElement = viewChild<ElementRef<HTMLVideoElement>>('mainVideo');
  timelineTrack = viewChild<ElementRef<HTMLElement>>('timelineTrack');

  readonly videoDuration = signal(0);

  private userSelectedSceneId = signal<string | null>(null);

  selectedSceneId = computed(() => {
    const scenes = this.config.projectConfig.value().storyboard;
    if (scenes.length === 0) {
      return null;
    }
    const userSelection = this.userSelectedSceneId();
    if (userSelection && scenes.some(s => s.id === userSelection)) {
      return userSelection;
    }
    return scenes[0].id;
  });

  selectedScene = computed(() => {
    const scenes = this.config.projectConfig.value().storyboard;
    const selectedId = this.selectedSceneId();
    if (!selectedId) {
      return null;
    }
    const s = scenes.find(s => s.id === selectedId);
    if (s) {
      return {...s};
    }
    // The || null is important because find can return undefined.
    return null;
  });

  selectedCandidate = computed(() => {
    const scene = this.selectedScene();
    if (!this.config.isGeneratedScene(scene) || !scene.candidates) {
      return undefined;
    }
    if (scene.selectedCandidateIndex === undefined) {
      return undefined;
    }
    return scene.candidates[scene.selectedCandidateIndex];
  });

  candidateCounts = computed(() => {
    const scene = this.selectedScene();
    if (this.config.isGeneratedScene(scene) && scene.candidates) {
      const active = scene.candidates.filter(c => !c.isArchived).length;
      const archived = scene.candidates.length - active;
      return {active, archived};
    }
    return {active: 0, archived: 0};
  });

  runNumberCounter = computed(() => {
    const scene = this.selectedScene();
    if (
      !this.config.isGeneratedScene(scene) ||
      !scene.candidates ||
      scene.candidates.length === 0
    ) {
      return 1;
    }
    return Math.max(...scene.candidates.map(c => c.runNumber)) + 1;
  });

  previewAspectRatio = computed(() => {
    const ratio = this.config.projectConfig.value().aspectRatio;
    return ratio ? ratio.replace(':', '/') : '16/9';
  });

  getThumbnailData(item: {
    lowQualityThumbnail?: string;
    highQualityThumbnail?: {url?: string};
    referenceImage?: {url?: string};
  }) {
    const hasLowQualityThumbnail = !!item.lowQualityThumbnail;
    const hasHighQualityThumbnail = !!item.highQualityThumbnail?.url;
    const hasReferenceImage = !!item.referenceImage?.url;
    const hasThumbnail = hasLowQualityThumbnail || hasHighQualityThumbnail;

    return {
      lowQuality: item.lowQualityThumbnail,
      highQuality: item.highQualityThumbnail?.url,
      reference: item.referenceImage?.url,
      showReference: !hasThumbnail && hasReferenceImage,
      showIcon: !hasThumbnail && !hasReferenceImage,
    };
  }

  formatTimeLabel(value: number): string {
    return `${value.toFixed(2)}s`;
  }

  isVideoPlaying = signal(false);
  currentPlaybackTime = signal(0);
  draggingTrim = signal<{start: number; end: number} | null>(null);

  // Resolves the trim for the selected scene, whether it's a generated scene or a provided video scene.
  trimBySceneType = computed(() => {
    const scene = this.selectedScene();
    // If it's a generated scene, use the trim from the selected candidate.
    if (this.config.isGeneratedScene(scene)) {
      return this.selectedCandidate()?.trim;
    }
    // If it's a provided video scene, use the trim from the scene.
    if (this.config.isProvidedVideoScene(scene)) {
      return scene.trim;
    }
    return undefined;
  });

  trimStart = computed(() => {
    const dragging = this.draggingTrim();
    if (dragging) return toDecimals(dragging.start, 3);

    const trim = this.trimBySceneType();
    if (trim && trim.start !== undefined) {
      return toDecimals(trim.start, 3);
    }
    return 0;
  });

  trimEnd = computed(() => {
    const dragging = this.draggingTrim();
    if (dragging) return toDecimals(dragging.end, 3);

    const trim = this.trimBySceneType();
    if (trim && trim.end !== undefined) {
      return toDecimals(trim.end, 3);
    }
    return this.videoDuration();
  });

  trimmedDuration = computed(() => {
    return this.trimEnd() - this.trimStart();
  });

  // Computed for trim bars
  trimStartPercent = computed(() => {
    const duration = this.videoDuration();
    if (!duration) return 0;
    return (this.trimStart() / duration) * 100;
  });

  trimEndPercent = computed(() => {
    const duration = this.videoDuration();
    if (!duration) return 100;
    return (this.trimEnd() / duration) * 100;
  });

  trimWidthPercent = computed(() => {
    return this.trimEndPercent() - this.trimStartPercent();
  });

  progressWidthPercent = computed(() => {
    const duration = this.videoDuration();
    if (!duration) return 0;
    const current = this.currentPlaybackTime();
    const start = this.trimStart();
    return Math.max(0, ((current - start) / duration) * 100);
  });

  draggingHandle: 'start' | 'end' | null = null;

  private readonly boundHandleDrag = this.handleDrag.bind(this);
  private readonly boundStopDragging = this.stopDraggingTrim.bind(this);

  startDraggingTrim(event: MouseEvent, handle: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();
    this.draggingHandle = handle;

    this.draggingTrim.set({
      start: this.trimStart(),
      end: this.trimEnd(),
    });

    // Pause video while trimming
    const video = this.videoElement()?.nativeElement;
    if (video && !video.paused) {
      this.toggleVideoPlay();
    }
    document.addEventListener('mousemove', this.boundHandleDrag);
    document.addEventListener('mouseup', this.boundStopDragging);
  }

  stopDraggingTrim() {
    const finalTrim = this.draggingTrim();
    if (finalTrim) {
      this.updateTrim(finalTrim);
    }
    this.draggingTrim.set(null);
    this.draggingHandle = null;
    document.removeEventListener('mousemove', this.boundHandleDrag);
    document.removeEventListener('mouseup', this.boundStopDragging);
  }

  handleDrag(event: MouseEvent) {
    if (!this.draggingHandle) return;

    const timeline = this.timelineTrack()?.nativeElement;
    if (!timeline) return;

    const rect = timeline.getBoundingClientRect();
    const duration = this.videoDuration();
    if (!duration) return;

    // Calculate time based on mouse position
    const offsetX = event.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, offsetX / rect.width));
    const newTime = percentage * duration;

    const currentTrim = this.draggingTrim() || {
      start: this.trimStart(),
      end: this.trimEnd(),
    };
    let newStart = currentTrim.start;
    let newEnd = currentTrim.end;

    if (this.draggingHandle === 'start') {
      if (newTime < newEnd) {
        newStart = newTime;
        this.draggingTrim.set({start: newStart, end: newEnd});
        this.seekTo(newTime);
      }
    } else {
      if (newTime > newStart) {
        newEnd = newTime;
        this.draggingTrim.set({start: newStart, end: newEnd});
        this.seekTo(newTime);
      }
    }
  }

  seekTo(time: number) {
    const video = this.videoElement()?.nativeElement;
    if (video) {
      video.currentTime = time;
      this.currentPlaybackTime.set(time);
    }
  }

  onVideoTimeUpdate() {
    const video = this.videoElement()?.nativeElement;
    const scene = this.selectedScene();
    if (video && scene) {
      this.currentPlaybackTime.set(video.currentTime);
      if (!this.isVideoPlaying()) {
        return;
      }

      const trim = this.trimBySceneType();
      if (trim) {
        if (trim.end && video.currentTime >= trim.end) {
          video.currentTime = this.trimStart();
        }
        if (trim.start && video.currentTime <= trim.start) {
          video.currentTime = this.trimStart();
        }
      }
    }
  }

  onVideoLoadedMetadata() {
    const video = this.videoElement()?.nativeElement;
    if (video) {
      this.videoDuration.set(toDecimals(video.duration, 3));
    }
  }

  onVideoEnded() {
    this.isVideoPlaying.set(false);
  }

  toggleVideoPlay() {
    const video = this.videoElement()?.nativeElement;
    if (!video) return;

    if (video.paused) {
      void video.play();
      this.isVideoPlaying.set(true);
    } else {
      video.pause();
      this.isVideoPlaying.set(false);
    }
  }

  isMuted = signal(false);
  videoVolume = signal(0.5);

  changeVolume(event: Event) {
    const input = event.target as HTMLInputElement;
    const newVolume = Number(input.value);

    this.videoVolume.set(newVolume);

    // Automatic unmute when user drags slider
    if (newVolume > 0 && this.isMuted()) {
      this.isMuted.set(false);
    }
  }

  seekVideo(event: MouseEvent) {
    const video = this.videoElement()?.nativeElement;
    const timeline = event.currentTarget as HTMLElement;
    if (!video || !timeline) return;

    const rect = timeline.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, offsetX / rect.width));

    video.currentTime = percentage * video.duration;
  }

  updateTrim(range: {start?: number; end?: number}) {
    const scene = this.selectedScene();
    const candidate = this.selectedCandidate();
    if (
      !this.config.isGeneratedScene(scene) &&
      !this.config.isProvidedVideoScene(scene)
    ) {
      return;
    }

    const currentTrim = this.trimBySceneType();

    const duration = this.videoDuration();
    const newTrim = {
      ...currentTrim,
      ...range,
    };

    if (
      newTrim.start !== undefined &&
      newTrim.start !== null &&
      !isNaN(newTrim.start)
    ) {
      newTrim.start =
        duration > 0
          ? Math.max(0, Math.min(newTrim.start, duration))
          : Math.max(0, newTrim.start);
    } else {
      newTrim.start = 0;
    }
    if (
      newTrim.end !== undefined &&
      newTrim.end !== null &&
      !isNaN(newTrim.end)
    ) {
      newTrim.end =
        duration > 0
          ? Math.max(0, Math.min(newTrim.end, duration))
          : Math.max(0, newTrim.end);
    } else {
      newTrim.end = duration;
    }

    newTrim.start = toDecimals(newTrim.start, 3);
    newTrim.end = toDecimals(newTrim.end, 3);

    if (this.config.isGeneratedScene(scene) && candidate) {
      candidate.trim = newTrim;
    } else if (this.config.isProvidedVideoScene(scene)) {
      scene.trim = newTrim;
    }
    this.updateScenes();
  }

  addScene() {
    const dialogRef = this.dialog.open(AddSceneDialog);
    dialogRef
      .afterClosed()
      .subscribe(async (result: AddSceneResult | undefined) => {
        if (!result) return;

        const newSceneId = this.config.sceneIdCounter().toString();
        const config = this.config.projectConfig.value();

        if (result.type === 'generate') {
          this.config.updateProjectConfig({
            storyboard: [
              ...config.storyboard,
              {
                id: newSceneId,
                type: 'generated',
                name: `Scene ${this.config.sceneIdCounter()}`,
                prompt: '',
              },
            ],
          });
          this.userSelectedSceneId.set(newSceneId);
        } else if (result.type === 'upload') {
          this.config.updateProjectConfig({
            storyboard: [
              ...config.storyboard,
              {
                id: newSceneId,
                type: 'video',
                name: `Scene ${this.config.sceneIdCounter()}`,
              },
            ],
          });
          this.userSelectedSceneId.set(newSceneId);
          // Extract duration and upload media in parallel
          const [duration, uploadResult] = await Promise.all([
            this.getVideoDuration(result.file),
            this.remixEngineService.uploadMedia(result.file),
          ]);
          const scene = this.config.projectConfig
            .value()
            .storyboard.find(s => s.id === newSceneId);
          if (!scene || !this.config.isProvidedVideoScene(scene)) {
            return;
          }
          scene.video = {
            url: uploadResult.url,
            path: uploadResult.path,
          };
          scene.durationSeconds = duration;
          scene.lowQualityThumbnail = await this.clientMediaService
            .generateLowQualityThumbnail(result.file, 'video')
            .then(blob => this.clientMediaService.toBase64(blob));
          scene.highQualityThumbnail = await this.clientMediaService
            .generateHighQualityThumbnail(result.file, 'video')
            .then(blob => this.clientMediaService.toFile(blob))
            .then(file => this.remixEngineService.uploadThumbnail(file));
          this.updateScenes(scene);
        }
      });
  }

  getVideoDuration(file: File): Promise<number> {
    return new Promise(resolve => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        window.URL.revokeObjectURL(video.src);
        resolve(toDecimals(video.duration, 3));
      };
      video.onerror = () => {
        window.URL.revokeObjectURL(video.src);
        resolve(0); // Fallback to 0 if metadata load fails
      };
      video.src = URL.createObjectURL(file);
    });
  }

  setVideoSceneDuration(event: Event, scene: ProvidedVideoScene) {
    const video = event.target as HTMLVideoElement;
    if (video.duration && !scene.durationSeconds) {
      scene.durationSeconds = video.duration;
      this.updateScenes();
    }
  }

  selectScene(id: string) {
    this.userSelectedSceneId.set(id);
    this.isVideoPlaying.set(false);
  }

  selectCandidate(scene: GeneratedScene, index: number) {
    scene.selectedCandidateIndex = index;
    scene.prompt = scene.candidates![index].prompt;
    scene.referenceImage = scene.candidates![index].referenceImage;
    this.updateScenes();
    this.isVideoPlaying.set(false);
  }

  updateScenes(scene?: GeneratedScene | ProvidedVideoScene) {
    const updatedScene = scene || this.selectedScene();
    if (!updatedScene) {
      return;
    }
    this.config.updateProjectConfig({
      storyboard: this.config.projectConfig
        .value()
        .storyboard.map(s => (s.id === updatedScene.id ? updatedScene : s)),
    });
  }

  toggleArchive(event: Event, scene: GeneratedScene, index: number) {
    event.stopPropagation();
    if (scene.candidates && scene.candidates[index]) {
      scene.candidates[index].isArchived = !scene.candidates[index].isArchived;
      this.updateScenes();
    }
  }

  deleteScene(id: string) {
    const dialogRef = this.dialog.open(ConfirmDialog);
    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        if (this.userSelectedSceneId() === id) {
          this.userSelectedSceneId.set(null);
        }
        const config = this.config.projectConfig.value();
        const scenes = config.storyboard.filter(s => s.id !== id);
        this.config.updateProjectConfig({storyboard: scenes});
      }
    });
  }

  areCandidatesGenerating(id: string) {
    return this.remixEngineService.generatingSceneIds().has(id);
  }

  removeReferenceImage() {
    const scene = this.selectedScene();
    if (this.config.isGeneratedScene(scene)) {
      delete scene.referenceImage;
      this.updateScenes();
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

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.processFile(input.files[0]);
    }
    // Reset the input value so the same file can be selected again if needed
    input.value = '';
  }

  processFile(file: File) {
    if (!file.type.startsWith('image/')) {
      console.error('Selected file is not an image');
      return;
    }
    void this.uploadImage(file);
  }

  async uploadImage(file: File) {
    console.log('Upload triggered for file:', file.name);
    const sceneId = this.selectedSceneId();
    if (this.config.isGeneratedScene(this.selectedScene()) && sceneId) {
      if (
        file.type.startsWith('image/') &&
        !['image/jpeg', 'image/png', 'image/jpg'].includes(file.type)
      ) {
        const newFileName =
          file.name.split('.').slice(0, -1).join('.') + '.jpeg';
        file = new File(
          [
            await this.clientMediaService.convertImage(file, {
              mimeType: 'image/jpeg',
            }),
          ],
          newFileName,
          {type: 'image/jpeg'},
        );
      }
      const {path, url} = await this.remixEngineService.uploadMedia(file);
      const scene = this.config.projectConfig
        .value()
        .storyboard.find(s => s.id === sceneId);
      if (scene && this.config.isGeneratedScene(scene)) {
        scene.referenceImage = {path, url};
        try {
          const [lowQualityThumbnail, highQualityThumbnail] = await Promise.all(
            [
              this.clientMediaService.generateLowQualityThumbnail(
                file,
                'image',
              ),
              this.clientMediaService.generateHighQualityThumbnail(
                file,
                'image',
              ),
            ],
          );
          scene.lowQualityThumbnail =
            await this.clientMediaService.toBase64(lowQualityThumbnail);
          scene.highQualityThumbnail =
            await this.remixEngineService.uploadThumbnail(
              this.clientMediaService.toFile(highQualityThumbnail),
            );
        } catch (error) {
          console.log(error);
        }
      }
      this.updateScenes(scene);
    }
  }

  generateCandidates() {
    const scene = this.selectedScene();
    if (this.config.isGeneratedScene(scene)) {
      const projectConfig = this.config.projectConfig.value();
      void this.remixEngineService.generateCandidates(scene, {
        durationSeconds: projectConfig.candidateDurationSeconds,
        model: projectConfig.model,
        generateAudio: projectConfig.generateAudio,
        resolution: projectConfig.resolution,
      });
    }
  }

  drop(event: CdkDragDrop<string[]>) {
    const scenes = [...this.config.projectConfig.value().storyboard];
    moveItemInArray(scenes, event.previousIndex, event.currentIndex);
    this.config.updateProjectConfig({storyboard: scenes});
  }

  getPlaceholdersArray = computed(() => {
    const scene = this.selectedScene();
    if (this.config.isGeneratedScene(scene)) {
      return Array.from({
        length: this.config.projectConfig.value().numberOfCandidates,
      }).fill(0);
    }
    return [];
  });
}
