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
import {MatSnackBar} from '@angular/material/snack-bar';
import {NavigationStart, Router} from '@angular/router';
import {Subject} from 'rxjs';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Storyboard} from './storyboard';

describe('Storyboard original download', () => {
  let component: Storyboard;
  let fixture: ComponentFixture<Storyboard>;
  let http: HttpTestingController;
  let routerEvents: Subject<unknown>;
  let projectConfig: ReturnType<typeof signal<ProjectConfig>>;
  let snackBar: {open: ReturnType<typeof vi.fn>};
  let createObjectUrl: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrl: ReturnType<typeof vi.spyOn>;
  let createElement: ReturnType<typeof vi.spyOn>;
  let anchor: HTMLAnchorElement;

  const candidate = (path: string, runNumber = 1, url = ''): Candidate => ({
    runNumber,
    durationSeconds: 4,
    model: 'veo-1',
    prompt: 'prompt',
    generateAudio: false,
    resolution: '1080p',
    video: {path, url},
  });

  function sceneWithCandidates(
    candidates: Candidate[],
    selectedCandidateIndex = 0,
  ): GeneratedScene {
    return {
      id: 'scene-1',
      type: 'generated',
      name: 'Scene / One',
      prompt: 'prompt',
      selectedCandidateIndex,
      candidates,
    };
  }

  function setProject(storyboard: GeneratedScene[], id = 'project-1') {
    projectConfig.set({
      id,
      name: 'Project / One',
      storyboard,
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
  }

  async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  }

  beforeEach(async () => {
    projectConfig = signal<ProjectConfig>({
      id: 'project-1',
      name: 'Project / One',
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
    routerEvents = new Subject<unknown>();
    snackBar = {open: vi.fn()};
    const config = {
      projectConfig: {
        value: projectConfig,
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
      updateProjectConfig: (partial: Partial<ProjectConfig>) =>
        projectConfig.update(p => ({...p, ...partial})),
      videoModels: () => [],
      canEditCandidates: signal(false),
      audioLocked: () => false,
      durationSlider: signal({min: 4, max: 8, step: 2}),
      selectVideoModel: vi.fn(),
      sceneIdCounter: signal(0),
      primaryColor: signal('theme-green'),
      isGeneratedScene: (scene: unknown): scene is GeneratedScene =>
        (scene as GeneratedScene)?.type === 'generated',
      isProvidedVideoScene: () => false,
    };
    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: ConfigService, useValue: config},
        {
          provide: RemixEngineService,
          useValue: {
            generatingSceneIds: signal(new Set()),
            editingSceneIds: signal(new Set()),
          },
        },
        {provide: MatSnackBar, useValue: snackBar},
        {provide: Router, useValue: {events: routerEvents}},
      ],
    })
      .overrideComponent(Storyboard, {
        set: {
          template: '<button (click)="downloadOriginal()">Download</button>',
          providers: [{provide: MatSnackBar, useValue: snackBar}],
        },
      })
      .compileComponents();
    fixture = TestBed.createComponent(Storyboard);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    setProject([sceneWithCandidates([candidate('videos/original.webm')])]);
    createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test');
    revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const nativeCreateElement = document.createElement.bind(document);
    anchor = nativeCreateElement('a');
    createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(tag =>
        tag === 'a' ? anchor : nativeCreateElement(tag),
      );
    vi.spyOn(anchor, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    http.verify({ignoreCancelled: true});
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
    createElement.mockRestore();
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  function sign(path: string, url = 'https://signed.test/video') {
    const request = http.expectOne(
      `/api/signUrl?path=${encodeURIComponent(path)}`,
    );
    request.flush({
      urls: {[path]: url},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  }

  function blob(url = 'https://signed.test/video', type = 'video/webm') {
    const request = http.expectOne(url);
    request.flush(new Blob(['video'], {type}));
  }

  it('signs then fetches the original and downloads the captured filename', async () => {
    fixture.nativeElement.querySelector('button').click();
    sign('videos/original.webm');
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchor.download).toBe('Project_One_Scene_One_1A_original.webm');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
  });

  it('shows an error for signing failure and retries successfully', async () => {
    component.downloadOriginal();
    http
      .expectOne('/api/signUrl?path=videos%2Foriginal.webm')
      .flush(null, {status: 500, statusText: 'Server Error'});
    await flushMicrotasks();
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Failed to download original video.',
        'Dismiss',
      ),
    );
    component.downloadOriginal();
    sign('videos/original.webm');
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('shows an error for blob failure and retries using the signed URL', async () => {
    component.downloadOriginal();
    sign('videos/original.webm');
    await flushMicrotasks();
    http
      .expectOne('https://signed.test/video')
      .error(new ProgressEvent('error'), {
        status: 502,
        statusText: 'Bad Gateway',
      });
    await flushMicrotasks();
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Failed to download original video.',
        'Dismiss',
      ),
    );
    expect(component.downloadInProgress()).toBe(false);
    component.downloadOriginal();
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate clicks while a download is in progress', async () => {
    component.downloadOriginal();
    await Promise.resolve();
    component.downloadOriginal();
    const requests = http.match(request =>
      request.url.includes('/api/signUrl'),
    );
    expect(requests).toHaveLength(1);
    requests[0].flush({
      urls: {'videos/original.webm': 'https://signed.test/video'},
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
  });

  it('keeps the captured candidate path and extension when selection changes', async () => {
    const scene = sceneWithCandidates([
      candidate('videos/first.webm'),
      candidate('videos/second.mp4', 2),
    ]);
    setProject([scene]);
    component.downloadOriginal();
    component.selectCandidate(scene, 1);
    sign('videos/first.webm');
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
    expect(anchor.download).toContain('1A_original.webm');
  });

  it('ignores URL queries for extensions and falls back to bin for unknown MIME', async () => {
    const scene = sceneWithCandidates([
      candidate('videos/original?token=1.mp4'),
    ]);
    setProject([scene]);
    component.downloadOriginal();
    sign('videos/original?token=1.mp4');
    await flushMicrotasks();
    blob('https://signed.test/video', 'video/x-custom');
    await flushMicrotasks();
    expect(anchor.download).toContain('_original.bin');
  });

  it('uses a pathless legacy URL without its query string for the filename', async () => {
    const scene = sceneWithCandidates([
      candidate('', 1, 'https://legacy.test/original.mp4?token=abc'),
    ]);
    setProject([scene]);
    component.downloadOriginal();
    await flushMicrotasks();
    blob('https://legacy.test/original.mp4?token=abc', 'video/mp4');
    await flushMicrotasks();
    expect(anchor.download).toContain('_original.mp4');
  });

  it('keeps the captured names while an extensionless download is pending', async () => {
    const scene = sceneWithCandidates([candidate('videos/original')]);
    setProject([scene]);
    component.downloadOriginal();
    sign('videos/original');
    await flushMicrotasks();
    // Existing two-way-bound controls can mutate these objects before saving.
    projectConfig().name = 'Changed Project';
    component.selectedScene()!.name = 'Changed Scene';
    const expectedBlob = new Blob(['video'], {type: 'video/mp4'});
    http.expectOne('https://signed.test/video').flush(expectedBlob);
    await flushMicrotasks();
    expect(anchor.download).toBe('Project_One_Scene_One_1A_original.mp4');
    expect(createObjectUrl).toHaveBeenCalledWith(expectedBlob);
  });

  it('suppresses a stale A download across NavigationStart A-B-A and permits the new one', async () => {
    component.downloadOriginal();
    routerEvents.next(new NavigationStart(1, '/b'));
    routerEvents.next(new NavigationStart(2, '/a'));
    component.downloadOriginal();
    sign('videos/original.webm');
    await flushMicrotasks();
    blob();
    await flushMicrotasks();
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('cancels the blob request on navigation without showing an error', async () => {
    component.downloadOriginal();
    sign('videos/original.webm');
    await flushMicrotasks();
    const request = http.expectOne('https://signed.test/video');
    routerEvents.next(new NavigationStart(1, '/other'));
    await flushMicrotasks();
    expect(request.cancelled).toBe(true);
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('cancels the blob request on destroy without showing an error', async () => {
    component.downloadOriginal();
    sign('videos/original.webm');
    await flushMicrotasks();
    const request = http.expectOne('https://signed.test/video');
    fixture.destroy();
    await flushMicrotasks();
    expect(request.cancelled).toBe(true);
    expect(snackBar.open).not.toHaveBeenCalled();
  });
});
