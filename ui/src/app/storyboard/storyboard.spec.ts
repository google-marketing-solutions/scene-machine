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

import {CdkDragDrop} from '@angular/cdk/drag-drop';
import {HttpClient} from '@angular/common/http';
import {HarnessLoader} from '@angular/cdk/testing';
import {TestbedHarnessEnvironment} from '@angular/cdk/testing/testbed';
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatMenuHarness} from '@angular/material/menu/testing';
import {MatSelectHarness} from '@angular/material/select/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {MatSlideToggle} from '@angular/material/slide-toggle';
import {MatSlider} from '@angular/material/slider';
import {NavigationStart, Router} from '@angular/router';
import {By} from '@angular/platform-browser';
import {of, Subject} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
  resolveSceneRenderClip,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {ClientMediaService} from '../services/client-media/client-media';
import {ImagePreviewService} from '../services/image-preview/image-preview';
import {MediaService} from '../services/media/media';
import {CandidateVideoCacheService} from '../services/media/candidate-video-cache';
import {ThumbnailCacheService} from '../services/media/thumbnail-cache';
import {EditCandidateDialog} from './edit-candidate-dialog';
import {Storyboard} from './storyboard';

describe('Storyboard', () => {
  let component: Storyboard;
  let fixture: ComponentFixture<Storyboard>;
  let loader: HarnessLoader;
  let navigationEvents: Subject<unknown>;
  const sceneIdCounterSignal = signal(0);
  const projectConfigSignal = signal<ProjectConfig>({
    id: 'test-id',
    name: 'Test Project',
    storyboard: [],
    aspectRatio: '16:9',
    candidateDurationSeconds: 4,
    generateAudio: false,
    numberOfCandidates: 1,
    model: 'veo-1',
    resolution: '1080p',
    inputConfig: {products: [], composition: ''},
    audioTracks: [],
    visualOverlays: [],
  });

  const canEditCandidatesSignal = signal(false);
  const durationSliderSignal = signal({min: 4, max: 8, step: 2});
  let mockConfigService = {
    projectConfig: {
      value: projectConfigSignal,
      isLoading: () => false,
      error: () => null,
    },
    globalConfig: {
      value: () => ({
        duration: 5,
        veoModel: 'veo-model',
        numberOfCandidates: 1,
        generateAudio: false,
      }),
    },
    updateProjectConfig: (partial: Partial<ProjectConfig>) => {
      projectConfigSignal.update(config => ({...config, ...partial}));
    },
    saveNow: vi.fn(),
    videoModels: () => [],
    canEditCandidates: canEditCandidatesSignal,
    audioLocked: () => false,
    durationSlider: durationSliderSignal,
    selectVideoModel: vi.fn(),
    sceneIdCounter: sceneIdCounterSignal,
    primaryColor: signal('theme-green'),
    isGeneratedScene: (
      scene: GeneratedScene | ProvidedVideoScene,
    ): scene is GeneratedScene => scene?.type === 'generated',
    isProvidedVideoScene: (
      scene: GeneratedScene | ProvidedVideoScene,
    ): scene is ProvidedVideoScene => scene?.type === 'video',
  };
  let mockRemixEngineService = {
    uploadMedia: vi.fn(),
    editCandidate: vi.fn(),
    generatingSceneIds: signal(new Set()),
    editingSceneIds: signal(new Set()),
  };
  let mockImagePreviewService = {
    create: vi.fn(),
  };
  let mockMatDialog = {
    open: vi.fn().mockReturnValue({
      afterClosed: () => of({type: 'generate'}),
    }),
  };
  const mockMediaService = {
    resolve: vi.fn().mockResolvedValue(''),
    getCachedUrl: vi.fn().mockReturnValue(undefined),
  };
  const mockHttpClient = {get: vi.fn()};
  const mockThumbnailCache = {
    acquire: vi.fn(),
    invalidateCandidate: vi.fn(),
    invalidateProject: vi.fn(),
  };

  beforeEach(async () => {
    navigationEvents = new Subject<unknown>();
    sceneIdCounterSignal.set(0);
    canEditCandidatesSignal.set(false);
    durationSliderSignal.set({min: 4, max: 8, step: 2});
    mockConfigService = {
      projectConfig: {
        value: projectConfigSignal,
        isLoading: () => false,
        error: () => null,
      },
      globalConfig: {
        value: () => ({
          duration: 5,
          veoModel: 'veo-model',
          numberOfCandidates: 1,
          generateAudio: false,
        }),
      },
      updateProjectConfig: (partial: Partial<ProjectConfig>) => {
        projectConfigSignal.update(config => ({...config, ...partial}));
      },
      saveNow: vi.fn(),
      videoModels: () => [],
      canEditCandidates: canEditCandidatesSignal,
      audioLocked: () => false,
      durationSlider: durationSliderSignal,
      selectVideoModel: vi.fn(),
      sceneIdCounter: sceneIdCounterSignal,
      primaryColor: signal('theme-green'),
      isGeneratedScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is GeneratedScene => scene?.type === 'generated',
      isProvidedVideoScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is ProvidedVideoScene => scene?.type === 'video',
    };

    mockRemixEngineService = {
      uploadMedia: vi.fn(),
      editCandidate: vi.fn(),
      generatingSceneIds: signal(new Set()),
      editingSceneIds: signal(new Set()),
    };
    mockImagePreviewService = {
      create: vi.fn().mockResolvedValue(undefined),
    };

    mockMatDialog = {
      open: vi.fn().mockReturnValue({
        afterClosed: () => of({type: 'generate'}),
      }),
    };
    mockMediaService.resolve.mockReset();
    mockMediaService.resolve.mockResolvedValue('');
    mockMediaService.getCachedUrl.mockReset();
    mockMediaService.getCachedUrl.mockReturnValue(undefined);
    mockHttpClient.get.mockReset();
    mockThumbnailCache.invalidateCandidate.mockReset();
    mockThumbnailCache.invalidateProject.mockReset();
    mockThumbnailCache.acquire.mockReset();
    mockThumbnailCache.acquire.mockImplementation(
      (_scope: unknown, file: {path?: string}) =>
        Promise.resolve({
          url: `blob:${file.path ?? 'empty'}`,
          release: vi.fn(),
        }),
    );

    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        {provide: ConfigService, useValue: mockConfigService},
        {provide: RemixEngineService, useValue: mockRemixEngineService},
        {provide: ImagePreviewService, useValue: mockImagePreviewService},
        {provide: MediaService, useValue: mockMediaService},
        {provide: HttpClient, useValue: mockHttpClient},
        {provide: Router, useValue: {events: navigationEvents}},
        {provide: ThumbnailCacheService, useValue: mockThumbnailCache},
      ],
    })
      .overrideComponent(Storyboard, {
        add: {
          providers: [{provide: MatDialog, useValue: mockMatDialog}],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(Storyboard);
    component = fixture.componentInstance;
    loader = TestbedHarnessEnvironment.loader(fixture);
    projectConfigSignal.set({
      id: 'test-id',
      name: 'Test Project',
      storyboard: [],
      aspectRatio: '16:9',
      resolution: '1080p',
      candidateDurationSeconds: 4,
      generateAudio: false,
      numberOfCandidates: 1,
      model: 'veo-1',
      inputConfig: {products: [], composition: ''},
      audioTracks: [],
      visualOverlays: [],
    });
    fixture.detectChanges();
  });

  function selectTrimScene(scene: GeneratedScene | ProvidedVideoScene) {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [scene],
    }));
    component.selectScene(scene.id);
    component.videoDuration.set(10);
  }

  function currentProvidedTrim() {
    return (projectConfigSignal().storyboard[0] as ProvidedVideoScene).trim;
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('exposes native vertical prompt resizing without stretch styles', () => {
    mockConfigService.globalConfig.value = () => ({
      duration: 5,
      veoModel: 'veo-model',
      numberOfCandidates: 1,
      generateAudio: false,
      dictation: {enabled: true},
    });
    const scene: GeneratedScene = {
      id: 'resize-scene',
      type: 'generated',
      name: 'Resize scene',
      prompt: 'scene prompt',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector(
      '.prompt-box textarea',
    ) as HTMLTextAreaElement;
    const controlsArea = fixture.nativeElement.querySelector(
      '.controls-area',
    ) as HTMLElement;
    const previewWrapper = fixture.nativeElement.querySelector(
      '.preview-wrapper',
    ) as HTMLElement;
    const trimControls = fixture.nativeElement.querySelector(
      '.trim-controls',
    ) as HTMLElement;

    expect(getComputedStyle(textarea).resize).toBe('vertical');
    expect(getComputedStyle(textarea).overflow).toBe('auto');
    expect(getComputedStyle(textarea).minHeight).toBe('136px');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Start dictation"]'),
    ).not.toBeNull();
    expect(getComputedStyle(controlsArea).maxHeight).toBe('none');
    expect(getComputedStyle(controlsArea).flexGrow).toBe('0');
    expect(getComputedStyle(controlsArea).flexShrink).toBe('0');
    expect(getComputedStyle(controlsArea).alignItems).toBe('flex-start');
    expect(getComputedStyle(trimControls).justifyContent).toBe('flex-start');
    expect(getComputedStyle(previewWrapper).flexGrow).toBe('0');
    expect(getComputedStyle(previewWrapper).flexShrink).toBe('0');
    expect(getComputedStyle(previewWrapper).minHeight).toBe('260px');
  });

  it('keeps the prompt resizable when dictation is disabled', () => {
    const scene: GeneratedScene = {
      id: 'resize-without-dictation-scene',
      type: 'generated',
      name: 'Resize without dictation',
      prompt: 'scene prompt',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector(
      '.prompt-box textarea',
    ) as HTMLTextAreaElement;

    expect(getComputedStyle(textarea).resize).toBe('vertical');
    expect(getComputedStyle(textarea).minHeight).toBe('136px');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Start dictation"]'),
    ).toBeNull();
  });

  it('updates the real filmstrip image when the selected candidate changes', async () => {
    const candidate = (path: string): Candidate => ({
      runNumber: path === 'candidate-a.jpg' ? 1 : 2,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'candidate',
      generateAudio: true,
      resolution: '1080p',
      video: {path: `${path}.mp4`, url: `${path}.mp4`},
      highQualityThumbnail: {path, url: path},
    });
    const scene: GeneratedScene = {
      id: 'filmstrip-scene',
      type: 'generated',
      name: 'Filmstrip scene',
      prompt: 'scene',
      candidates: [candidate('candidate-a.jpg'), candidate('candidate-b.jpg')],
      selectedCandidateIndex: 0,
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    fixture.detectChanges();
    await Promise.resolve();

    const filmstrip = fixture.nativeElement.querySelector('.filmstrip-item');
    const image = filmstrip.querySelector('.high-res-img') as HTMLImageElement;
    expect(image.src).toContain('blob:candidate-a.jpg');

    component.selectCandidate(scene, 1);
    fixture.detectChanges();
    await Promise.resolve();
    expect(image.src).toContain('blob:candidate-b.jpg');
  });

  it('uses a persisted reference preview for filmstrip fallback', () => {
    const referenceImage = {
      path: 'source.png',
      url: 'source-url',
      preview: {path: 'preview.jpg', url: 'preview-url'},
    };

    expect(component.getThumbnailData({referenceImage}).reference).toEqual(
      referenceImage.preview,
    );
  });

  it('binds a persisted reference preview in the editor', async () => {
    const scene: GeneratedScene = {
      id: 'reference-preview-scene',
      type: 'generated',
      name: 'Reference preview scene',
      prompt: 'scene',
      candidates: [],
      referenceImage: {
        path: 'source.png',
        url: 'source-url',
        preview: {path: 'preview.jpg', url: 'preview-url'},
      },
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    fixture.detectChanges();
    await Promise.resolve();

    const reference = fixture.nativeElement.querySelector(
      '.reference-image-preview img',
    ) as HTMLImageElement;
    expect(reference).not.toBeNull();
    expect(reference.src).toContain('blob:preview.jpg');
  });

  it('stores the persisted preview when a reference image is uploaded', async () => {
    const scene: GeneratedScene = {
      id: 'upload-reference-scene',
      type: 'generated',
      name: 'Upload reference scene',
      prompt: 'scene',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    mockRemixEngineService.uploadMedia.mockResolvedValue({
      path: 'source.png',
      url: 'source-url',
    });
    mockImagePreviewService.create.mockResolvedValue({
      preview: {path: 'preview.jpg', url: 'preview-url'},
      widthPixels: 1200,
      heightPixels: 800,
    });
    const clientMedia = TestBed.inject(ClientMediaService);
    const lowQuality = vi
      .spyOn(clientMedia, 'generateLowQualityThumbnail')
      .mockResolvedValue(new Blob(['low'], {type: 'image/jpeg'}));
    const toBase64 = vi
      .spyOn(clientMedia, 'toBase64')
      .mockResolvedValue('data:image/jpeg;base64,low');

    try {
      await component.uploadImage(
        new File(['image'], 'reference.png', {type: 'image/png'}),
      );
    } finally {
      lowQuality.mockRestore();
      toBase64.mockRestore();
    }

    const uploadedScene = projectConfigSignal().storyboard[0] as GeneratedScene;
    expect(uploadedScene.referenceImage).toEqual({
      path: 'source.png',
      url: 'source-url',
      preview: {path: 'preview.jpg', url: 'preview-url'},
    });
    expect(uploadedScene.highQualityThumbnail).toEqual({
      path: 'preview.jpg',
      url: 'preview-url',
    });
  });

  it('does not attach a delayed preview to a newer reference upload', async () => {
    const scene: GeneratedScene = {
      id: 'delayed-reference-scene',
      type: 'generated',
      name: 'Delayed reference scene',
      prompt: 'scene',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    mockRemixEngineService.uploadMedia.mockImplementation((file: File) =>
      Promise.resolve({
        path: `source-${file.name}`,
        url: `source-${file.name}`,
      }),
    );
    let resolveFirstPreview!: (value: {
      preview: {path: string; url: string};
      widthPixels: number;
      heightPixels: number;
    }) => void;
    mockImagePreviewService.create.mockImplementation((file: File) =>
      file.name === 'first.jpeg'
        ? new Promise(resolve => {
            resolveFirstPreview = resolve;
          })
        : Promise.resolve({
            preview: {path: 'preview-second.jpg', url: 'preview-second-url'},
            widthPixels: 100,
            heightPixels: 100,
          }),
    );
    const clientMedia = TestBed.inject(ClientMediaService);
    const lowQuality = vi
      .spyOn(clientMedia, 'generateLowQualityThumbnail')
      .mockResolvedValue(new Blob(['low'], {type: 'image/jpeg'}));
    const toBase64 = vi
      .spyOn(clientMedia, 'toBase64')
      .mockResolvedValue('data:image/jpeg;base64,low');

    try {
      const firstUpload = component.uploadImage(
        new File(['first'], 'first.jpeg', {type: 'image/jpeg'}),
      );
      await vi.waitFor(() => {
        expect(scene.referenceImage?.path).toBe('source-first.jpeg');
      });
      await component.uploadImage(
        new File(['second'], 'second.jpeg', {type: 'image/jpeg'}),
      );
      resolveFirstPreview({
        preview: {path: 'preview-first.jpg', url: 'preview-first-url'},
        widthPixels: 100,
        heightPixels: 100,
      });
      await firstUpload;
    } finally {
      lowQuality.mockRestore();
      toBase64.mockRestore();
    }

    expect(scene.referenceImage).toEqual({
      path: 'source-second.jpeg',
      url: 'source-second.jpeg',
      preview: {path: 'preview-second.jpg', url: 'preview-second-url'},
    });
  });

  it('does not attach a delayed preview after reference removal', async () => {
    const scene: GeneratedScene = {
      id: 'removed-reference-scene',
      type: 'generated',
      name: 'Removed reference scene',
      prompt: 'scene',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    mockRemixEngineService.uploadMedia.mockResolvedValue({
      path: 'source-removed.jpeg',
      url: 'source-removed.jpeg',
    });
    let resolvePreview!: (value: {
      preview: {path: string; url: string};
      widthPixels: number;
      heightPixels: number;
    }) => void;
    mockImagePreviewService.create.mockReturnValue(
      new Promise(resolve => {
        resolvePreview = resolve;
      }),
    );
    const clientMedia = TestBed.inject(ClientMediaService);
    const lowQuality = vi
      .spyOn(clientMedia, 'generateLowQualityThumbnail')
      .mockResolvedValue(new Blob(['low'], {type: 'image/jpeg'}));
    const toBase64 = vi
      .spyOn(clientMedia, 'toBase64')
      .mockResolvedValue('data:image/jpeg;base64,low');

    try {
      const upload = component.uploadImage(
        new File(['removed'], 'removed.jpeg', {type: 'image/jpeg'}),
      );
      await vi.waitFor(() => {
        expect(scene.referenceImage?.path).toBe('source-removed.jpeg');
      });
      component.removeReferenceImage();
      resolvePreview({
        preview: {path: 'preview-removed.jpg', url: 'preview-removed-url'},
        widthPixels: 100,
        heightPixels: 100,
      });
      await upload;
    } finally {
      lowQuality.mockRestore();
      toBase64.mockRestore();
    }

    expect(
      (projectConfigSignal().storyboard[0] as GeneratedScene).referenceImage,
    ).toBeUndefined();
  });

  it('does not apply a delayed reference upload to a different project', async () => {
    const scene: GeneratedScene = {
      id: 'reused-scene-id',
      type: 'generated',
      name: 'Original project scene',
      prompt: 'scene',
      candidates: [],
    };
    projectConfigSignal.update(config => ({
      ...config,
      id: 'original-project',
      storyboard: [scene],
    }));
    component.selectScene(scene.id);
    mockRemixEngineService.uploadMedia.mockResolvedValue({
      path: 'source-original.jpeg',
      url: 'source-original.jpeg',
    });
    let resolvePreview!: (value: {
      preview: {path: string; url: string};
      widthPixels: number;
      heightPixels: number;
    }) => void;
    mockImagePreviewService.create.mockReturnValue(
      new Promise(resolve => {
        resolvePreview = resolve;
      }),
    );
    const clientMedia = TestBed.inject(ClientMediaService);
    const lowQuality = vi
      .spyOn(clientMedia, 'generateLowQualityThumbnail')
      .mockResolvedValue(new Blob(['low'], {type: 'image/jpeg'}));
    const toBase64 = vi
      .spyOn(clientMedia, 'toBase64')
      .mockResolvedValue('data:image/jpeg;base64,low');

    try {
      const upload = component.uploadImage(
        new File(['original'], 'original.jpeg', {type: 'image/jpeg'}),
      );
      await vi.waitFor(() => {
        expect(scene.referenceImage?.path).toBe('source-original.jpeg');
      });
      projectConfigSignal.set({
        ...projectConfigSignal(),
        id: 'different-project',
        storyboard: [
          {
            ...scene,
            referenceImage: undefined,
            name: 'Different project scene',
          },
        ],
      });
      resolvePreview({
        preview: {path: 'preview-original.jpg', url: 'preview-original-url'},
        widthPixels: 100,
        heightPixels: 100,
      });
      await upload;
    } finally {
      lowQuality.mockRestore();
      toBase64.mockRestore();
    }

    expect(
      (projectConfigSignal().storyboard[0] as GeneratedScene).referenceImage,
    ).toBeUndefined();
  });

  it('loads the first filmstrip thumbnail when generation adds the first candidate', async () => {
    const scene: GeneratedScene = {
      id: 'first-candidate-scene',
      type: 'generated',
      name: 'First candidate scene',
      prompt: 'scene',
      candidates: [],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.filmstrip-item img'),
    ).toBeNull();

    scene.candidates = [
      {
        runNumber: 1,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'candidate',
        generateAudio: true,
        resolution: '1080p',
        highQualityThumbnail: {path: 'generated.jpg', url: 'generated-url'},
      },
    ];
    scene.selectedCandidateIndex = 0;
    projectConfigSignal.set({...projectConfigSignal(), storyboard: [scene]});
    fixture.detectChanges();
    await Promise.resolve();
    const image = fixture.nativeElement.querySelector(
      '.filmstrip-item .high-res-img',
    ) as HTMLImageElement;
    expect(image.src).toContain('blob:generated.jpg');
  });

  it('invalidates a candidate cache entry when archiving', () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'candidate',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'candidate-path', url: 'candidate-url'},
      highQualityThumbnail: {
        path: 'candidate-thumb-path',
        url: 'candidate-thumb-url',
      },
      referenceImage: {
        path: 'candidate-reference-path',
        url: 'candidate-reference-url',
      },
    };
    const scene: GeneratedScene = {
      id: 'archive-scene',
      type: 'generated',
      name: 'Archive scene',
      prompt: 'scene',
      candidates: [candidate],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    fixture.detectChanges();
    const cache = TestBed.inject(CandidateVideoCacheService);
    const invalidate = vi.spyOn(cache, 'invalidateCandidate');

    component.toggleArchive(new Event('click'), scene, 0);

    expect(invalidate).toHaveBeenCalledWith('test-id', 'candidate-path');
    expect(mockThumbnailCache.invalidateCandidate).toHaveBeenCalledWith(
      'test-id',
      'candidate-thumb-path',
    );
    expect(mockThumbnailCache.invalidateCandidate).toHaveBeenCalledWith(
      'test-id',
      'candidate-reference-path',
    );
    invalidate.mockRestore();
  });

  it('moves a candidate and focuses the destination without reselecting it', () => {
    const candidate: Candidate = {
      runNumber: 2,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'candidate prompt',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'candidate-path', url: 'candidate-url'},
    };
    const source: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'source prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };
    projectConfigSignal.update(config => ({...config, storyboard: [source]}));
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 0);
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: '2',
    });
    expect(projectConfigSignal().storyboard[1].id).toBe('2');
    expect(component.selectedSceneId()).toBe('2');
    expect(mockConfigService.saveNow).toHaveBeenCalledTimes(1);
  });

  it('moves the requested full-array candidate and preserves archived indexes', () => {
    const candidates: Candidate[] = [
      {
        runNumber: 1,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'a',
        generateAudio: true,
        resolution: '1080p',
        video: {path: 'a', url: 'a'},
      },
      {
        runNumber: 2,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'archived',
        generateAudio: true,
        resolution: '1080p',
        isArchived: true,
        video: {path: 'archived', url: 'archived'},
      },
      {
        runNumber: 2,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'target',
        generateAudio: true,
        resolution: '1080p',
        video: {path: 'target', url: 'target'},
      },
    ];
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates,
    };
    const destination: GeneratedScene = {
      id: 'destination',
      type: 'generated',
      name: 'Destination',
      prompt: 'destination',
      candidates: [],
    };
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [source, destination],
    }));
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 2);
    component.movePreparedCandidate(new Event('click'), {
      kind: 'existing',
      sceneId: 'destination',
    });
    const moved = (projectConfigSignal().storyboard[1] as GeneratedScene)
      .candidates![0];
    expect(moved.video?.path).toBe('target');
    expect(
      (projectConfigSignal().storyboard[0] as GeneratedScene).candidates,
    ).toHaveLength(2);
  });

  it('clears a valid prepare when a later invalid prepare is attempted', () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'target', url: 'target'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [candidate],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [source]}));
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 0);
    component.prepareMoveCandidate(source, 99);
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: 'new',
    });
    expect(projectConfigSignal().storyboard).toHaveLength(1);
    expect(projectConfigSignal().storyboard[0].id).toBe('source');
    expect(mockConfigService.saveNow).not.toHaveBeenCalled();
  });

  it('consumes a valid prepared move so a repeated action cannot move twice', () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'target', url: 'target'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [candidate],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [source]}));
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 0);
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: 'new',
    });
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: 'newer',
    });
    expect(projectConfigSignal().storyboard).toHaveLength(2);
    expect(projectConfigSignal().storyboard[1].id).toBe('new');
    expect(mockConfigService.saveNow).toHaveBeenCalledTimes(1);
  });

  it('rejects a prepared move after navigating away and back to project A', () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'target', url: 'target'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [candidate],
    };
    projectConfigSignal.update(config => ({
      ...config,
      id: 'project-a',
      storyboard: [source],
    }));
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 0);
    navigationEvents.next(new NavigationStart(1, '/projects/project-b'));
    projectConfigSignal.update(config => ({...config, id: 'project-b'}));
    fixture.detectChanges();
    navigationEvents.next(new NavigationStart(2, '/projects/project-a'));
    projectConfigSignal.update(config => ({...config, id: 'project-a'}));
    fixture.detectChanges();
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: 'newer',
    });
    expect(projectConfigSignal().storyboard).toHaveLength(1);
    expect(projectConfigSignal().id).toBe('project-a');
    expect(mockConfigService.saveNow).not.toHaveBeenCalled();
  });

  it('moves the active candidate from the real menu using its full candidate index', async () => {
    const archived: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'archived',
      generateAudio: true,
      resolution: '1080p',
      isArchived: true,
      video: {path: 'archived', url: 'archived'},
    };
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'target', url: 'target'},
    };
    const kept: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'kept',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'kept', url: 'kept'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [archived, kept, candidate],
      selectedCandidateIndex: 2,
    };
    const destination: GeneratedScene = {
      id: 'destination',
      type: 'generated',
      name: 'Destination',
      prompt: 'destination',
      candidates: [],
    };
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [source, destination],
    }));
    component.selectScene('source');
    fixture.detectChanges();
    const moveButtons = fixture.nativeElement.querySelectorAll('.move-btn');
    const moveButton = moveButtons[1] as HTMLButtonElement;
    moveButton.click();
    fixture.detectChanges();
    const menus = await loader.getAllHarnesses(MatMenuHarness);
    let menu = menus[0];
    for (const candidateMenu of menus) {
      if (await candidateMenu.isOpen()) {
        menu = candidateMenu;
        break;
      }
    }
    await menu.clickItem({text: 'Move to Destination'});
    fixture.detectChanges();

    const movedSource = projectConfigSignal().storyboard[0] as GeneratedScene;
    const movedDestination = projectConfigSignal()
      .storyboard[1] as GeneratedScene;
    expect(movedSource.candidates).toHaveLength(2);
    expect(movedSource.candidates?.[0].video?.path).toBe('archived');
    expect(movedSource.candidates?.[1].video?.path).toBe('kept');
    expect(movedDestination.candidates).toHaveLength(1);
    expect(movedDestination.candidates?.[0].video?.path).toBe('target');
  });

  it('shows a busy destination as disabled with an explanatory tooltip', async () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      origin: {
        sceneId: 'source',
        sceneName: 'Source',
        runNumber: 2,
        candidateLabel: '2C',
      },
      video: {path: 'target', url: 'target'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [candidate],
    };
    const destination: GeneratedScene = {
      id: 'destination',
      type: 'generated',
      name: 'Destination',
      prompt: 'destination',
      candidates: [],
    };
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [source, destination],
    }));
    component.selectScene('source');
    fixture.detectChanges();
    expect(component.runTooltip(candidate)).toContain('originally 2C');
    mockRemixEngineService.generatingSceneIds.set(new Set(['destination']));
    fixture.detectChanges();

    const moveButton = fixture.nativeElement.querySelector(
      '.move-btn',
    ) as HTMLButtonElement;
    moveButton.click();
    fixture.detectChanges();
    const menu = await loader.getHarness(MatMenuHarness);
    const destinationItem = (
      await menu.getItems({text: 'Move to Destination'})
    )[0];
    expect(destinationItem).toBeDefined();
    expect(await destinationItem.isDisabled()).toBe(true);
    const describedBy = await (
      await destinationItem.host()
    ).getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const helpText = describedBy
      ?.split(' ')
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter((text): text is string => !!text);
    expect(helpText).toContain('Cannot move while this scene is generating');
  });

  it.each([
    ['busy destination', 'busy'],
    ['stale source', 'invalid-source'],
    ['invalid destination', 'invalid-destination'],
  ])('reports a %s move failure without mutating state', (label, reason) => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'target',
      generateAudio: true,
      resolution: '1080p',
      video: {path: 'target', url: 'target'},
    };
    const source: GeneratedScene = {
      id: 'source',
      type: 'generated',
      name: 'Source',
      prompt: 'source',
      candidates: [candidate],
    };
    const destination: GeneratedScene = {
      id: 'destination',
      type: 'generated',
      name: 'Destination',
      prompt: 'destination',
      candidates: [],
    };
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [source, destination],
    }));
    component.selectScene('source');
    fixture.detectChanges();
    component.prepareMoveCandidate(source, 0);
    if (reason === 'busy') {
      mockRemixEngineService.generatingSceneIds.set(new Set(['destination']));
    } else if (reason === 'invalid-source') {
      projectConfigSignal.update(config => ({
        ...config,
        storyboard: [
          {
            ...source,
            candidates: [
              {...candidate, video: {path: 'changed', url: 'changed'}},
            ],
          },
          destination,
        ],
      }));
    }
    fixture.detectChanges();
    const snackBar = fixture.debugElement.injector.get(MatSnackBar);
    const open = vi.spyOn(snackBar, 'open');
    const before = projectConfigSignal();
    const beforeScene = component.selectedSceneId();
    component.movePreparedCandidate(new Event('click'), {
      kind: 'existing',
      sceneId: reason === 'invalid-destination' ? 'missing' : 'destination',
    });

    expect(projectConfigSignal()).toBe(before);
    expect(mockConfigService.saveNow).not.toHaveBeenCalled();
    expect(component.selectedSceneId()).toBe(beforeScene);
    expect(open).toHaveBeenCalledWith(
      reason === 'busy'
        ? 'Cannot move this candidate while the source or destination is generating.'
        : 'Failed to move candidate. Please try again.',
      'Dismiss',
      {panelClass: ['error-snackbar']},
    );
    open.mockRestore();
  });

  it('drives the candidate-duration slider from durationSlider()', () => {
    durationSliderSignal.set({min: 3, max: 10, step: 1});
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();

    const sliders = fixture.debugElement.queryAll(
      By.css('.setting-group mat-slider'),
    );
    const durationSlider = sliders[1].componentInstance as MatSlider;

    expect(durationSlider.min).toBe(3);
    expect(durationSlider.max).toBe(10);
    expect(durationSlider.step).toBe(1);
  });

  it('keeps the audio toggle enabled so always-audio models can be muted in previews', async () => {
    mockConfigService.audioLocked = () => true;
    projectConfigSignal.update(config => ({
      ...config,
      generateAudio: false,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();
    // NgModel writes to its ControlValueAccessor (MatSlideToggle.checked) in
    // a microtask, so let that settle before reading it back.
    await fixture.whenStable();

    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle))
      .componentInstance as MatSlideToggle;

    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  it('leaves the audio toggle enabled and following generateAudio when the model does not always generate audio', async () => {
    mockConfigService.audioLocked = () => false;
    projectConfigSignal.update(config => ({
      ...config,
      generateAudio: true,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();
    await fixture.whenStable();

    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle))
      .componentInstance as MatSlideToggle;

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(
      fixture.nativeElement
        .querySelector('.audio-toggle .subtitle')
        ?.textContent.trim(),
    ).toBe('Generate Audio');
  });

  it('mutes an audio-off selected candidate and disables its preview volume controls', () => {
    const scene: GeneratedScene = {
      id: 'audio-scene',
      type: 'generated',
      name: 'Audio scene',
      prompt: 'test',
      selectedCandidateIndex: 0,
      candidates: [
        {
          runNumber: 1,
          durationSeconds: 4,
          model: 'veo-1',
          prompt: 'test',
          generateAudio: false,
          resolution: '1080p',
          video: {url: 'https://video/off.mp4', path: 'video/off.mp4'},
        },
      ],
    };
    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    fixture.detectChanges();

    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;
    const volumeButton = fixture.nativeElement.querySelector(
      '.volume-controls button',
    ) as HTMLButtonElement;
    expect(video.muted).toBe(true);
    expect(volumeButton.disabled).toBe(true);
    expect(volumeButton.textContent).toContain('volume_off');

    scene.candidates![0].generateAudio = true;
    projectConfigSignal.set({...projectConfigSignal()});
    fixture.detectChanges();
    expect(video.muted).toBe(false);
    expect(volumeButton.disabled).toBe(false);
  });

  it('calls selectVideoModel when a model is chosen for the selected scene', async () => {
    (mockConfigService as {videoModels: () => string[]}).videoModels = () => [
      'veo-default',
      'omni-1',
    ];
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();

    const select = await loader.getHarness(MatSelectHarness);
    await select.open();
    await select.clickOptions({text: 'omni-1'});

    expect(mockConfigService.selectVideoModel).toHaveBeenCalledWith('omni-1');
  });

  it('should automatically select a newly added scene', () => {
    expect(component.selectedSceneId()).toBeNull();

    // Mock sceneIdCounter to return next value
    sceneIdCounterSignal.set(1);
    component.addScene();
    fixture.detectChanges();
    expect(component.selectedSceneId()).toBe('1');

    sceneIdCounterSignal.set(2);
    component.addScene();
    fixture.detectChanges();
    expect(component.selectedSceneId()).toBe('2');
  });

  it('should reorder scenes on drop', () => {
    sceneIdCounterSignal.set(1);
    component.addScene(); // id: 1
    sceneIdCounterSignal.set(2);
    component.addScene(); // id: 2
    sceneIdCounterSignal.set(3);
    component.addScene(); // id: 3
    fixture.detectChanges();

    let scenes = component.config.projectConfig.value().storyboard;
    expect(
      scenes.map((s: GeneratedScene | ProvidedVideoScene) => s.id),
    ).toEqual(['1', '2', '3']);

    const dropEvent: Partial<CdkDragDrop<string[]>> = {
      previousIndex: 0,
      currentIndex: 2,
    };

    component.drop(dropEvent as unknown as CdkDragDrop<string[]>);
    fixture.detectChanges();

    scenes = component.config.projectConfig.value().storyboard;
    expect(
      scenes.map((s: GeneratedScene | ProvidedVideoScene) => s.id),
    ).toEqual(['2', '3', '1']);
  });

  it('should extract duration and set it on upload', async () => {
    const mockFile = new File([''], 'test.mp4', {type: 'video/mp4'});
    mockMatDialog.open.mockReturnValue({
      afterClosed: () => of({type: 'upload', file: mockFile}),
    });

    mockRemixEngineService.uploadMedia.mockResolvedValue({
      path: 'path/test.mp4',
      url: 'http://test.mp4',
    });

    // Mock getVideoDuration to avoid real video element issues in tests
    const durationSpy = vi
      .spyOn(component, 'getVideoDuration')
      .mockResolvedValue(10.5);

    sceneIdCounterSignal.set(1);
    component.addScene();

    await fixture.whenStable();
    fixture.detectChanges();

    const scenes = component.config.projectConfig.value().storyboard;
    expect(scenes.length).toBe(1);
    expect(scenes[0].type).toBe('video');
    expect((scenes[0] as ProvidedVideoScene).durationSeconds).toBe(10.5);
    expect((scenes[0] as ProvidedVideoScene).video?.url).toBe(
      'http://test.mp4',
    );
    expect(durationSpy).toHaveBeenCalledWith(mockFile);
  });

  it('should calculate trimmed duration correctly', () => {
    // Setup a generated scene with a candidate
    const candidate: Candidate = {
      video: {url: 'http://test.mp4', path: 'test/path'},
      runNumber: 1,
      durationSeconds: 10,
      trim: {start: 2, end: 8},
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
    };

    component.config.updateProjectConfig({
      storyboard: [
        {
          id: '1',
          type: 'generated',
          name: 'Scene 1',
          candidates: [candidate],
          selectedCandidateIndex: 0,
        },
      ],
    });

    // Select the scene
    component.selectScene('1');
    fixture.detectChanges();

    // Mock video duration
    component.videoDuration.set(10);

    expect(component.trimmedDuration()).toBe(6); // 8 - 2

    // Test with no trim (should be full duration)
    candidate.trim = undefined;
    component.updateScenes();
    fixture.detectChanges();

    expect(component.trimmedDuration()).toBe(10);

    // Test with dragging
    component.draggingTrim.set({start: 3, end: 7});
    expect(component.trimmedDuration()).toBe(4);
  });

  it('does not show a trimmed-duration chip for the full source span', () => {
    const candidate: Candidate = {
      video: {url: 'http://test.mp4', path: 'test/path'},
      runNumber: 1,
      durationSeconds: 4,
      trim: {start: 0, end: 4},
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
    };
    const archivedCandidate: Candidate = {
      ...candidate,
      video: {url: 'http://archived.mp4', path: 'archived/path'},
      isArchived: true,
    };
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [candidate, archivedCandidate],
      selectedCandidateIndex: 0,
    };

    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    component.videoDuration.set(4);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.trimmed-info')).toBeNull();
    expect(
      fixture.nativeElement.querySelectorAll('.archived-panel .video-item'),
    ).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelectorAll('.video-info mat-icon'),
    ).toHaveLength(0);
    expect(component.isTrimmedRange({end: 3}, 4)).toBe(true);
    expect(component.isTrimmedRange({start: 0, end: 4.01}, 4)).toBe(false);
    expect(component.isTrimmedRange({start: 0, end: 4}, 4.01)).toBe(true);
  });

  it('disables native looping while scrubbing a paused preview at the right edge', () => {
    const candidate: Candidate = {
      video: {url: 'http://test.mp4', path: 'test/path'},
      runNumber: 1,
      durationSeconds: 4,
      trim: {start: 0, end: 4},
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
    };
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };

    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    component.videoDuration.set(4);
    fixture.detectChanges();

    const video = fixture.nativeElement.querySelector(
      'video.preview-video',
    ) as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {configurable: true, value: true});
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      value: 3.999,
      writable: true,
    });
    component.isVideoPlaying.set(true);
    fixture.detectChanges();
    expect(video.loop).toBe(true);

    component.startDraggingTrim(new MouseEvent('mousedown'), 'end');
    component.onVideoTimeUpdate();

    expect(component.isVideoPlaying()).toBe(false);
    expect(video.loop).toBe(false);
    expect(component.currentPlaybackTime()).toBe(3.999);
    expect(candidate.trim).toEqual({start: 0, end: 4});

    component.stopDraggingTrim();
  });

  it('keeps native looping enabled when normal preview playback starts', () => {
    const candidate: Candidate = {
      video: {url: 'http://test.mp4', path: 'test/path'},
      runNumber: 1,
      durationSeconds: 4,
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
    };
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };

    projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
    component.selectScene(scene.id);
    fixture.detectChanges();

    const video = fixture.nativeElement.querySelector(
      'video.preview-video',
    ) as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {configurable: true, value: true});
    vi.spyOn(video, 'play').mockResolvedValue(undefined);

    component.toggleVideoPlay();

    expect(component.isVideoPlaying()).toBe(true);
    expect(video.loop).toBe(true);

    vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    Object.defineProperty(video, 'paused', {
      configurable: true,
      value: false,
    });
    component.toggleVideoPlay();

    expect(component.isVideoPlaying()).toBe(false);
    expect(video.loop).toBe(false);
  });

  it('keeps at least one 24fps frame when trim start crosses trim end', () => {
    const candidate: Candidate = {
      video: {url: 'http://test.mp4', path: 'test/path'},
      runNumber: 1,
      durationSeconds: 10,
      trim: {start: 2, end: 8},
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
    };
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };
    selectTrimScene(scene);

    component.updateTrim({start: 9});

    expect(candidate.trim).toEqual({start: 7.958, end: 8});
    const resolution = resolveSceneRenderClip(scene);
    expect(resolution.state).toBe('ready');
    if (resolution.state === 'ready') {
      expect(Math.round(resolution.clip.duration * 24)).toBe(1);
    }
  });

  it('keeps at least one 24fps frame when trim end crosses trim start', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({end: 1});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
    const trim = currentProvidedTrim()!;
    expect(Math.round((trim.end! - trim.start!) * 24)).toBe(1);
  });

  it('keeps trim endpoints strictly ordered after rounding', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({end: 2});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
  });

  it('repairs a two-endpoint trim that becomes equal after rounding', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 1, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({start: 2, end: 2.0009});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
  });

  describe('resolveSceneRenderClip source bounds', () => {
    function providedScene(
      durationSeconds: number | undefined,
      trim: {start?: number; end?: number},
    ): ProvidedVideoScene {
      return {
        id: 'b',
        type: 'video',
        name: 'Bounds',
        video: {url: 'http://test.mp4', path: 'videos/test.mp4'},
        durationSeconds,
        trim,
      } as ProvidedVideoScene;
    }

    it('rejects a trim starting at the source end', () => {
      // Long enough to pass the minimum-duration check, but there is no
      // source video left to read: ffmpeg yields an audio-only output.
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 5, end: 5.042})).state,
      ).toBe('invalid');
    });

    it('rejects a trim ending beyond the source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 4, end: 6})).state,
      ).toBe('invalid');
    });

    it('rejects an explicit trim with no source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(undefined, {start: 0, end: 2}))
          .state,
      ).toBe('invalid');
    });

    it('rejects a negative trim start', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: -1, end: 2})).state,
      ).toBe('invalid');
    });

    it('still accepts a trim that ends exactly at the source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 1, end: 5})).state,
      ).toBe('ready');
    });
  });

  it('preserves millisecond trim precision through the round trip', () => {
    // 1.001 * 1000 is 1000.9999999999999 in IEEE-754, so a naive
    // Math.floor(seconds * 1000)/1000 pre-rounding step truncates 1.001s to
    // 1.000s before the millisecond math ever runs.
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 0, end: 10},
    };
    selectTrimScene(scene);

    component.updateTrim({start: 1.001, end: 5.001});

    expect(currentProvidedTrim()).toEqual({start: 1.001, end: 5.001});
  });

  it('does not change trim before video metadata loads', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);
    component.videoDuration.set(0);
    const updateSpy = vi.spyOn(mockConfigService, 'updateProjectConfig');

    component.updateTrim({start: 3});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 8});
    expect(updateSpy).not.toHaveBeenCalled();
  });

  describe('run+letter candidate labels', () => {
    const makeCandidate = (
      runNumber: number,
      url: string,
      overrides: Partial<Candidate> = {},
    ): Candidate => ({
      video: {url, path: `path/${url}`},
      runNumber,
      durationSeconds: 4,
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
      ...overrides,
    });

    const selectSceneWithCandidates = (candidates: Candidate[]) => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
        candidates,
      };
      projectConfigSignal.set({
        id: 'test-id',
        name: 'Test Project',
        storyboard: [scene],
        aspectRatio: '16:9',
        candidateDurationSeconds: 4,
        generateAudio: false,
        numberOfCandidates: 1,
        model: 'veo-1',
        resolution: '1080p',
        inputConfig: {products: [], composition: ''},
        audioTracks: [],
        visualOverlays: [],
      });
      component.selectScene('1');
      fixture.detectChanges();
    };

    it('assigns run+letter labels per candidate (2 -> 2A,2B; 1 -> 1A,1B,1C)', () => {
      // Interleave runs to prove letters track each run independently and in
      // display (array) order.
      const c2a = makeCandidate(2, 'r2a.mp4');
      const c1a = makeCandidate(1, 'r1a.mp4');
      const c2b = makeCandidate(2, 'r2b.mp4');
      const c1b = makeCandidate(1, 'r1b.mp4');
      const c1c = makeCandidate(1, 'r1c.mp4');
      selectSceneWithCandidates([c2a, c1a, c2b, c1b, c1c]);

      const labels = component.runLabels();
      expect(labels.get(c2a)).toBe('2A');
      expect(labels.get(c2b)).toBe('2B');
      expect(labels.get(c1a)).toBe('1A');
      expect(labels.get(c1b)).toBe('1B');
      expect(labels.get(c1c)).toBe('1C');
    });

    it('renders the run+letter label inside each active candidate item', () => {
      selectSceneWithCandidates([
        makeCandidate(2, 'r2a.mp4'),
        makeCandidate(2, 'r2b.mp4'),
      ]);

      const labelEls = Array.from(
        fixture.nativeElement.querySelectorAll(
          '.candidate-list .video-item .video-info .video-chip:first-child',
        ),
      ) as HTMLElement[];
      const rendered = labelEls.map(el => el.textContent?.trim());
      expect(rendered).toEqual(['2A', '2B']);
    });

    it('keeps letters stable across the active list and the archived panel', () => {
      // 1A active, 1B archived: archiving must not renumber the survivor, and
      // the archived candidate keeps its own letter in the archived panel.
      const active = makeCandidate(1, 'r1a.mp4');
      const archived = makeCandidate(1, 'r1b.mp4', {isArchived: true});
      selectSceneWithCandidates([active, archived]);

      const labels = component.runLabels();
      expect(labels.get(active)).toBe('1A');
      expect(labels.get(archived)).toBe('1B');

      const activeLabel = fixture.nativeElement.querySelector(
        '.candidate-list .video-item:not(.archived) .video-info .video-chip:first-child',
      ) as HTMLElement;
      expect(activeLabel.textContent?.trim()).toBe('1A');
    });

    it('cycles run sliver colors through the picker, starting at the active theme', () => {
      // Mock theme is 'theme-green' (index 2 of [azure, magenta, green, orange,
      // violet]). Run 1 = the active theme; each later run steps to the next
      // swatch and wraps.
      expect(component.runSliceTheme(1)).toBe('theme-green');
      expect(component.runSliceTheme(2)).toBe('theme-orange');
      expect(component.runSliceTheme(3)).toBe('theme-violet');
      expect(component.runSliceTheme(4)).toBe('theme-azure');
      expect(component.runSliceTheme(6)).toBe('theme-green'); // wraps to run 1's color
    });

    it('builds the run chip tooltip from the run number and candidate letter', () => {
      const c2a = makeCandidate(2, 'r2a.mp4');
      const c2b = makeCandidate(2, 'r2b.mp4');
      selectSceneWithCandidates([c2a, c2b]);
      expect(component.runTooltip(c2a)).toBe('Run: 2, Candidate: A');
      expect(component.runTooltip(c2b)).toBe('Run: 2, Candidate: B');
    });

    it('keeps edit ancestry and uses lowercase originally wording', () => {
      const edited = makeCandidate(2, 'edited.mp4', {
        origin: {
          sceneId: '1',
          sceneName: 'Scene 1',
          runNumber: 2,
          candidateLabel: '2A',
          editedFromRun: 1,
        },
      });
      const original = makeCandidate(2, 'original.mp4', {
        origin: {
          sceneId: 'other',
          sceneName: 'Other scene',
          runNumber: 2,
          candidateLabel: '2A',
        },
      });
      selectSceneWithCandidates([edited, original]);

      expect(component.runTooltip(edited)).toBe(
        'Run: 2, Candidate: A (edit of run 1; originally 2A)',
      );
      expect(component.runTooltip(original)).toContain(
        '(originally 2A in Other scene)',
      );
    });
  });

  describe('resizable + collapsible candidate sidebar', () => {
    it('toggles the collapsed state', () => {
      expect(component.sidebarCollapsed()).toBe(false);

      component.toggleSidebarCollapsed();
      expect(component.sidebarCollapsed()).toBe(true);

      component.toggleSidebarCollapsed();
      expect(component.sidebarCollapsed()).toBe(false);
    });

    it('updates the width signal within the min/max clamp', () => {
      // A value inside the range is applied verbatim.
      component.setSidebarWidth(420);
      expect(component.sidebarWidth()).toBe(420);

      // Below the minimum clamps up to SIDEBAR_MIN_WIDTH.
      component.setSidebarWidth(10);
      expect(component.sidebarWidth()).toBe(Storyboard.SIDEBAR_MIN_WIDTH);

      // Above the maximum clamps down to SIDEBAR_MAX_WIDTH.
      component.setSidebarWidth(9999);
      expect(component.sidebarWidth()).toBe(Storyboard.SIDEBAR_MAX_WIDTH);
    });

    it('drives the grid track width and snaps to a rail when collapsed', () => {
      component.setSidebarWidth(360);
      expect(component.sidebarTrackWidth()).toBe(360);

      component.toggleSidebarCollapsed();
      expect(component.sidebarTrackWidth()).toBe(Storyboard.SIDEBAR_RAIL_WIDTH);
      // The expanded width is preserved for when it expands again.
      expect(component.sidebarWidth()).toBe(360);
    });
  });

  describe('getPlaceholdersArray', () => {
    const selectGeneratedScene = (scene: GeneratedScene) => {
      projectConfigSignal.set({
        id: 'test-id',
        name: 'Test Project',
        storyboard: [scene],
        aspectRatio: '16:9',
        candidateDurationSeconds: 4,
        generateAudio: false,
        numberOfCandidates: 1,
        model: 'veo-1',
        resolution: '1080p',
        inputConfig: {products: [], composition: ''},
        audioTracks: [],
        visualOverlays: [],
      });
      component.selectScene(scene.id);
      fixture.detectChanges();
    };

    it('snapshots the placeholder count from an in-flight generation and ignores live slider changes', () => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
        pendingGeneration: {
          executionId: 'exec-1',
          requestedCount: 4,
          startedAt: '2026-06-13T00:00:00.000Z',
          durationSeconds: 4,
          model: 'veo-1',
          generateAudio: false,
          resolution: '1080p',
          prompt: 'test',
        },
      };
      selectGeneratedScene(scene);

      // The run requested 4 candidates, so 4 placeholders regardless of slider.
      expect(component.getPlaceholdersArray().length).toBe(4);

      // Drawing the slider during the in-flight run must NOT change the count.
      component.config.updateProjectConfig({numberOfCandidates: 8});
      fixture.detectChanges();
      expect(component.getPlaceholdersArray().length).toBe(4);

      component.config.updateProjectConfig({numberOfCandidates: 1});
      fixture.detectChanges();
      expect(component.getPlaceholdersArray().length).toBe(4);
    });

    it('follows the live numberOfCandidates config when no generation is in flight', () => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
      };
      selectGeneratedScene(scene);

      component.config.updateProjectConfig({numberOfCandidates: 3});
      fixture.detectChanges();
      expect(component.getPlaceholdersArray().length).toBe(3);

      component.config.updateProjectConfig({numberOfCandidates: 6});
      fixture.detectChanges();
      expect(component.getPlaceholdersArray().length).toBe(6);
    });
  });

  describe('Edit button', () => {
    const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
      video: {url: 'r1.mp4', path: 'path/r1.mp4'},
      runNumber: 1,
      durationSeconds: 4,
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
      ...overrides,
    });

    const selectSceneWithOneCandidate = () => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
        candidates: [makeCandidate()],
      };
      projectConfigSignal.update(config => ({
        ...config,
        storyboard: [scene],
      }));
      component.selectScene('1');
      fixture.detectChanges();
    };

    const selectSceneWithActiveAndArchivedCandidates = () => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
        candidates: [
          makeCandidate(),
          makeCandidate({
            isArchived: true,
            video: {url: 'r1-archived.mp4', path: 'path/r1-archived.mp4'},
          }),
        ],
      };
      projectConfigSignal.update(config => ({
        ...config,
        storyboard: [scene],
      }));
      component.selectScene('1');
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '.archived-panel mat-expansion-panel-header',
        ) as HTMLElement
      ).click();
      fixture.detectChanges();
    };

    it('does not render the Edit button when canEditCandidates() is false', () => {
      canEditCandidatesSignal.set(false);
      selectSceneWithOneCandidate();

      expect(
        fixture.nativeElement.querySelector('.candidate-list .edit-btn'),
      ).toBeNull();
    });

    it('renders the Edit button when canEditCandidates() is true', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithOneCandidate();

      expect(
        fixture.nativeElement.querySelector('.candidate-list .edit-btn'),
      ).not.toBeNull();
    });

    it('labels active and archived edit buttons and disables both during generation', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithActiveAndArchivedCandidates();

      let buttons = Array.from(
        fixture.nativeElement.querySelectorAll('.edit-btn'),
      ) as HTMLButtonElement[];
      expect(buttons).toHaveLength(2);
      expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
        'Edit candidate with prompt',
        'Edit candidate with prompt',
      ]);
      expect(buttons.every(button => !button.disabled)).toBe(true);

      mockRemixEngineService.generatingSceneIds.set(new Set(['1']));
      fixture.detectChanges();
      buttons = Array.from(
        fixture.nativeElement.querySelectorAll('.edit-btn'),
      ) as HTMLButtonElement[];
      expect(buttons.every(button => button.disabled)).toBe(true);

      mockRemixEngineService.generatingSceneIds.set(new Set());
      fixture.detectChanges();
      buttons = Array.from(
        fixture.nativeElement.querySelectorAll('.edit-btn'),
      ) as HTMLButtonElement[];
      expect(buttons.every(button => !button.disabled)).toBe(true);
    });

    it('does not open the edit dialog when a candidate is generating', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithActiveAndArchivedCandidates();
      mockRemixEngineService.generatingSceneIds.set(new Set(['1']));
      fixture.detectChanges();

      const buttons = Array.from(
        fixture.nativeElement.querySelectorAll('.edit-btn'),
      ) as HTMLButtonElement[];
      for (const button of buttons) {
        button.click();
      }
      expect(mockMatDialog.open).not.toHaveBeenCalled();
      expect(mockRemixEngineService.editCandidate).not.toHaveBeenCalled();
    });

    it('opens the dialog and calls editCandidate with a non-empty result, without selecting the candidate', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithOneCandidate();
      mockMatDialog.open = vi.fn().mockReturnValue({
        afterClosed: () => of('make the sky purple'),
      });

      const scene = component.config.projectConfig.value()
        .storyboard[0] as GeneratedScene;
      const btn = fixture.nativeElement.querySelector(
        '.candidate-list .edit-btn',
      );
      btn.click();
      fixture.detectChanges();

      expect(mockMatDialog.open).toHaveBeenCalledWith(EditCandidateDialog);
      expect(mockRemixEngineService.editCandidate).toHaveBeenCalledWith(
        scene,
        0,
        'make the sky purple',
      );
      // The click on the edit button must not also select the candidate
      // (stopPropagation keeps it from bubbling to the video-item's click).
      expect(
        (component.config.projectConfig.value().storyboard[0] as GeneratedScene)
          .selectedCandidateIndex,
      ).toBeUndefined();
    });

    for (const emptyResult of [undefined, '']) {
      it(`calls nothing when the dialog closes with ${JSON.stringify(emptyResult)}`, () => {
        canEditCandidatesSignal.set(true);
        selectSceneWithOneCandidate();
        mockMatDialog.open = vi.fn().mockReturnValue({
          afterClosed: () => of(emptyResult),
        });

        const btn = fixture.nativeElement.querySelector(
          '.candidate-list .edit-btn',
        );
        btn.click();
        fixture.detectChanges();

        expect(mockRemixEngineService.editCandidate).not.toHaveBeenCalled();
      });
    }
  });
  describe('original candidate download', () => {
    let anchor: HTMLAnchorElement;
    let nativeCreateElement: typeof document.createElement;
    let createElementSpy: ReturnType<typeof vi.spyOn>;
    let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
    let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
    let clickSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      nativeCreateElement = document.createElement.bind(document);
      anchor = nativeCreateElement('a');
      createElementSpy = vi
        .spyOn(document, 'createElement')
        .mockImplementation(tag =>
          tag === 'a' ? anchor : nativeCreateElement(tag),
        );
      createObjectUrlSpy = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValue('blob:original');
      revokeObjectUrlSpy = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => undefined);
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      createElementSpy.mockRestore();
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      clickSpy.mockRestore();
    });

    it('downloads the selected candidate original through the media boundary', async () => {
      const candidate: Candidate = {
        runNumber: 2,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'test prompt',
        generateAudio: false,
        resolution: '1080p',
        video: {path: 'video/original.mp4', url: 'https://video/original.mp4'},
      };
      const scene: GeneratedScene = {
        id: 'download-scene',
        type: 'generated',
        name: 'Scene / One',
        prompt: 'test',
        selectedCandidateIndex: 0,
        candidates: [candidate],
      };
      projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
      component.selectScene(scene.id);
      fixture.detectChanges();

      const button = fixture.nativeElement.querySelector(
        '[aria-label="Download original"]',
      ) as HTMLButtonElement;
      expect(button).toBeTruthy();
      mockMediaService.resolve.mockResolvedValue('https://signed/original.mp4');
      mockHttpClient.get.mockReturnValue(
        of(new Blob(['video'], {type: 'video/mp4'})),
      );
      button.click();
      await fixture.whenStable();

      expect(mockMediaService.resolve).toHaveBeenCalledWith(candidate.video);
      expect(mockHttpClient.get).toHaveBeenCalledWith(
        'https://signed/original.mp4',
        {
          responseType: 'blob',
        },
      );
      expect(clickSpy).toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:original');
    });

    it('disables original download when the selected candidate has no media', () => {
      const scene: GeneratedScene = {
        id: 'missing-media-scene',
        type: 'generated',
        name: 'Scene',
        prompt: 'test',
        selectedCandidateIndex: 0,
        candidates: [
          {
            runNumber: 1,
            durationSeconds: 4,
            model: 'veo-1',
            prompt: 'test',
            generateAudio: true,
            resolution: '1080p',
          },
        ],
      };
      projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
      component.selectScene(scene.id);
      fixture.detectChanges();

      const button = fixture.nativeElement.querySelector(
        '[aria-label="Download original"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(mockMediaService.resolve).not.toHaveBeenCalled();
    });

    it('keeps the click-time candidate and filename while media resolution is pending', async () => {
      let resolveMedia!: (url: string) => void;
      mockMediaService.resolve.mockImplementation(
        () => new Promise<string>(resolve => (resolveMedia = resolve)),
      );
      mockHttpClient.get.mockReturnValue(
        of(new Blob(['video'], {type: 'video/mp4'})),
      );
      const candidate: Candidate = {
        runNumber: 1,
        durationSeconds: 4,
        model: 'veo-1',
        prompt: 'original',
        generateAudio: true,
        resolution: '1080p',
        video: {path: 'video/original.mp4', url: 'https://video/original.mp4'},
      };
      const scene: GeneratedScene = {
        id: 'snapshot-scene',
        type: 'generated',
        name: 'Original Scene',
        prompt: 'test',
        selectedCandidateIndex: 0,
        candidates: [candidate],
      };
      projectConfigSignal.update(config => ({...config, storyboard: [scene]}));
      component.selectScene(scene.id);
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector(
        '[aria-label="Download original"]',
      ) as HTMLButtonElement;
      expect(document.createElement('div')).toBeInstanceOf(HTMLDivElement);

      const resolveCallsBeforeDownload =
        mockMediaService.resolve.mock.calls.length;
      button.click();
      button.click();
      expect(mockMediaService.resolve).toHaveBeenCalledTimes(
        resolveCallsBeforeDownload + 1,
      );
      candidate.video = {
        path: 'video/renamed.webm',
        url: 'https://video/renamed.webm',
      };
      projectConfigSignal.update(config => ({...config, name: 'Renamed'}));
      resolveMedia('https://signed/original.mp4');
      await fixture.whenStable();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(anchor.download).toBe(
        'Test_Project_Original_Scene_1A_original.mp4',
      );
    });
  });
});
