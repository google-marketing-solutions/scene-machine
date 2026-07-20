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
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatChipsModule} from '@angular/material/chips';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatExpansionModule} from '@angular/material/expansion';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSelectModule} from '@angular/material/select';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {MatSliderModule} from '@angular/material/slider';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {MatTooltipModule} from '@angular/material/tooltip';
import {ClientMediaService} from '../services/client-media/client-media';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  MIN_RENDER_CLIP_DURATION_SECONDS,
  ProvidedVideoScene,
  toDecimals,
} from '../services/config/config';
import {ImageImportService} from '../services/image-import/image-import';
import {MediaSrcPipe} from '../services/media/media-src.pipe';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {EditableProjectTitle} from '../shared/editable-project-title/editable-project-title';
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
    MatIconModule,
    MatButtonModule,
    MatSliderModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatChipsModule,
    MatTooltipModule,
    MatSnackBarModule,
    FormsModule,
    MatProgressSpinnerModule,
    MediaSrcPipe,
    EditableProjectTitle,
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
  private imageImport = inject(ImageImportService);
  private snackBar = inject(MatSnackBar);

  videoElement = viewChild<ElementRef<HTMLVideoElement>>('mainVideo');
  timelineTrack = viewChild<ElementRef<HTMLElement>>('timelineTrack');

  readonly videoDuration = signal(0);

  /** True while an image is being dragged over the reference-image drop zone. */
  readonly isDragOver = signal(false);

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

  /**
   * Per-candidate display label combining the generation run with a letter for
   * the candidate's position within that run (e.g. "2A", "2B", "1A").
   *
   * Keyed by candidate object reference (candidates have no stable unique id;
   * the @for tracks on video?.url, which can be undefined for in-flight items).
   * The whole candidates array is walked once — including archived candidates —
   * so letters stay stable after archiving and match across the active list and
   * the archived expansion panel (both bind the same candidate objects).
   */
  runLabels = computed<Map<Candidate, string>>(() => {
    const scene = this.selectedScene();
    const map = new Map<Candidate, string>();
    if (!this.config.isGeneratedScene(scene) || !scene.candidates) {
      return map;
    }
    const seenPerRun = new Map<number, number>();
    for (const candidate of scene.candidates) {
      const n = seenPerRun.get(candidate.runNumber) ?? 0;
      seenPerRun.set(candidate.runNumber, n + 1);
      const letter = String.fromCharCode(65 + n); // 65 = 'A'
      map.set(candidate, `${candidate.runNumber}${letter}`);
    }
    return map;
  });

  /**
   * Theme class for a run's color sliver on the candidate chip. Runs cycle
   * through the theme picker's colors starting from the currently selected
   * theme: run 1 always matches the active theme, each later run steps to the
   * next swatch (wrapping). Reading primaryColor() makes the slivers re-tint
   * when the user changes the theme.
   */
  runSliceTheme(runNumber: number): string {
    const colors = ConfigService.THEME_COLORS;
    const current = Math.max(0, colors.indexOf(this.config.primaryColor()));
    return colors[(current + runNumber - 1) % colors.length];
  }

  /**
   * Hover tooltip for the run chip, spelling out the run number and the
   * candidate letter shown in the chip (e.g. "Run: 2, Candidate: A"). The
   * letter is the chip label with the run-number prefix removed, so it always
   * matches what runLabels() renders.
   */
  runTooltip(candidate: Candidate): string {
    const label = this.runLabels().get(candidate) ?? '';
    const letter = label.slice(String(candidate.runNumber).length);
    return `Run: ${candidate.runNumber}, Candidate: ${letter}`;
  }

  previewAspectRatio = computed(() => {
    const ratio = this.config.projectConfig.value().aspectRatio;
    return ratio ? ratio.replace(':', '/') : '16/9';
  });

  // --- Candidate sidebar: resizable + collapsible (session-only state) ---
  // NOTE: width/collapse are kept in component signals so they reset on reload.
  // They could later persist per project (e.g. a ProjectConfig field), but for
  // now Christopher only wants them to survive within a single session.
  static readonly SIDEBAR_MIN_WIDTH = 220;
  static readonly SIDEBAR_MAX_WIDTH = 640;
  static readonly SIDEBAR_DEFAULT_WIDTH = 280;
  static readonly SIDEBAR_RAIL_WIDTH = 44;

  /** Current width (px) of the candidate sidebar when expanded. */
  readonly sidebarWidth = signal(Storyboard.SIDEBAR_DEFAULT_WIDTH);
  /** Whether the candidate sidebar is collapsed to a thin rail. */
  readonly sidebarCollapsed = signal(false);

  /**
   * The grid track width to apply to the left sidebar column. When collapsed we
   * snap to a thin rail; otherwise we use the (clamped) resizable width. Driving
   * the grid track keeps the fluid thumbnails growing with the sidebar.
   */
  readonly sidebarTrackWidth = computed(() =>
    this.sidebarCollapsed()
      ? Storyboard.SIDEBAR_RAIL_WIDTH
      : this.sidebarWidth(),
  );

  /** Clamp a candidate width to the allowed min/max. */
  private clampSidebarWidth(width: number): number {
    return Math.min(
      Storyboard.SIDEBAR_MAX_WIDTH,
      Math.max(Storyboard.SIDEBAR_MIN_WIDTH, width),
    );
  }

  /** Set the sidebar width, clamped to the sensible min/max range. */
  setSidebarWidth(width: number): void {
    this.sidebarWidth.set(this.clampSidebarWidth(width));
  }

  /** Toggle the collapsed/expanded state of the candidate sidebar. */
  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed.update(collapsed => !collapsed);
  }

  // Pointer-drag bookkeeping for the resize handle.
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private readonly onResizeMove = (event: PointerEvent) => {
    const delta = event.clientX - this.resizeStartX;
    this.setSidebarWidth(this.resizeStartWidth + delta);
  };
  private readonly onResizeEnd = () => {
    window.removeEventListener('pointermove', this.onResizeMove);
    window.removeEventListener('pointerup', this.onResizeEnd);
  };

  /**
   * Begin a pointer-drag resize of the candidate sidebar. Listens on the window
   * so the drag keeps tracking even when the cursor leaves the thin handle.
   */
  startSidebarResize(event: PointerEvent): void {
    // Don't start a resize while collapsed (the handle is hidden anyway).
    if (this.sidebarCollapsed()) {
      return;
    }
    event.preventDefault();
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.sidebarWidth();
    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeEnd);
  }

  getThumbnailData(item: {
    lowQualityThumbnail?: string;
    highQualityThumbnail?: {path?: string; url?: string};
    referenceImage?: {path?: string; url?: string};
  }) {
    const hasLowQualityThumbnail = !!item.lowQualityThumbnail;
    const hasHighQualityThumbnail = !!(
      item.highQualityThumbnail?.url || item.highQualityThumbnail?.path
    );
    const hasReferenceImage = !!(
      item.referenceImage?.url || item.referenceImage?.path
    );
    const hasThumbnail = hasLowQualityThumbnail || hasHighQualityThumbnail;

    return {
      lowQuality: item.lowQualityThumbnail,
      // Media references; templates resolve them via the mediaSrc pipe.
      highQuality: hasHighQualityThumbnail
        ? item.highQualityThumbnail
        : undefined,
      reference: hasReferenceImage ? item.referenceImage : undefined,
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
  // Scenes whose video upload is in progress RIGHT NOW (in-memory, not
  // persisted). Drives the "Video is uploading…" preview only while the upload
  // is actually running; a scene with no video and not in this set is a video
  // upload that was interrupted (the user left mid-upload), shown as such.
  uploadingSceneIds = signal<Set<string>>(new Set());

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
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
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

    const minimumDurationMilliseconds = Math.round(
      MIN_RENDER_CLIP_DURATION_SECONDS * 1000,
    );
    const sourceDurationMilliseconds = Math.round(
      toDecimals(duration, 3) * 1000,
    );
    let startMilliseconds = Math.round(newTrim.start * 1000);
    let endMilliseconds = Math.round(newTrim.end * 1000);

    if (endMilliseconds - startMilliseconds < minimumDurationMilliseconds) {
      if (range.start !== undefined && range.end === undefined) {
        startMilliseconds = Math.max(
          0,
          endMilliseconds - minimumDurationMilliseconds,
        );
        if (endMilliseconds - startMilliseconds < minimumDurationMilliseconds) {
          endMilliseconds = Math.min(
            sourceDurationMilliseconds,
            startMilliseconds + minimumDurationMilliseconds,
          );
        }
      } else {
        endMilliseconds = Math.min(
          sourceDurationMilliseconds,
          startMilliseconds + minimumDurationMilliseconds,
        );
      }
      if (endMilliseconds - startMilliseconds < minimumDurationMilliseconds) {
        startMilliseconds = Math.max(
          0,
          endMilliseconds - minimumDurationMilliseconds,
        );
      }
    }
    newTrim.start = startMilliseconds / 1000;
    newTrim.end = endMilliseconds / 1000;

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
          // Mark the scene as actively uploading so the preview shows
          // "Video is uploading…" only while the upload is really running.
          this.uploadingSceneIds.update(ids => new Set(ids).add(newSceneId));
          try {
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
            // Persist the video now, BEFORE the thumbnail steps, so the scene's
            // "Video is uploading..." placeholder clears as soon as the upload
            // succeeds. Otherwise a thumbnail failure below would skip the only
            // signal-notifying write and strand the spinner forever even though
            // the video uploaded fine and is playable. Thumbnails are best-effort
            // and must not block this (mirrors uploadImage()).
            this.updateScenes(scene);
            try {
              scene.lowQualityThumbnail = await this.clientMediaService
                .generateLowQualityThumbnail(result.file, 'video')
                .then(blob => this.clientMediaService.toBase64(blob));
              scene.highQualityThumbnail = await this.clientMediaService
                .generateHighQualityThumbnail(result.file, 'video')
                .then(blob => this.clientMediaService.toFile(blob))
                .then(file => this.remixEngineService.uploadThumbnail(file));
              this.updateScenes(scene);
            } catch (error) {
              console.error(error);
            }
          } catch (error) {
            // The upload (or duration probe) failed. Recovery is handled by the
            // finally below clearing the uploading flag; log here so the failure
            // is diagnosable instead of escaping as an unhandled rejection.
            console.error(error);
          } finally {
            // Clear the in-memory uploading flag whether the upload succeeded
            // or failed. If the user left mid-upload this component is gone and
            // the scene stays video-less — on return it shows the "upload didn't
            // finish" state instead of a stuck "uploading…" spinner.
            this.uploadingSceneIds.update(ids => {
              const next = new Set(ids);
              next.delete(newSceneId);
              return next;
            });
          }
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
    // Returning to a scene re-applies its selected candidate's ingredients
    // (prompt + reference image), the same as clicking that candidate would.
    // Without this, the candidate is already selected, so a scene switch never
    // re-triggers selectCandidate — and a reference image cleared via
    // removeReferenceImage() then stays empty when you navigate back.
    const scene = this.config.projectConfig
      .value()
      .storyboard.find(s => s.id === id);
    if (
      scene &&
      this.config.isGeneratedScene(scene) &&
      scene.selectedCandidateIndex !== undefined &&
      scene.candidates?.[scene.selectedCandidateIndex]
    ) {
      // Re-apply the selected candidate's ingredients ONLY when the scene still
      // matches that candidate. If the user uploaded or removed a reference
      // image, or edited the prompt, without regenerating, re-applying would
      // silently revert (and persist over) those unsaved edits — so skip it.
      const candidate = scene.candidates[scene.selectedCandidateIndex];
      const hasUnsavedEdits =
        scene.prompt !== candidate.prompt ||
        scene.referenceImage?.path !== candidate.referenceImage?.path ||
        scene.referenceImage?.url !== candidate.referenceImage?.url;
      if (!hasUnsavedEdits) {
        this.selectCandidate(scene, scene.selectedCandidateIndex);
      }
    }
    // Opening a failed scene clears its "!" badge (persisted, so it stays
    // cleared after a reload). The error message itself remains in the preview.
    if (
      scene &&
      this.config.isGeneratedScene(scene) &&
      scene.generationError &&
      !scene.generationErrorAcknowledged
    ) {
      scene.generationErrorAcknowledged = true;
      this.updateScenes(scene);
    }
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

  /** True while this scene's video upload is actively in progress. */
  isUploadingScene(id: string): boolean {
    return this.uploadingSceneIds().has(id);
  }

  /**
   * A scene whose last generation failed and that the user hasn't opened since
   * — drives the temporary "!" badge on its filmstrip thumbnail.
   */
  hasUnseenFailure(scene: GeneratedScene | ProvidedVideoScene): boolean {
    return (
      this.config.isGeneratedScene(scene) &&
      !!scene.generationError &&
      !scene.generationErrorAcknowledged
    );
  }

  /** The failure message to show in the preview area, if the scene has one. */
  generationErrorOf(
    scene: GeneratedScene | ProvidedVideoScene,
  ): string | undefined {
    return this.config.isGeneratedScene(scene)
      ? scene.generationError
      : undefined;
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
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent) {
    if (this.imageImport.hasLeftDropZone(event)) {
      this.isDragOver.set(false);
    }
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    void this.imageImport.importFromDrop(
      event.dataTransfer,
      file => this.processFile(file),
      reason =>
        this.snackBar.open(
          this.imageImport.importFailureMessage(reason),
          'Close',
          {duration: 5000},
        ),
    );
  }

  /**
   * Paste a copied image to set it as the selected scene's reference image.
   * Only image pastes are consumed; text pastes (e.g. into the prompt field)
   * are left untouched, as are pastes while the user is typing in a field.
   */
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    // Don't consume pastes meant for an open dialog (e.g. Add scene).
    if (this.dialog.openDialogs.length > 0) {
      return;
    }
    // If the user is typing in a text field, leave their paste alone.
    if (this.imageImport.isEditableTarget(document.activeElement)) {
      return;
    }
    const images = this.imageImport.imageFilesFromDataTransfer(
      event.clipboardData,
    );
    if (images.length === 0) {
      return;
    }
    if (!this.config.isGeneratedScene(this.selectedScene())) {
      return;
    }
    event.preventDefault();
    this.processFile(images[0]);
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
    console.debug('Upload triggered for file:', file.name);
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
          console.error(error);
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
      // While a generation is in flight, the placeholder count must reflect
      // what THAT run requested — not the live slider. The lost-candidates fix
      // persists a per-scene pendingGeneration marker that captures
      // requestedCount at start, so snapshot from there. Without an in-flight
      // marker (no run in progress) fall back to the live config.
      const requestedCount =
        scene.pendingGeneration?.requestedCount ??
        this.config.projectConfig.value().numberOfCandidates;
      return Array.from({length: requestedCount}).fill(0);
    }
    return [];
  });
}
