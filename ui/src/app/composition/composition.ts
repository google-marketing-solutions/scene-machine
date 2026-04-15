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
import {RemixEngineService} from '../services/remix-engine/remix-engine';
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
    TransitionModal,
  ],
  templateUrl: './composition.html',
  styleUrl: './composition.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Composition {
  configService = inject(ConfigService);
  private remixEngineService = inject(RemixEngineService);
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
        return scene.candidates[scene.selectedCandidateIndex].video?.url;
      }
      if (this.configService.isProvidedVideoScene(scene)) {
        return scene.video?.url;
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
            url: candidate.video?.url,
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
            url: scene.video?.url,
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

  currentPlaylistIndex = signal(0);
  isPlaying = signal(false);
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

  currentVideoSrc = computed(() => {
    const playlist = this.playlist();
    const index = this.currentPlaylistIndex();
    if (index >= 0 && index < playlist.length) {
      return playlist[index].url;
    }
    return '';
  });

  constructor() {
    effect(() => {
      const src = this.currentVideoSrc();
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

  onVideoLoadedMetadata(): void {
    const video = this.videoElement()?.nativeElement;
    if (!video) return;

    const playlist = this.playlist();
    const index = this.currentPlaylistIndex();
    const currentItem = playlist[index];

    if (currentItem) {
      if (Math.abs(video.currentTime - currentItem.start) > 0.5) {
        video.currentTime = currentItem.start;
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
      this.currentPlaylistIndex.set(foundIndex);
      const item = playlist[foundIndex];
      const video = this.videoElement()?.nativeElement;
      if (video) {
        video.currentTime = item.start + timeInClip;
        this.totalCurrentTime.set(seekTime);
      }
    }
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
