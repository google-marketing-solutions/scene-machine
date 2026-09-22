/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for the archived-candidate render leak.
 *
 * Archiving a candidate hides its card in the storyboard. Before the fix, the
 * scene's `selectedCandidateIndex` still pointed at the archived candidate and
 * `resolveSceneRenderClip` had no `isArchived` check, so the hidden clip was
 * still submitted to the combine workflow and appeared in the final video.
 *
 * Two independent guards are asserted here, because either one alone would
 * still leave a way in:
 *   1. `toggleArchive` clears the selection (storyboard.ts).
 *   2. `resolveSceneRenderClip` refuses an archived candidate (config.ts).
 */
import {HttpClient} from '@angular/common/http';
import {signal, type WritableSignal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../client-media/client-media';
import {
  ConfigService,
  resolveSceneRenderClip,
  type GeneratedScene,
} from './config';
import {MediaService} from '../media/media';
import {RemixEngineService} from '../remix-engine/remix-engine';
import {Router} from '@angular/router';
import {Subject} from 'rxjs';
import {MatDialog} from '@angular/material/dialog';
import {CandidateVideoCacheService} from '../media/candidate-video-cache';
import {ThumbnailCacheService} from '../media/thumbnail-cache';
import {ImagePreviewService} from '../image-preview/image-preview';
import {ImageImportService} from '../image-import/image-import';
import {Storyboard} from '../../storyboard/storyboard';

/** A scene whose selected candidate is archived, but otherwise renderable. */
function archivedSelectedScene(): GeneratedScene {
  return {
    id: 'scene-archived',
    type: 'generated',
    name: 'Archived but selected',
    selectedCandidateIndex: 0,
    candidates: [
      {
        video: {path: 'videos/archived.mp4', url: ''},
        durationSeconds: 10,
        isArchived: true,
      },
    ],
  } as any;
}

describe('archived candidates are never rendered', () => {
  it('resolveSceneRenderClip reports "not-selected" for an archived selected candidate', () => {
    expect(resolveSceneRenderClip(archivedSelectedScene()).state).toBe(
      'not-selected',
    );
  });

  it('resolveSceneRenderClip still resolves an ACTIVE selected candidate', () => {
    const scene = archivedSelectedScene();
    scene.candidates![0].isArchived = false;
    const resolution = resolveSceneRenderClip(scene);
    expect(resolution.state).toBe('ready');
    expect((resolution as any).clip.video.path).toBe('videos/archived.mp4');
  });

  it('reports "not-selected" rather than "invalid" so the Render button stays enabled', () => {
    // 'invalid' would disable rendering for the whole project; an archived
    // candidate should only drop its own scene out of the playlist.
    expect(resolveSceneRenderClip(archivedSelectedScene()).state).not.toBe(
      'invalid',
    );
  });

  describe('end-to-end through the combine workflow', () => {
    let service: RemixEngineService;
    let projectConfigSignal: WritableSignal<any>;
    let globalConfigSignal: WritableSignal<any>;
    let mediaServiceMock: any;

    beforeEach(() => {
      vi.clearAllMocks();
      globalConfigSignal = signal<any>({
        gcpProject: 'mock-project',
        gcpLocation: 'mock-location',
        gcsBucket: 'mock-bucket',
        tasksQueuePrefix: 'mock-queue',
        veoLocation: 'mock-veo-loc',
        duration: 5,
        veoModel: 'mock-veo',
        numberOfCandidates: 2,
        generateAudio: true,
      });
      projectConfigSignal = signal<any>({
        id: 'project-1',
        resolution: '720p',
        aspectRatio: '16:9',
        numberOfCandidates: 2,
        candidateDurationSeconds: 5,
        generateAudio: true,
        model: 'mock-veo',
        storyboard: [],
      });
      mediaServiceMock = {
        signUrl: vi.fn(),
        signUrls: vi.fn().mockResolvedValue(new Map()),
        upload: vi.fn(),
        getBlob: vi.fn(),
        resolve: vi.fn(),
      };
      TestBed.configureTestingModule({
        providers: [
          RemixEngineService,
          {
            provide: ConfigService,
            useValue: {
              globalConfig: {value: globalConfigSignal},
              projectConfig: {value: projectConfigSignal},
              isGeneratedScene: vi.fn((s: any) => s?.type === 'generated'),
              isProvidedVideoScene: vi.fn((s: any) => s?.type === 'video'),
              updateProjectConfig: vi.fn(),
              addRenderRun: vi.fn(),
              setPendingRender: vi.fn(),
              flushPendingSave: vi.fn(),
              videoEditModels: vi.fn().mockReturnValue([]),
              canEditCandidates: vi.fn().mockReturnValue(false),
              audioLocked: vi.fn().mockReturnValue(false),
              resolveVideoLocation: vi.fn().mockReturnValue('mock-veo-loc'),
            },
          },
          {provide: HttpClient, useValue: {post: vi.fn(), get: vi.fn()}},
          {
            provide: ClientMediaService,
            useValue: {
              generateLowQualityThumbnail: vi.fn(),
              generateHighQualityThumbnail: vi.fn(),
              toBase64: vi.fn(),
              toFile: vi.fn(),
            },
          },
          {provide: MediaService, useValue: mediaServiceMock},
          {provide: MatSnackBar, useValue: {open: vi.fn()}},
        ],
      });
      service = TestBed.inject(RemixEngineService);
      TestBed.tick();
    });

    it('does not submit an archived candidate to the combine workflow', async () => {
      projectConfigSignal.set({
        ...projectConfigSignal(),
        storyboard: [archivedSelectedScene()],
        audioTracks: [],
        visualOverlays: [],
      });
      const startSpy = vi
        .spyOn(service, 'startCombineScenesWorkflow')
        .mockResolvedValue(of({executionId: 'render-exec-id'}) as any);

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('still submits an ACTIVE candidate', async () => {
      const scene = archivedSelectedScene();
      scene.candidates![0].isArchived = false;
      projectConfigSignal.set({
        ...projectConfigSignal(),
        storyboard: [scene],
        audioTracks: [],
        visualOverlays: [],
      });
      const startSpy = vi
        .spyOn(service, 'startCombineScenesWorkflow')
        .mockResolvedValue(of({executionId: 'render-exec-id'}) as any);
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'renders/output.mp4'}]}}},
      } as any);
      mediaServiceMock.signUrl.mockResolvedValue(
        'https://signed.example/renders/output.mp4',
      );

      await service.combineScenes();

      expect(startSpy).toHaveBeenCalledWith(
        [
          {
            file_type: 'video',
            file_path: 'videos/archived.mp4',
            start_time: 0,
            skip_time: 0,
            duration: 10,
            include_audio: true,
          },
        ],
        false,
      );
    });
  });

  describe('toggleArchive', () => {
    let storyboardComponent: Storyboard;
    let projectConfigSignal: WritableSignal<any>;
    let candidateVideoCacheMock: any;
    let thumbnailCacheMock: any;

    beforeEach(async () => {
      vi.clearAllMocks();
      projectConfigSignal = signal<any>({
        id: 'project-1',
        storyboard: [],
      });
      candidateVideoCacheMock = {
        invalidateCandidate: vi.fn(),
      };
      thumbnailCacheMock = {
        invalidateCandidate: vi.fn(),
        acquire: vi.fn(),
      };

      await TestBed.configureTestingModule({
        imports: [Storyboard],
        providers: [
          {
            provide: ConfigService,
            useValue: {
              projectConfig: {value: projectConfigSignal},
              globalConfig: {value: () => ({})},
              updateProjectConfig: vi.fn((partial: any) => {
                projectConfigSignal.update(c => ({...c, ...partial}));
              }),
              isGeneratedScene: (s: any) => s?.type === 'generated',
              isProvidedVideoScene: (s: any) => s?.type === 'video',
            },
          },
          {
            provide: RemixEngineService,
            useValue: {
              setForegroundScene: vi.fn(),
              clearForegroundScene: vi.fn(),
            },
          },
          {provide: MatDialog, useValue: {open: vi.fn()}},
          {provide: ClientMediaService, useValue: {}},
          {provide: ImagePreviewService, useValue: {create: vi.fn()}},
          {provide: ImageImportService, useValue: {}},
          {provide: MatSnackBar, useValue: {open: vi.fn()}},
          {provide: HttpClient, useValue: {}},
          {
            provide: MediaService,
            useValue: {resolve: vi.fn(), getCachedUrl: vi.fn()},
          },
          {
            provide: CandidateVideoCacheService,
            useValue: candidateVideoCacheMock,
          },
          {provide: ThumbnailCacheService, useValue: thumbnailCacheMock},
          {provide: Router, useValue: {events: new Subject()}},
        ],
      })
        .overrideComponent(Storyboard, {
          set: {template: ''},
        })
        .compileComponents();

      const fixture = TestBed.createComponent(Storyboard);
      storyboardComponent = fixture.componentInstance;
    });

    it('clears selectedCandidateIndex when the selected candidate is archived', () => {
      const scene: GeneratedScene = {
        id: 'scene-1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test prompt',
        selectedCandidateIndex: 0,
        candidates: [
          {
            video: {path: 'videos/c0.mp4', url: ''},
            durationSeconds: 5,
            isArchived: false,
          },
          {
            video: {path: 'videos/c1.mp4', url: ''},
            durationSeconds: 5,
            isArchived: false,
          },
        ] as any,
      };
      projectConfigSignal.set({
        id: 'project-1',
        storyboard: [scene],
      });

      storyboardComponent.toggleArchive(new Event('click'), scene, 0);

      expect(scene.candidates![0].isArchived).toBe(true);
      expect(scene.selectedCandidateIndex).toBeUndefined();
    });

    it('leaves selectedCandidateIndex alone when a DIFFERENT candidate is archived (control)', () => {
      const scene: GeneratedScene = {
        id: 'scene-1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test prompt',
        selectedCandidateIndex: 0,
        candidates: [
          {
            video: {path: 'videos/c0.mp4', url: ''},
            durationSeconds: 5,
            isArchived: false,
          },
          {
            video: {path: 'videos/c1.mp4', url: ''},
            durationSeconds: 5,
            isArchived: false,
          },
        ] as any,
      };
      projectConfigSignal.set({
        id: 'project-1',
        storyboard: [scene],
      });

      storyboardComponent.toggleArchive(new Event('click'), scene, 1);

      expect(scene.candidates![1].isArchived).toBe(true);
      expect(scene.selectedCandidateIndex).toBe(0);
    });

    it('evicts video, thumbnail, referenceImage, and preview path from caches on archive', () => {
      const scene: GeneratedScene = {
        id: 'scene-1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test prompt',
        selectedCandidateIndex: 0,
        candidates: [
          {
            video: {path: 'videos/c0.mp4', url: ''},
            highQualityThumbnail: {path: 'thumbs/hq0.jpg', url: ''},
            referenceImage: {
              path: 'refs/ref0.jpg',
              url: '',
              preview: {path: 'previews/prev0.jpg', url: ''},
            },
            durationSeconds: 5,
            isArchived: false,
          },
        ] as any,
      };
      projectConfigSignal.set({
        id: 'project-1',
        storyboard: [scene],
      });

      storyboardComponent.toggleArchive(new Event('click'), scene, 0);

      expect(candidateVideoCacheMock.invalidateCandidate).toHaveBeenCalledWith(
        'project-1',
        'videos/c0.mp4',
      );
      expect(thumbnailCacheMock.invalidateCandidate).toHaveBeenCalledWith(
        'project-1',
        'thumbs/hq0.jpg',
      );
      expect(thumbnailCacheMock.invalidateCandidate).toHaveBeenCalledWith(
        'project-1',
        'refs/ref0.jpg',
      );
      expect(thumbnailCacheMock.invalidateCandidate).toHaveBeenCalledWith(
        'project-1',
        'previews/prev0.jpg',
      );
    });
  });
});
