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

import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConfigService,
  GcsFile,
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Composition} from './composition';

describe('CompositionComponent', () => {
  let component: Composition;
  let fixture: ComponentFixture<Composition>;
  let mockConfigService: unknown;
  let mockMediaService: {
    getCachedUrl: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    signUrl: ReturnType<typeof vi.fn>;
    signUrls: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    getBlob: ReturnType<typeof vi.fn>;
  };
  let projectConfigSignal: WritableSignal<ProjectConfig>;

  beforeEach(async () => {
    projectConfigSignal = signal<ProjectConfig>({
      id: 'test-project',
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

    mockConfigService = {
      projectConfig: {
        value: projectConfigSignal,
        isLoading: signal(false),
      },
      updateProjectConfig: vi.fn(),
      isGeneratedScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is GeneratedScene => scene.type === 'generated',
      isProvidedVideoScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is ProvidedVideoScene => scene.type === 'video',
    };

    const mockRemixEngineService = {
      uploadMedia: vi.fn(),
      generatingSceneIds: signal(new Set()),
      combineScenes: vi.fn(),
      combiningScenes: signal(false),
    };

    // The template's mediaSrc pipe and the component's held-src/pre-warm
    // effects inject MediaService, which in turn injects HttpClient and
    // signed GCS URLs; stub the service itself so no real providers are
    // needed. The held-src specs below reconfigure the mocks per test.
    mockMediaService = {
      getCachedUrl: vi.fn().mockReturnValue(undefined),
      resolve: vi.fn().mockResolvedValue(''),
      signUrl: vi.fn().mockResolvedValue(''),
      signUrls: vi.fn().mockResolvedValue(new Map()),
      upload: vi.fn(),
      getBlob: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Composition, MatSnackBarModule],
      providers: [
        {provide: ConfigService, useValue: mockConfigService},
        {provide: MediaService, useValue: mockMediaService},
        {provide: RemixEngineService, useValue: mockRemixEngineService},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have an empty filmstrip when there are no scenes', () => {
    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [],
    });
    expect(component.filmstripScenes().length).toBe(0);
  });

  it('does not render a URL-only provided video', () => {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {
          id: 'legacy-video',
          type: 'video',
          name: 'Legacy video',
          video: {url: 'https://legacy.example/video.mp4', path: ''},
          durationSeconds: 5,
        },
      ],
    }));

    expect(component.filmstripScenes()).toEqual([]);
    expect(component.canRender()).toBe(false);
  });

  it('treats a legacy URL-only video with no path field as invalid', () => {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {
          id: 'legacy-video-without-path',
          type: 'video',
          name: 'Legacy video without path',
          video: {
            url: 'https://legacy.example/video.mp4',
          } as unknown as GcsFile,
          durationSeconds: 5,
        },
      ],
    }));

    expect(component.filmstripScenes()).toEqual([]);
    expect(component.canRender()).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
  ])(
    'does not render a provided video with %s duration',
    (_label, duration) => {
      projectConfigSignal.update(config => ({
        ...config,
        storyboard: [
          {
            id: 'invalid-video',
            type: 'video',
            name: 'Invalid video',
            video: {url: '', path: 'videos/invalid.mp4'},
            durationSeconds: duration,
          },
        ],
      }));

      expect(component.filmstripScenes()).toEqual([]);
      expect(component.canRender()).toBe(false);
    },
  );

  it('does not render a persisted trim shorter than one 24fps frame', () => {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {
          id: 'too-short',
          type: 'video',
          name: 'Too-short clip',
          video: {url: '', path: 'videos/too-short.mp4'},
          durationSeconds: 5,
          trim: {start: 2, end: 2.041},
        },
      ],
    }));

    expect(component.filmstripScenes()).toEqual([]);
    expect(component.canRender()).toBe(false);
  });

  it('renders a persisted trim that contains one full 24fps frame', () => {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {
          id: 'one-frame',
          type: 'video',
          name: 'One-frame clip',
          video: {url: '', path: 'videos/one-frame.mp4'},
          durationSeconds: 5,
          trim: {start: 2, end: 2.042},
        },
      ],
    }));

    expect(component.filmstripScenes().map(scene => scene.id)).toEqual([
      'one-frame',
    ]);
    expect(component.canRender()).toBe(true);
    expect(Math.round(component.playlist()[0].duration * 24)).toBe(1);
  });

  it('blocks a partial render when an intended clip is invalid', () => {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {
          id: 'ready',
          type: 'video',
          name: 'Ready clip',
          video: {url: '', path: 'videos/ready.mp4'},
          durationSeconds: 5,
        },
        {
          id: 'invalid',
          type: 'video',
          name: 'Invalid clip',
          video: {url: '', path: 'videos/invalid.mp4'},
          durationSeconds: Number.NaN,
        },
      ],
    }));

    expect(component.filmstripScenes().map(scene => scene.id)).toEqual([
      'ready',
    ]);
    expect(component.canRender()).toBe(false);
    expect(component.renderDisabledReason()).toContain(
      'storage path or valid duration',
    );
  });

  it('should show a generated scene in the filmstrip if it has a selected candidate', () => {
    const generatedScene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [
        {
          runNumber: 1,
          durationSeconds: 5,
          prompt: 'test prompt',
          model: 'veo-1',
          generateAudio: false,
          video: {url: 'http://video.url', path: 'path/to/video'},
          resolution: '1080p',
        },
      ],
      selectedCandidateIndex: 0,
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [generatedScene],
    });

    expect(component.filmstripScenes().length).toBe(1);
    expect(component.filmstripScenes()[0].id).toBe('1');
  });

  it('should NOT show a generated scene in the filmstrip if it has NO selected candidate', () => {
    const generatedScene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [generatedScene],
    });

    expect(component.filmstripScenes().length).toBe(0);
  });

  it('shows a provided video with a path and positive duration', () => {
    const videoScene: ProvidedVideoScene = {
      id: '2',
      type: 'video',
      name: 'Scene 2',
      video: {url: 'http://video.url/2', path: 'path/to/video/2'},
      durationSeconds: 5,
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [videoScene],
    });

    expect(component.filmstripScenes().length).toBe(1);
    expect(component.filmstripScenes()[0].id).toBe('2');
  });

  it('should show a generated scene whose candidate has a path but a blank url', () => {
    // Downstream resolves media by path, so a scene persisted with only a path
    // (no url) must still appear in the filmstrip.
    const generatedScene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [
        {
          runNumber: 1,
          durationSeconds: 5,
          prompt: 'test prompt',
          model: 'veo-1',
          generateAudio: false,
          video: {url: '', path: 'path/to/video'},
          resolution: '1080p',
        },
      ],
      selectedCandidateIndex: 0,
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [generatedScene],
    });

    expect(component.filmstripScenes().length).toBe(1);
    expect(component.filmstripScenes()[0].id).toBe('1');
  });

  it('should show a video scene that has a path but a blank url', () => {
    const videoScene: ProvidedVideoScene = {
      id: '2',
      type: 'video',
      name: 'Scene 2',
      video: {url: '', path: 'path/to/video/2'},
      durationSeconds: 5,
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [videoScene],
    });

    expect(component.filmstripScenes().length).toBe(1);
    expect(component.filmstripScenes()[0].id).toBe('2');
  });

  it('should NOT show a video scene if it has neither a path nor a url', () => {
    const videoScene: ProvidedVideoScene = {
      id: '2',
      type: 'video',
      name: 'Scene 2',
      video: {url: '', path: ''},
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [videoScene],
    });

    expect(component.filmstripScenes().length).toBe(0);
  });

  it('should NOT show a video scene in the filmstrip if it has NO video', () => {
    const videoScene: ProvidedVideoScene = {
      id: '2',
      type: 'video',
      name: 'Scene 2',
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [videoScene],
    });

    expect(component.filmstripScenes().length).toBe(0);
  });

  it('should show mixed scenes correctly in the filmstrip', () => {
    const storyboard: Array<GeneratedScene | ProvidedVideoScene> = [
      {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'p1',
        selectedCandidateIndex: 0,
        candidates: [
          {
            runNumber: 1,
            durationSeconds: 5,
            prompt: 'p1',
            model: 'v1',
            video: {url: 'u1', path: 'path1'},
            generateAudio: false,
            resolution: '1080p',
          },
        ],
      },
      {
        id: '2',
        type: 'video',
        name: 'Scene 2',
      },
      {
        id: '3',
        type: 'video',
        name: 'Scene 3',
        video: {url: 'u3', path: 'path3'},
        durationSeconds: 5,
      },
      {
        id: '4',
        type: 'generated',
        name: 'Scene 4',
        prompt: 'p4',
      },
    ];

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard,
    });

    const filmstrip = component.filmstripScenes();
    expect(filmstrip.length).toBe(2);
    expect(filmstrip[0].id).toBe('1');
    expect(filmstrip[1].id).toBe('3');
  });

  it('should calculate totalDuration correctly for mixed scene types', () => {
    const storyboard: Array<GeneratedScene | ProvidedVideoScene> = [
      {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'p1',
        selectedCandidateIndex: 0,
        candidates: [
          {
            runNumber: 1,
            durationSeconds: 10,
            prompt: 'p1',
            model: 'v1',
            video: {url: 'u1', path: 'path1'},
            generateAudio: false,
            trim: {start: 2, end: 8}, // effective duration 6s
            resolution: '1080p',
          },
        ],
      },
      {
        id: '2',
        type: 'video',
        name: 'Scene 2',
        video: {url: 'u2', path: 'path2'},
        durationSeconds: 15, // duration 15s
      },
    ];

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard,
    });

    expect(component.totalDuration()).toBe(21); // 6 + 15
  });

  it('should call combineScenes when renderVideo is called', () => {
    const remixEngineService = TestBed.inject(RemixEngineService);
    component.renderVideo();
    expect(remixEngineService.combineScenes).toHaveBeenCalled();
  });

  it('should disable the render button when combiningScenes is true', () => {
    const remixEngineService = TestBed.inject(RemixEngineService);
    remixEngineService.combiningScenes.set(true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button.mat-primary');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Rendering...');
  });

  it('reports the render-in-progress reason ahead of other disabled reasons', () => {
    const remixEngineService = TestBed.inject(RemixEngineService);
    // An invalid scene would normally set its own disabled reason; a render
    // already in progress must be reported instead.
    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [
        {
          id: 'invalid',
          type: 'video',
          name: 'Invalid clip',
          video: {url: '', path: 'videos/invalid.mp4'},
          durationSeconds: Number.NaN,
        },
      ],
    });
    remixEngineService.combiningScenes.set(true);
    fixture.detectChanges();

    expect(component.renderDisabledReason()).toBe(
      'Video rendering is in progress.',
    );
    const button = fixture.nativeElement.querySelector('button.mat-primary');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Rendering...');
  });

  it('should enable the render button when combiningScenes is false', () => {
    const remixEngineService = TestBed.inject(RemixEngineService);
    // The render button also requires at least one renderable scene (a
    // non-empty playlist), so seed a generated scene with a selected candidate.
    const renderableScene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [
        {
          runNumber: 1,
          durationSeconds: 5,
          model: 'veo-3.0-generate-001',
          prompt: 'test prompt',
          generateAudio: false,
          resolution: '1080p',
          video: {url: 'http://video.url', path: 'path/to/video'},
        },
      ],
      selectedCandidateIndex: 0,
    };
    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [renderableScene],
    });
    remixEngineService.combiningScenes.set(false);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button.mat-primary');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Render Video');
  });

  describe('player src (held, never null)', () => {
    // Two clips: clip 1 spans 0-10s, clip 2 spans 10-15s on the timeline.
    const twoClipStoryboard: ProvidedVideoScene[] = [
      {
        id: 's1',
        type: 'video',
        name: 'Clip 1',
        video: {url: 'http://stored/1', path: 'videos/clip1.mp4'},
        durationSeconds: 10,
      },
      {
        id: 's2',
        type: 'video',
        name: 'Clip 2',
        video: {url: 'http://stored/2', path: 'videos/clip2.mp4'},
        durationSeconds: 5,
      },
    ];

    function loadTwoClipStoryboard() {
      projectConfigSignal.set({
        ...projectConfigSignal(),
        storyboard: structuredClone(twoClipStoryboard),
      });
      fixture.detectChanges();
    }

    function seekTo(seconds: number) {
      component.seek({
        target: {value: String(seconds)},
      } as unknown as Event);
      fixture.detectChanges();
    }

    it('pre-signs every playlist entry path in one batch when the playlist computes', () => {
      loadTwoClipStoryboard();

      expect(mockMediaService.signUrls).toHaveBeenCalledWith([
        'videos/clip1.mp4',
        'videos/clip2.mp4',
      ]);
    });

    it('holds the previous src (never null) across a cross-clip seek while the new URL resolves', async () => {
      mockMediaService.getCachedUrl.mockImplementation((path: string) =>
        path === 'videos/clip1.mp4' ? 'https://signed/clip1' : undefined,
      );
      // resolve() backs both the filmstrip thumbnail pipe (cold clip-2
      // thumbnail at load) and the held-src cache-miss fallback (clip 2 at
      // seek); the overwrite capture keeps the latest resolver — the
      // seek's.
      let resolveClip2!: (url: string) => void;
      mockMediaService.resolve.mockImplementation(
        () =>
          new Promise<string>(resolve => {
            resolveClip2 = resolve;
          }),
      );

      loadTwoClipStoryboard();
      expect(component.heldVideoSrc()).toBe('https://signed/clip1');

      seekTo(12); // Lands in clip 2 (10-15s).

      expect(component.currentPlaylistIndex()).toBe(1);
      // Cache misses go through MediaService.resolve — the per-mode shim —
      // never directly through the mediated-plane signUrl.
      expect(mockMediaService.resolve).toHaveBeenCalledWith(
        expect.objectContaining({path: 'videos/clip2.mp4'}),
      );
      expect(mockMediaService.signUrl).not.toHaveBeenCalled();
      // The new clip's URL is still in flight: the bound src must hold the
      // previous URL instead of transitioning to null.
      expect(component.heldVideoSrc()).toBe('https://signed/clip1');

      resolveClip2('https://signed/clip2');
      await vi.waitFor(() => {
        expect(component.heldVideoSrc()).toBe('https://signed/clip2');
      });
      expect(component.currentPlaylistIndex()).toBe(1);
    });

    it('swaps the src synchronously on a cross-clip seek when the URL is cached', () => {
      mockMediaService.getCachedUrl.mockImplementation((path: string) =>
        path === 'videos/clip1.mp4'
          ? 'https://signed/clip1'
          : 'https://signed/clip2',
      );

      loadTwoClipStoryboard();
      expect(component.heldVideoSrc()).toBe('https://signed/clip1');

      seekTo(12);

      expect(component.heldVideoSrc()).toBe('https://signed/clip2');
      expect(mockMediaService.signUrl).not.toHaveBeenCalled();
      expect(mockMediaService.resolve).not.toHaveBeenCalled();
    });

    it('resolves the src in the same pass the playlist computes (no one-tick null binding)', () => {
      mockMediaService.getCachedUrl.mockImplementation((path: string) =>
        path === 'videos/clip1.mp4' ? 'https://signed/clip1' : undefined,
      );

      projectConfigSignal.set({
        ...projectConfigSignal(),
        storyboard: structuredClone(twoClipStoryboard),
      });

      // Read synchronously, before any change detection or effect flush:
      // the src must already be the cached URL — the same-pass timing the
      // impure mediaSrc pipe gave this binding at baseline, so the <video>
      // element never sees an interim null src.
      expect(component.heldVideoSrc()).toBe('https://signed/clip1');
    });

    it('keeps a null src while the playlist is empty', () => {
      fixture.detectChanges();

      expect(component.heldVideoSrc()).toBeNull();
      expect(mockMediaService.signUrls).not.toHaveBeenCalled();
    });
  });

  describe('scrubbing pauses playback while the dot is held', () => {
    // Two clips: clip 1 spans 0-10s, clip 2 spans 10-15s on the timeline.
    const twoClipStoryboard: ProvidedVideoScene[] = [
      {
        id: 's1',
        type: 'video',
        name: 'Clip 1',
        video: {url: 'http://stored/1', path: 'videos/clip1.mp4'},
        durationSeconds: 10,
      },
      {
        id: 's2',
        type: 'video',
        name: 'Clip 2',
        video: {url: 'http://stored/2', path: 'videos/clip2.mp4'},
        durationSeconds: 5,
      },
    ];

    function loadTwoClipStoryboard() {
      projectConfigSignal.set({
        ...projectConfigSignal(),
        storyboard: structuredClone(twoClipStoryboard),
      });
      fixture.detectChanges();
    }

    function seekTo(seconds: number) {
      component.seek({
        target: {value: String(seconds)},
      } as unknown as Event);
      fixture.detectChanges();
    }

    it('pauses on drag-start while playing, holds the seeked position, and resumes on drag-end', () => {
      loadTwoClipStoryboard();

      // User is playing the composed video.
      component.isPlaying.set(true);
      expect(component.isPlaying()).toBe(true);

      // User grabs the dot: playback must pause so the held frame stays put.
      component.onScrubStart();
      expect(component.isPlaying()).toBe(false);

      // User drags the dot to 4s and holds it there. The playback loop is
      // gated on isPlaying(), so with playback paused it never runs to advance
      // totalCurrentTime past the held position.
      seekTo(4);
      expect(component.totalCurrentTime()).toBe(4);

      // Simulate the playback loop firing while the dot is held: because the
      // pause stopped the loop, the held position is unchanged. onTimeUpdate()
      // bails before reaching a ready <video>, so the held time stays at 4s.
      component.onTimeUpdate();
      expect(component.totalCurrentTime()).toBe(4);

      // User releases the dot: playback resumes because it was playing before.
      component.onScrubEnd();
      expect(component.isPlaying()).toBe(true);
    });

    it('does not start playback on drag-end when it was paused before the drag', () => {
      loadTwoClipStoryboard();

      // User is paused (the default state) and scrubs to preview a frame.
      expect(component.isPlaying()).toBe(false);

      component.onScrubStart();
      expect(component.isPlaying()).toBe(false);

      seekTo(4);
      expect(component.totalCurrentTime()).toBe(4);

      // Releasing must NOT auto-start playback: it was not playing before.
      component.onScrubEnd();
      expect(component.isPlaying()).toBe(false);
    });
  });
});
