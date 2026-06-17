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
  computed,
  effect,
  ElementRef,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatChipsModule} from '@angular/material/chips';
import {MatDialog} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSliderModule} from '@angular/material/slider';
import {MatTooltipModule} from '@angular/material/tooltip';
import {FormatTimePipe} from '../pipes/format-time-pipe';
import {
  ConfigService,
  DEFAULT_TRANSITION_OVERLAP,
} from '../services/config/config';
import {MediaRef, MediaService} from '../services/media/media';
import {MediaSrcPipe} from '../services/media/media-src.pipe';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {EditableProjectTitle} from '../shared/editable-project-title/editable-project-title';
import {AudioUploadDialog} from './audio-upload-dialog/audio-upload-dialog';
import {ImageUploadDialog} from './image-upload-dialog/image-upload-dialog';
import {TransitionModal} from './transition-modal/transition-modal';

/**
 * Interface for scene start and end times.
 */
export interface SceneTiming {
  id: string;
  name: string;
  start: number;
  end: number;
}

/**
 * Component for the composition view.
 */
@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormatTimePipe,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatFormFieldModule,
    MatSliderModule,
    MatTooltipModule,
    MediaSrcPipe,
    TransitionModal,
    EditableProjectTitle,
  ],
  templateUrl: './composition.html',
  styleUrl: './composition.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Composition {
  configService = inject(ConfigService);
  private remixEngineService = inject(RemixEngineService);
  private mediaService = inject(MediaService);
  private dialog = inject(MatDialog);

  combiningScenes = this.remixEngineService.combiningScenes;

  videoElement = viewChild<ElementRef<HTMLVideoElement>>('mainVideo');

  scenes = computed(() => this.configService.projectConfig.value().storyboard);

  previewAspectRatio = computed(() => {
    const ratio = this.configService.projectConfig.value().aspectRatio;
    return ratio ? ratio.replace(':', '/') : '16/9';
  });

  filmstripScenes = computed(() => {
    return this.scenes().filter(scene => {
      if (
        this.configService.isGeneratedScene(scene) &&
        scene.candidates &&
        scene.selectedCandidateIndex !== undefined
      ) {
        // Downstream resolves media by path (signing it on read), so a scene
        // persisted with a path but a blank url is still renderable: accept
        // either a path or a url.
        const video = scene.candidates[scene.selectedCandidateIndex].video;
        return !!(video?.path || video?.url);
      }
      if (this.configService.isProvidedVideoScene(scene)) {
        return !!(scene.video?.path || scene.video?.url);
      }
      return false;
    });
  });

  playlist = computed(() => {
    return this.filmstripScenes()
      .map(scene => {
        if (this.configService.isGeneratedScene(scene)) {
          if (!scene.candidates || scene.selectedCandidateIndex === undefined) {
            return;
          }
          const candidate = scene.candidates[scene.selectedCandidateIndex];
          const start = candidate.trim?.start ?? 0;
          const end = candidate.trim?.end ?? candidate.durationSeconds;
          return {
            id: scene.id,
            name: scene.name,
            video: candidate.video,
            start,
            end,
            duration: end - start,
            transitionOverlap: scene.transitionOverlap,
            type: 'generated' as const,
          };
        } else {
          // VideoScene
          const start = scene.trim?.start ?? 0;
          const end = scene.trim?.end ?? scene.durationSeconds!;
          return {
            id: scene.id,
            name: scene.name,
            video: scene.video,
            start,
            end,
            duration: end - start,
            transitionOverlap: scene.transitionOverlap,
            type: 'video' as const,
          };
        }
      })
      .filter(item => item !== undefined);
  });

  /**
   * True when at least one scene contributes a usable video to the render
   * (a selected candidate with a video, or an uploaded video scene). The
   * playlist already filters to exactly those scenes, so an empty playlist
   * means there is nothing to combine — rendering would fail in the backend
   * with "cannot generate video without at least one video input", so we block
   * it in the UI instead.
   */
  canRender = computed(() => this.playlist().length > 0);

  currentPlaylistIndex = signal(0);
  isPlaying = signal(false);
  // Records whether playback was running when a scrubber drag began, so the
  // drag-end handler knows whether to resume. Reset to false whenever no drag
  // is in progress; non-null only between onScrubStart and onScrubEnd.
  private wasPlayingBeforeScrub = false;
  isMuted = signal(false);
  videoVolume = signal(0.5);
  // Total playback progress across all scenes (in seconds)
  totalCurrentTime = signal(0);

  // Total duration of the playlist (sum of known durations)
  totalDuration = computed(() =>
    this.playlist().reduce((acc, item) => acc + item.duration, 0),
  );

  sceneTimings = computed(() => {
    let currentTime = 0;
    return this.playlist().map((scene, index, scenes) => {
      const nextSceneTransitionOverlap =
        scenes[index + 1]?.transitionOverlap ?? 0;
      const start = currentTime + (scene.transitionOverlap ?? 0);
      const end = currentTime + scene.duration - nextSceneTransitionOverlap;
      currentTime = end;
      return {
        id: scene.id,
        name: scene.name,
        start,
        end,
      };
    });
  });

  // The current scene's media reference; the held-src effect below resolves
  // it to the URL string bound to the player's [src].
  currentVideoSrc = computed(() => {
    const playlist = this.playlist();
    const index = this.currentPlaylistIndex();
    if (index >= 0 && index < playlist.length) {
      return playlist[index].video;
    }
    return '';
  });

  // The URL string bound to the player's [src]. Computed synchronously
  // whenever the URL needs no I/O (a warm signed-URL cache hit), so it is
  // available in the same
  // change-detection pass that computes the playlist — the exact timing the
  // impure mediaSrc pipe gave this binding at baseline. On a cache miss the
  // previous URL is held (never reset to null; stale-while-revalidate)
  // while the constructor effect below resolves the new one, so cross-clip
  // seeks never tear the <video> element down mid-resolve. Scoped to the
  // composition player only — the mediaSrc pipe used elsewhere is
  // unchanged.
  heldVideoSrc = linkedSignal<MediaRef | '' | undefined, string | null>({
    source: () => this.currentVideoSrc(),
    computation: (ref, previous) => {
      if (!ref) {
        return null;
      }
      const synchronous = this.syncVideoSrc(ref);
      if (synchronous !== undefined) {
        return synchronous;
      }
      // Cache miss: hold the previous src while the constructor effect
      // resolves the new one.
      return previous?.value ?? null;
    },
  });

  /**
   * Resolves a media ref to a player src without I/O where that is possible:
   * the cached signed URL for the path, or the stored URL for path-less
   * legacy refs. Returns undefined when only `MediaService.resolve`'s async
   * fetch (signing the path via /api/signUrl) can produce the URL.
   */
  private syncVideoSrc(ref: MediaRef): string | null | undefined {
    if (!ref.path) {
      // Path-less legacy ref: fall back to the stored URL.
      return ref.url ?? null;
    }
    return this.mediaService.getCachedUrl(ref.path);
  }

  constructor() {
    // Pre-warm the signed-URL cache for every playlist entry with one batch
    // request, so cross-clip seeks resolve the new src synchronously from
    // the cache in the same change-detection pass.
    effect(() => {
      const paths = this.playlist()
        .map(item => item.video?.path)
        .filter((path): path is string => !!path);
      if (paths.length === 0) {
        return;
      }
      void this.mediaService.signUrls(paths).catch((error: unknown) => {
        // Best-effort: the held-src effect below re-signs the current clip
        // on demand, so playback recovers per clip.
        console.error('Failed to pre-sign playlist video URLs', error);
      });
    });

    // Resolve current-clip cache misses (heldVideoSrc holds the previous
    // src meanwhile). Delegates to MediaService.resolve, which signs the path
    // via /api/signUrl (deduped against the pre-warm batch above).
    effect(() => {
      const ref = this.currentVideoSrc();
      if (!ref || this.syncVideoSrc(ref) !== undefined) {
        return;
      }
      void this.mediaService
        .resolve(ref)
        .then(url => {
          // Only apply if this clip is still the current one.
          if (this.currentVideoSrc() === ref) {
            this.heldVideoSrc.set(url || null);
          }
        })
        .catch((error: unknown) => {
          console.error(`Failed to resolve video src for ${ref.path}`, error);
        });
    });

    effect(() => {
      const src = this.heldVideoSrc();
      const playing = this.isPlaying();
      const video = this.videoElement()?.nativeElement;

      if (video && src) {
        if (playing) {
          this.startPlaybackLoop();
          video.play().catch(err => {
            // AbortError is common when changing src quickly, we can ignore it
            if (err.name !== 'AbortError') {
              console.error('Play error:', err);
            }
          });
        } else {
          this.stopPlaybackLoop();
          video.pause();
        }
      }
    });
  }

  private playbackFrameId: number | null = null;

  private startPlaybackLoop() {
    this.stopPlaybackLoop();
    const loop = () => {
      this.onTimeUpdate();
      this.playbackFrameId = requestAnimationFrame(loop);
    };
    this.playbackFrameId = requestAnimationFrame(loop);
  }

  private stopPlaybackLoop() {
    if (this.playbackFrameId !== null) {
      cancelAnimationFrame(this.playbackFrameId);
      this.playbackFrameId = null;
    }
  }

  isTransitionModalVisible = signal(false);
  selectedCandidateIndex = signal<number | null>(null);
  maxTransitionOverlap = signal<number>(DEFAULT_TRANSITION_OVERLAP);

  readonly transitions = [
    {id: 'fade', name: 'Fade'},
    {id: 'wipeleft', name: 'Wipe Left'},
    {id: 'wiperight', name: 'Wipe Right'},
    {id: 'wipeup', name: 'Wipe Up'},
    {id: 'wipedown', name: 'Wipe Down'},
    {id: 'circleclose', name: 'Circle Close'},
    {id: 'circlecrop', name: 'Circle Crop'},
    {id: 'circleopen', name: 'Circle Open'},
    {id: 'diagbl', name: 'Diagonal Bottom-Left'},
    {id: 'diagbr', name: 'Diagonal Bottom-Right'},
    {id: 'diagtl', name: 'Diagonal Top-Left'},
    {id: 'diagtr', name: 'Diagonal Top-Right'},
    {id: 'distance', name: 'Distance'},
    {id: 'dissolve', name: 'Dissolve'},
    {id: 'fadeblack', name: 'Fade Black'},
    {id: 'fadegrays', name: 'Fade Grays'},
    {id: 'fadewhite', name: 'Fade White'},
    {id: 'hblur', name: 'Horizontal Blur'},
    {id: 'hlslice', name: 'HL Slice'},
    {id: 'horzclose', name: 'Horizontal Close'},
    {id: 'horzopen', name: 'Horizontal Open'},
    {id: 'hrslice', name: 'HR Slice'},
    {id: 'pixelize', name: 'Pixelize'},
    {id: 'radial', name: 'Radial'},
    {id: 'rectcrop', name: 'Rect Crop'},
    {id: 'slideleft', name: 'Slide Left'},
    {id: 'slideright', name: 'Slide Right'},
    {id: 'slideup', name: 'Slide Up'},
    {id: 'slidedown', name: 'Slide Down'},
    {id: 'smoothleft', name: 'Smooth Left'},
    {id: 'smoothright', name: 'Smooth Right'},
    {id: 'smoothup', name: 'Smooth Up'},
    {id: 'smoothdown', name: 'Smooth Down'},
    {id: 'squeezeh', name: 'Squeeze Horizontal'},
    {id: 'squeezev', name: 'Squeeze Vertical'},
    {id: 'vdslice', name: 'VD Slice'},
    {id: 'vertclose', name: 'Vert Close'},
    {id: 'vertopen', name: 'Vert Open'},
    {id: 'vuslice', name: 'VU Slice'},
    {id: 'wipebl', name: 'Wipe Bottom-Left'},
    {id: 'wipebr', name: 'Wipe Bottom-Right'},
    {id: 'wipetl', name: 'Wipe Top-Left'},
    {id: 'wipetr', name: 'Wipe Top-Right'},
  ];

  togglePlay(): void {
    this.isPlaying.update(playing => !playing);
  }

  playNext(): void {
    const nextIndex = this.currentPlaylistIndex() + 1;
    if (nextIndex < this.playlist().length) {
      this.currentPlaylistIndex.set(nextIndex);
    } else {
      // End of playlist
      this.isPlaying.set(false);
      this.currentPlaylistIndex.set(0); // Reset to start
      const video = this.videoElement()?.nativeElement;
      if (video) video.pause();
    }
  }

  onTimeUpdate(): void {
    const video = this.videoElement()?.nativeElement;
    const currentIndex = this.currentPlaylistIndex();

    // Ignore updates if video is not ready, is seeking, or we've already moved on
    if (!video || video.seeking || video.readyState < 2) return;

    const currentItem = this.playlist()[currentIndex];
    if (!currentItem) return;

    if (video.currentTime >= currentItem.end && currentItem.end !== Infinity) {
      this.playNext();
      return;
    }

    // Update global timeline progress
    let previousDuration = 0;
    for (let i = 0; i < currentIndex; i++) {
      previousDuration += this.playlist()[i].duration;
    }

    // Calculate effective time within the current clip (relative to trim start)
    const effectiveCurrentTime = Math.max(
      0,
      video.currentTime - currentItem.start,
    );
    this.totalCurrentTime.set(previousDuration + effectiveCurrentTime);
  }

  /**
   * Within-clip offset to restore after the next clip's metadata loads. Set by
   * seek() for a cross-clip seek, where the [src] swap reloads the <video> and
   * would otherwise snap playback to the clip start, dropping the scrubbed-to
   * position. Reset to 0 once applied (and for normal clip advancement).
   */
  private pendingSeekOffset = 0;

  onVideoLoadedMetadata(): void {
    const video = this.videoElement()?.nativeElement;
    if (!video) return;

    const playlist = this.playlist();
    const index = this.currentPlaylistIndex();
    const currentItem = playlist[index];

    if (currentItem) {
      const target = currentItem.start + this.pendingSeekOffset;
      this.pendingSeekOffset = 0;
      if (Math.abs(video.currentTime - target) > 0.5) {
        video.currentTime = target;
      }
    }
  }

  seek(event: Event): void {
    const input = event.target as HTMLInputElement;
    const seekTime = Number(input.value);

    let accumulatedTime = 0;
    let foundIndex = -1;
    let timeInClip = 0;

    const playlist = this.playlist();
    for (let i = 0; i < playlist.length; i++) {
      const item = playlist[i];
      if (
        seekTime >= accumulatedTime &&
        seekTime <= accumulatedTime + item.duration
      ) {
        foundIndex = i;
        timeInClip = seekTime - accumulatedTime;
        break;
      }
      accumulatedTime += item.duration;
    }

    if (foundIndex !== -1) {
      const previousIndex = this.currentPlaylistIndex();
      this.currentPlaylistIndex.set(foundIndex);
      const item = playlist[foundIndex];
      this.totalCurrentTime.set(seekTime);
      const video = this.videoElement()?.nativeElement;
      if (video) {
        if (foundIndex === previousIndex) {
          // Same clip already loaded: seek directly, no reload coming.
          this.pendingSeekOffset = 0;
          video.currentTime = item.start + timeInClip;
        } else {
          // Different clip: the [src] swap reloads the <video> and fires
          // onVideoLoadedMetadata; stash the within-clip offset so it restores
          // the scrubbed-to position instead of snapping to the clip start.
          this.pendingSeekOffset = timeInClip;
        }
      }
    }
  }

  /**
   * Called when the user grabs the timeline scrubber (Material's `dragStart`).
   * Records whether playback was running and pauses, so the position the user
   * holds is what stays on screen — the playback loop is gated on isPlaying()
   * and would otherwise keep advancing currentTime past the held frame.
   */
  onScrubStart(): void {
    this.wasPlayingBeforeScrub = this.isPlaying();
    if (this.wasPlayingBeforeScrub) {
      this.isPlaying.set(false);
    }
  }

  /**
   * Called when the user releases the timeline scrubber (Material's `dragEnd`).
   * Resumes playback only if it was running when the drag began, matching the
   * least-surprising editor-scrubbing behavior.
   */
  onScrubEnd(): void {
    if (this.wasPlayingBeforeScrub) {
      this.isPlaying.set(true);
    }
    this.wasPlayingBeforeScrub = false;
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  openTransitionModal(index: number): void {
    this.selectedCandidateIndex.set(index);
    this.maxTransitionOverlap.set(
      0.5 *
        Math.min(
          this.playlist()[index].duration,
          this.playlist()[index - 1]?.duration ?? DEFAULT_TRANSITION_OVERLAP,
        ),
    );
    this.isTransitionModalVisible.set(true);
  }

  onTransitionSelected(transition: {id: string; overlap: number} | null): void {
    const index = this.selectedCandidateIndex();
    if (index === null) {
      return;
    }

    const filmstripScenes = this.filmstripScenes();
    const sceneInFilmstrip = filmstripScenes[index];
    if (!sceneInFilmstrip) {
      return;
    }

    const scenes = this.configService.projectConfig.value().storyboard;
    const sceneIndex = scenes.findIndex(s => s.id === sceneInFilmstrip.id);

    if (sceneIndex !== -1) {
      const updatedScene = {
        ...scenes[sceneIndex],
      };

      if (transition !== null) {
        updatedScene.transition = transition.id;
        updatedScene.transitionOverlap = transition.overlap;
      } else {
        delete updatedScene.transition;
        delete updatedScene.transitionOverlap;
      }

      const updatedScenes = [...scenes];
      updatedScenes[sceneIndex] = updatedScene;

      this.configService.updateProjectConfig({storyboard: updatedScenes});
    }

    this.isTransitionModalVisible.set(false);
    this.selectedCandidateIndex.set(null);
  }

  openAudioUploadDialog(trackIndex?: number) {
    const audioTracks = this.configService.projectConfig.value().audioTracks;
    const track = trackIndex !== undefined ? audioTracks[trackIndex] : null;

    this.dialog.open(AudioUploadDialog, {
      width: '500px',
      data: {track, trackIndex, sceneTimings: this.sceneTimings()},
      autoFocus: 'dialog',
    });
  }

  removeAudioTrack(index: number) {
    const audioTracks = [
      ...(this.configService.projectConfig.value().audioTracks || []),
    ];
    audioTracks.splice(index, 1);
    this.configService.updateProjectConfig({audioTracks});
  }

  openImageUploadDialog(overlayIndex?: number) {
    const visualOverlays =
      this.configService.projectConfig.value().visualOverlays;
    const overlay =
      overlayIndex !== undefined ? visualOverlays[overlayIndex] : null;

    this.dialog.open(ImageUploadDialog, {
      width: '500px',
      data: {
        overlay,
        overlayIndex,
        videoDurationSeconds: this.totalDuration,
        sceneTimings: this.sceneTimings(),
      },
      autoFocus: 'dialog',
    });
  }

  removeVisualOverlay(index: number) {
    const visualOverlays = [
      ...(this.configService.projectConfig.value().visualOverlays || []),
    ];
    visualOverlays.splice(index, 1);
    this.configService.updateProjectConfig({visualOverlays});
  }

  getMinValue(a: number, b: number) {
    return Math.min(a, b);
  }

  renderVideo() {
    void this.remixEngineService.combineScenes();
  }

  changeVolume(event: Event) {
    const input = event.target as HTMLInputElement;
    const newVolume = Number(input.value);

    this.videoVolume.set(newVolume);

    // Automatic unmute when user drags slider
    if (newVolume > 0 && this.isMuted()) {
      this.isMuted.set(false);
    }
  }
}
