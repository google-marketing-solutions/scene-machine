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

import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {MatSnackBar} from '@angular/material/snack-bar';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
} from '../services/config/config';
import {ClientMediaService} from '../services/client-media/client-media';
import {MediaService} from '../services/media/media';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Storyboard} from './storyboard';

describe('edit candidate placeholder reproduction', () => {
  let fixture: ComponentFixture<Storyboard>;
  let project: ReturnType<typeof signal<ProjectConfig>>;
  let http: HttpTestingController;
  let uploadText: Promise<{path: string}>;
  let resolveUploadText!: (result: {path: string}) => void;

  beforeEach(async () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      video: {
        path: 'videos/scene-1.mp4',
        url: 'https://example.test/scene-1.mp4',
      },
      model: 'veo',
      prompt: 'original prompt',
      generateAudio: true,
      resolution: '720p',
    };
    const scene: GeneratedScene = {
      id: 'scene-1',
      name: 'Scene 1',
      type: 'generated',
      prompt: 'original prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };
    project = signal<ProjectConfig>({
      id: 'project-1',
      name: 'Placeholder repro',
      storyboard: [scene],
      aspectRatio: '16:9',
      resolution: '720p',
      candidateDurationSeconds: 4,
      generateAudio: true,
      numberOfCandidates: 5,
      model: 'veo',
      inputConfig: {products: [], composition: ''},
      audioTracks: [],
      visualOverlays: [],
    });

    uploadText = new Promise(resolve => {
      resolveUploadText = resolve;
    });
    const config = {
      projectConfig: {value: project, isLoading: signal(false)},
      projectLoadError: signal(false),
      reloadProjectConfig: vi.fn(),
      globalConfig: {
        value: () => ({
          gcpProject: 'test-project',
          gcpLocation: 'global',
          gcsBucket: 'test-bucket',
          tasksQueuePrefix: 'test-queue',
          veoLocation: 'global',
          modelCatalog: {
            defaults: {omni: 'omni'},
            models: {omni: {actions: ['edit_video'], locations: ['global']}},
          },
        }),
      },
      updateProjectConfig: (partial: Partial<ProjectConfig>) =>
        project.update(value => ({...value, ...partial})),
      flushPendingSave: vi.fn(),
      videoEditModels: () => ['omni'],
      resolveVideoLocation: () => 'global',
      audioLocked: () => false,
      isGeneratedScene: (value: unknown): value is GeneratedScene =>
        !!value && (value as {type?: string}).type === 'generated',
      isProvidedVideoScene: () => false,
      canEditCandidates: () => true,
      durationSlider: () => ({min: 1, max: 8, step: 1}),
      videoModels: () => ['veo'],
      selectVideoModel: vi.fn(),
      sceneIdCounter: () => 2,
      primaryColor: () => 0,
    };
    const media = {
      upload: vi.fn((content: string | File, path: string) =>
        path === 'thumbnail'
          ? Promise.resolve({
              path: 'thumbnails/edit.jpg',
              url: 'https://example.test/thumbnails/edit.jpg',
            })
          : uploadText,
      ),
      getCachedUrl: vi.fn((path: string) => `https://example.test/${path}`),
      resolve: vi.fn((file: {url: string}) => Promise.resolve(file.url)),
      signUrl: vi.fn().mockResolvedValue('https://example.test/signed.mp4'),
      signUrls: vi.fn().mockResolvedValue(new Map()),
    };

    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: ConfigService, useValue: config},
        {
          provide: ClientMediaService,
          useValue: {
            generateLowQualityThumbnail: vi
              .fn()
              .mockResolvedValue(new Blob(['low'], {type: 'image/jpeg'})),
            generateHighQualityThumbnail: vi
              .fn()
              .mockResolvedValue(new Blob(['high'], {type: 'image/jpeg'})),
            toBase64: vi.fn().mockResolvedValue('thumbnail'),
            toFile: vi.fn(
              (blob: Blob) =>
                new File([blob], 'thumbnail.jpg', {type: 'image/jpeg'}),
            ),
          },
        },
        {provide: MediaService, useValue: media},
        {provide: MatSnackBar, useValue: {open: vi.fn()}},
        RemixEngineService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Storyboard);
    fixture.detectChanges();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture.destroy();
    vi.useRealTimers();
  });

  async function editWithHeldStart(sliderCount: number) {
    vi.useFakeTimers();
    project.update(value => ({...value, numberOfCandidates: sliderCount}));
    fixture.detectChanges();

    const service = TestBed.inject(RemixEngineService);
    const scene = project().storyboard[0] as GeneratedScene;
    const edit = service.editCandidate(scene, 0, 'make the sky purple');

    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('.video-item.placeholder'),
    ).toHaveLength(1);

    resolveUploadText({path: 'remix-input/edit-prompt.txt'});
    let startRequest;
    await vi.waitFor(() => {
      const requests = http.match('/api/supplyNode');
      expect(requests).toHaveLength(1);
      startRequest = requests[0];
    });

    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('.video-item.placeholder'),
    ).toHaveLength(1);

    startRequest!.flush({executionId: 'execution-1'});
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(project().storyboard[0]).toMatchObject({
      pendingGeneration: {requestedCount: 1},
    });
    expect(
      fixture.nativeElement.querySelectorAll('.video-item.placeholder'),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    const statusRequests = http.match(req =>
      req.url.startsWith('/api/getStatus'),
    );
    expect(statusRequests).toHaveLength(1);
    const statusRequest = statusRequests[0];
    statusRequest!.flush({
      sink: {output: {'0': {video: [{file: 'videos/edited.mp4'}]}}},
    });
    await edit;
    expect(project().storyboard[0]).not.toHaveProperty('pendingGeneration');
    expect((project().storyboard[0] as GeneratedScene).candidates).toHaveLength(
      2,
    );
    expect(service.generatingSceneIds().has(scene.id)).toBe(false);
    expect(service.editingSceneIds().has(scene.id)).toBe(false);
  }

  it.each([2, 5])(
    'shows exactly one placeholder for an Omni edit with slider count %i',
    async sliderCount => {
      await editWithHeldStart(sliderCount);
    },
  );

  it('clears the transient edit state when workflow start fails', async () => {
    const service = TestBed.inject(RemixEngineService);
    const scene = project().storyboard[0] as GeneratedScene;
    const edit = service.editCandidate(scene, 0, 'make the sky purple');
    fixture.detectChanges();
    expect(service.editingSceneIds().has(scene.id)).toBe(true);

    resolveUploadText({path: 'remix-input/edit-prompt.txt'});
    let startRequest;
    await vi.waitFor(() => {
      const requests = http.match('/api/supplyNode');
      expect(requests).toHaveLength(1);
      startRequest = requests[0];
    });
    startRequest!.flush(
      {error: 'startup failed'},
      {status: 500, statusText: 'Server Error'},
    );
    await edit;

    expect(service.generatingSceneIds().has(scene.id)).toBe(false);
    expect(service.editingSceneIds().has(scene.id)).toBe(false);
  });

  it('keeps real ordinary generation at the slider count without edit state', async () => {
    const service = TestBed.inject(RemixEngineService);
    const scene = project().storyboard[0] as GeneratedScene;
    const generation = service.generateCandidates(scene, {
      durationSeconds: 4,
      model: 'veo',
      generateAudio: true,
      resolution: '720p',
    });
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelectorAll('.video-item.placeholder'),
    ).toHaveLength(5);
    expect(service.generatingSceneIds().has(scene.id)).toBe(true);
    expect(service.editingSceneIds().has(scene.id)).toBe(false);

    resolveUploadText({path: 'remix-input/generation-prompt.txt'});
    let startRequest;
    await vi.waitFor(() => {
      const requests = http.match('/api/supplyNode');
      expect(requests).toHaveLength(1);
      startRequest = requests[0];
    });
    startRequest!.flush(
      {error: 'startup failed'},
      {status: 500, statusText: 'Server Error'},
    );
    await generation;

    expect(service.generatingSceneIds().has(scene.id)).toBe(false);
    expect(service.editingSceneIds().has(scene.id)).toBe(false);
  });

  it('keeps the normal rendering fallback at the configured candidate count', () => {
    const service = TestBed.inject(RemixEngineService);
    const scene = project().storyboard[0] as GeneratedScene;
    service.generatingSceneIds.set(new Set([scene.id]));
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelectorAll('.video-item.placeholder'),
    ).toHaveLength(5);
    expect(fixture.componentInstance.getPlaceholdersArray()).toHaveLength(5);
  });
});
