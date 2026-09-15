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
import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConfigService,
  GeneratedScene,
  ProjectConfig,
} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {CandidateVideoCacheService} from '../services/media/candidate-video-cache';
import {Composition} from './composition';
import {RemixEngineService} from '../services/remix-engine/remix-engine';

class MemoryCache {
  readonly values = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.values.delete(request.url);
  }

  async keys(): Promise<Request[]> {
    return [...this.values.keys()].map(key => new Request(key));
  }
}

describe('Composition cache integration', () => {
  let fixture: ComponentFixture<Composition>;
  let projectConfigSignal: WritableSignal<ProjectConfig>;
  let http: HttpTestingController;
  let cache: MemoryCache;
  let fetchMock: ReturnType<typeof vi.fn>;
  let mediaService: MediaService;
  let candidateVideoCache: CandidateVideoCacheService;
  let component: Composition;

  const scope = {bucket: 'bucket-a', projectId: 'project-a'};
  const videoPath = 'videos/candidate.mp4';
  const signedVideoUrl = 'https://signed.example/candidate.mp4';
  type TestRequest = ReturnType<HttpTestingController['expectOne']>;

  function project(): ProjectConfig {
    const candidate = {
      runNumber: 1,
      durationSeconds: 4,
      model: 'veo-1',
      prompt: 'test prompt',
      generateAudio: false,
      resolution: '1080p' as const,
      video: {path: videoPath, url: 'https://stored.example/candidate.mp4'},
      lowQualityThumbnail: 'data:image/png;base64,thumbnail',
    };
    const scene: GeneratedScene = {
      id: 'scene-1',
      type: 'generated',
      name: 'Scene 1',
      prompt: candidate.prompt,
      selectedCandidateIndex: 0,
      candidates: [candidate],
    };
    return {
      id: scope.projectId,
      name: 'Project',
      aspectRatio: '16:9',
      resolution: '1080p',
      candidateDurationSeconds: 4,
      generateAudio: false,
      numberOfCandidates: 1,
      model: 'veo-1',
      inputConfig: {products: []},
      storyboard: [scene],
      audioTracks: [],
      visualOverlays: [],
    };
  }

  function sceneFor(
    id: string,
    path: string,
    trim?: {start?: number; end?: number},
    generateAudio = false,
    durationSeconds = 4,
  ): GeneratedScene {
    const scene = project().storyboard[0] as GeneratedScene;
    const candidate = scene.candidates![0];
    return {
      ...scene,
      id,
      candidates: [
        {
          ...candidate,
          generateAudio,
          durationSeconds,
          trim,
          video: {path, url: `https://stored.example/${id}.mp4`},
        },
      ],
    };
  }

  async function waitForSignRequest(path: string): Promise<TestRequest> {
    let signRequest: TestRequest | undefined;
    await vi.waitFor(() => {
      const [request] = http.match(
        `/api/signUrl?path=${encodeURIComponent(path)}`,
      );
      expect(request).toBeDefined();
      signRequest = request;
    });
    return signRequest!;
  }

  async function warmCandidate(path: string): Promise<void> {
    const warmup = candidateVideoCache.acquire(scope, {path}, true);
    const signRequest = await waitForSignRequest(path);
    signRequest.flush({
      urls: {[path]: `https://signed.example/${path}`},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    (await warmup).release();
  }

  beforeEach(async () => {
    projectConfigSignal = signal(project());
    cache = new MemoryCache();
    fetchMock = vi.fn();
    vi.stubGlobal('caches', {open: vi.fn().mockResolvedValue(cache)});
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:cached');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const config = {
      projectConfig: {value: projectConfigSignal, isLoading: signal(false)},
      globalConfig: {value: () => ({gcsBucket: scope.bucket})},
      projectLoadError: signal(false),
      reloadProjectConfig: vi.fn(),
      isGeneratedScene: (scene: ProjectConfig['storyboard'][number]) =>
        scene.type === 'generated',
      isProvidedVideoScene: (scene: ProjectConfig['storyboard'][number]) =>
        scene.type === 'video',
      updateProjectConfig: vi.fn(),
    };
    const remix = {
      combiningScenes: signal(false),
      uploadMedia: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Composition, MatSnackBarModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: ConfigService, useValue: config},
        MediaService,
        CandidateVideoCacheService,
        {provide: RemixEngineService, useValue: remix},
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    mediaService = TestBed.inject(MediaService);
    candidateVideoCache = TestBed.inject(CandidateVideoCacheService);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses a warm candidate body in Composition without another signing or video request', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {'content-type': 'video/mp4'},
      }),
    );
    const warmup = candidateVideoCache.acquire(scope, {path: videoPath}, true);
    const signRequest = await waitForSignRequest(videoPath);
    signRequest.flush({
      urls: {[videoPath]: signedVideoUrl},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    (await warmup).release();
    fetchMock.mockClear();

    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;

    await vi.waitFor(() => expect(video.src).toContain('blob:cached'));

    expect(video.src).toContain('blob:cached');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaService.getCachedUrl(videoPath)).toBe(signedVideoUrl);
  });

  it('streams the signed URL on a cold cache miss without fetching the video body', async () => {
    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;
    const signRequest = await waitForSignRequest(videoPath);
    expect(fetchMock).not.toHaveBeenCalled();
    signRequest.flush({
      urls: {[videoPath]: signedVideoUrl},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await vi.waitFor(() => expect(video.src).toContain(signedVideoUrl));

    expect(video.src).toContain(signedVideoUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases the old lease and fences a stale middle clip during rapid source changes', async () => {
    let objectUrlNumber = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(
      () => `blob:cached-${++objectUrlNumber}`,
    );
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {'content-type': 'video/mp4'},
      }),
    );
    await warmCandidate('videos/a.mp4');
    fetchMock.mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();

    projectConfigSignal.set({
      ...project(),
      storyboard: [
        sceneFor('scene-a', 'videos/a.mp4'),
        sceneFor('scene-b', 'videos/b.mp4'),
        sceneFor('scene-c', 'videos/c.mp4'),
      ],
    });
    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;
    await vi.waitFor(() => expect(video.src).toContain('blob:cached'));

    component.seek({target: {value: '5'}} as unknown as Event);
    fixture.detectChanges();
    const staleRequest = await waitForSignRequest('videos/b.mp4');
    const sourceA = video.src;

    component.seek({target: {value: '9'}} as unknown as Event);
    fixture.detectChanges();
    const currentRequest = await waitForSignRequest('videos/c.mp4');
    currentRequest.flush({
      urls: {'videos/c.mp4': 'https://signed.example/videos/c.mp4'},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await vi.waitFor(() =>
      expect(video.src).toContain('https://signed.example/videos/c.mp4'),
    );
    expect(video.src).not.toBe(sourceA);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith(sourceA);

    staleRequest.flush({
      urls: {'videos/b.mp4': 'https://signed.example/videos/b.mp4'},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(video.src).toContain('https://signed.example/videos/c.mp4'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(1);
  });

  it('repositions same-path trimmed clips and follows the selected clip audio state', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {'content-type': 'video/mp4'},
      }),
    );
    await warmCandidate('videos/shared.mp4');
    fetchMock.mockClear();

    projectConfigSignal.set({
      ...project(),
      storyboard: [
        sceneFor(
          'scene-one',
          'videos/shared.mp4',
          {start: 0, end: 4},
          false,
          10,
        ),
        sceneFor(
          'scene-two',
          'videos/shared.mp4',
          {start: 5, end: 9},
          true,
          10,
        ),
      ],
    });
    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;
    await vi.waitFor(() => expect(video.src).toContain('blob:cached'));
    expect(video.muted).toBe(true);
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: 3.9,
    });

    component.seek({target: {value: '5'}} as unknown as Event);
    fixture.detectChanges();

    expect(component.currentPlaylistIndex()).toBe(1);
    expect(video.currentTime).toBe(6);
    expect(video.muted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('automatically advances a same-path trimmed clip without metadata events', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {'content-type': 'video/mp4'},
      }),
    );
    await warmCandidate('videos/shared.mp4');
    fetchMock.mockClear();

    projectConfigSignal.set({
      ...project(),
      storyboard: [
        sceneFor(
          'scene-one',
          'videos/shared.mp4',
          {start: 0, end: 4},
          false,
          10,
        ),
        sceneFor(
          'scene-two',
          'videos/shared.mp4',
          {start: 5, end: 9},
          true,
          10,
        ),
      ],
    });
    fixture = TestBed.createComponent(Composition);
    component = fixture.componentInstance;
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      '.preview-video',
    ) as HTMLVideoElement;
    await vi.waitFor(() => expect(video.src).toContain('blob:cached'));
    Object.defineProperties(video, {
      currentTime: {configurable: true, writable: true, value: 4},
      readyState: {configurable: true, value: 4},
      seeking: {configurable: true, value: false},
    });

    component.onTimeUpdate({target: video} as unknown as Event);
    fixture.detectChanges();

    expect(component.currentPlaylistIndex()).toBe(1);
    expect(video.currentTime).toBe(5);
    expect(video.muted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
