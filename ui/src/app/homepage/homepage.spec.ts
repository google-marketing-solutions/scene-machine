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

import {signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {provideRouter} from '@angular/router';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {env} from '../../env';
import {
  ConfigService,
  GeneratedScene,
  ProjectConfig,
  ProjectSummary,
} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {ThumbnailCacheService} from '../services/media/thumbnail-cache';
import {Homepage} from './homepage';

describe('Homepage', () => {
  let component: Homepage;
  let fixture: ComponentFixture<Homepage>;
  let mockConfigService = {
    resetProjectConfig: vi.fn(),
    getProjects: vi.fn().mockResolvedValue([]),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    theme: signal('light-mode'),
    primaryColor: signal('theme-azure'),
    globalConfig: {
      value: (): {gcsBucket: string} | undefined => ({
        gcsBucket: 'bucket-a',
      }),
      isLoading: () => false,
    },
    isGeneratedScene: (scene: GeneratedScene) => scene.type === 'generated',
    isProvidedVideoScene: (scene: GeneratedScene) => scene.type === 'video',
  };
  let mockMatDialog = {
    open: vi.fn().mockReturnValue({afterClosed: () => of(true)}),
  };
  let mockMediaService: {signUrls: ReturnType<typeof vi.fn>};
  let mockThumbnailCache: {acquire: ReturnType<typeof vi.fn>};
  // Restore controlPlaneMode after tests that mutate it, so the rendered env.ts
  // value (which varies by environment) is not leaked between specs.
  const initialControlPlaneMode = env.controlPlaneMode;

  // Creates the component. The Homepage reads env.controlPlaneMode at
  // construction to choose the default filter, so tests set env first then call
  // this.
  const createComponent = () => {
    fixture = TestBed.createComponent(Homepage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  beforeEach(async () => {
    // Default to deployed (IAP) so the existing tests see a verified identity.
    env.controlPlaneMode = 'iap';
    mockConfigService = {
      resetProjectConfig: vi.fn(),
      getProjects: vi.fn().mockResolvedValue([]),
      deleteProject: vi.fn().mockResolvedValue(undefined),
      theme: signal('light-mode'),
      primaryColor: signal('theme-azure'),
      globalConfig: {
        value: (): {gcsBucket: string} | undefined => ({
          gcsBucket: 'bucket-a',
        }),
        isLoading: () => false,
      },
      isGeneratedScene: (scene: GeneratedScene) => scene.type === 'generated',
      isProvidedVideoScene: (scene: GeneratedScene) => scene.type === 'video',
    };
    mockMatDialog = {
      open: vi.fn().mockReturnValue({afterClosed: () => of(true)}),
    };
    mockMediaService = {signUrls: vi.fn().mockResolvedValue(new Map())};
    mockThumbnailCache = {
      acquire: vi
        .fn()
        .mockImplementation((_scope: unknown, file: {path?: string}) =>
          Promise.resolve({
            url: `blob:${file.path ?? 'empty'}`,
            release: vi.fn(),
          }),
        ),
    };

    await TestBed.configureTestingModule({
      imports: [Homepage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: ConfigService, useValue: mockConfigService},
        {provide: MediaService, useValue: mockMediaService},
        {provide: ThumbnailCacheService, useValue: mockThumbnailCache},
      ],
    })
      .overrideComponent(Homepage, {
        set: {providers: [{provide: MatDialog, useValue: mockMatDialog}]},
      })
      .compileComponents();

    createComponent();
  });

  afterEach(() => {
    env.controlPlaneMode = initialControlPlaneMode;
    vi.unstubAllGlobals();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('places the announcement strip above the hero', () => {
    const announcement = fixture.nativeElement.querySelector(
      'app-homepage-announcement',
    );
    const wrapper = fixture.nativeElement.querySelector('.homepage-wrapper');
    expect(announcement.nextElementSibling).toBe(wrapper);
    expect(wrapper.querySelector('.hero-section')).not.toBeNull();
  });

  it('fetches my projects only by default behind IAP (truthy createdBy flag)', () => {
    // Deployed (controlPlaneMode 'iap'): the server filters by the verified IAP
    // identity, so the client passes only a truthy "mine only" flag.
    expect(component.myProjectsOnly()).toBe(true);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(true);
  });

  it('fetches all projects by default in local dev (no verified identity)', () => {
    // Local dev (controlPlaneMode 'none'): there is no verified identity, so
    // createdBy=me would 400. Default the filter off and fetch all projects.
    env.controlPlaneMode = 'none';
    mockConfigService.getProjects.mockClear();
    createComponent();
    expect(component.myProjectsOnly()).toBe(false);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined createdBy when the my-projects filter is off', () => {
    mockConfigService.getProjects.mockClear();
    component.toggleFilter(false);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(undefined);
  });

  it('uses the selected candidate thumbnail without rendering its reference fallback', () => {
    const project = {
      id: 'project-a',
      name: 'Project',
      aspectRatio: '16:9',
      storyboard: [
        {
          id: 'scene-a',
          name: 'Scene',
          type: 'generated',
          prompt: 'prompt',
          selectedCandidateIndex: 1,
          referenceImage: {path: 'reference.jpg', url: 'reference-url'},
          candidates: [
            {
              runNumber: 1,
              durationSeconds: 4,
              model: 'model',
              prompt: 'prompt',
              generateAudio: false,
              resolution: '1080p',
              highQualityThumbnail: {path: 'candidate-a.jpg'},
            },
            {
              runNumber: 2,
              durationSeconds: 4,
              model: 'model',
              prompt: 'prompt',
              generateAudio: false,
              resolution: '1080p',
              highQualityThumbnail: {path: 'candidate-b.jpg'},
            },
          ],
        },
      ],
    } as unknown as ProjectConfig;

    const data = component.getThumbnailData(project);
    expect(data.highQualityThumbnail?.path).toBe('candidate-b.jpg');
    expect(data.showReference).toBe(false);
    (project.storyboard[0] as GeneratedScene).candidates![1].isArchived = true;
    expect(component.thumbnailPersistForProject(project)).toBe(false);
  });

  it('renders the homepage summary contract and preserves its cache policy', async () => {
    const project: ProjectSummary = {
      id: 'summary-project',
      name: 'Summary project',
      aspectRatio: '9:16',
      thumbnail: {
        highQualityThumbnail: {
          path: 'summary-thumb.jpg',
          url: 'https://example.test/summary-thumb.jpg',
        },
      },
      thumbnailPersist: false,
    };
    mockConfigService.getProjects.mockResolvedValueOnce([project]);

    component.fetchProjects();
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.project-card-link');
    expect(card.getAttribute('href')).toBe('/summary-project/storyboard');
    expect(card.querySelector('.project-title').textContent).toContain(
      'Summary project',
    );
    expect(mockThumbnailCache.acquire).toHaveBeenCalledWith(
      {bucket: 'bucket-a', projectId: 'summary-project'},
      project.thumbnail!.highQualityThumbnail,
      false,
    );
  });

  it('renders only the selected candidate thumbnail when a reference fallback exists', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const project = {
      id: 'project-a',
      name: 'Project',
      aspectRatio: '16:9',
      storyboard: [
        {
          id: 'scene-a',
          name: 'Scene',
          type: 'generated',
          prompt: 'prompt',
          selectedCandidateIndex: 0,
          referenceImage: {path: 'reference.jpg', url: 'reference-url'},
          candidates: [
            {
              runNumber: 1,
              durationSeconds: 4,
              model: 'model',
              prompt: 'prompt',
              generateAudio: false,
              resolution: '1080p',
              highQualityThumbnail: {
                path: 'candidate.jpg',
                url: 'candidate-url',
              },
            },
          ],
        },
      ],
    } as unknown as ProjectConfig;
    mockConfigService.getProjects.mockResolvedValueOnce([project]);

    component.fetchProjects();
    await Promise.resolve();
    await Promise.resolve();
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.project-thumbnail');
    expect(card.querySelectorAll('img')).toHaveLength(1);
    expect(card.querySelector('.high-res-img').src).toContain(
      'blob:candidate.jpg',
    );
    expect(mockMediaService.signUrls).not.toHaveBeenCalled();
  });

  it('waits for global config before creating cached thumbnail images', async () => {
    const loading = signal(true);
    const globalConfig = signal<{gcsBucket: string} | undefined>(undefined);
    mockConfigService.globalConfig = {
      value: () => globalConfig(),
      isLoading: () => loading(),
    };
    const project = {
      id: 'project-a',
      name: 'Project',
      aspectRatio: '16:9',
      storyboard: [
        {
          id: 'scene-a',
          name: 'Scene',
          type: 'generated',
          selectedCandidateIndex: 0,
          candidates: [{highQualityThumbnail: {path: 'candidate.jpg'}}],
        },
      ],
    } as unknown as ProjectConfig;
    mockConfigService.getProjects.mockResolvedValueOnce([project]);
    mockThumbnailCache.acquire.mockClear();

    component.fetchProjects();
    await Promise.resolve();
    await Promise.resolve();
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.project-thumbnail');
    expect(card.querySelector('.high-res-img')).toBeNull();
    expect(mockThumbnailCache.acquire).not.toHaveBeenCalled();

    globalConfig.set({gcsBucket: 'bucket-a'});
    loading.set(false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(card.querySelector('.high-res-img')).not.toBeNull();
    expect(mockThumbnailCache.acquire).toHaveBeenCalledTimes(1);
  });

  it('keeps images available with a non-persistent fallback when config fails', async () => {
    const loading = signal(true);
    mockConfigService.globalConfig = {
      value: () => undefined,
      isLoading: () => loading(),
    };
    const project = {
      id: 'project-a',
      name: 'Project',
      aspectRatio: '16:9',
      storyboard: [
        {
          id: 'scene-a',
          name: 'Scene',
          type: 'generated',
          selectedCandidateIndex: 0,
          candidates: [{highQualityThumbnail: {path: 'candidate.jpg'}}],
        },
      ],
    } as unknown as ProjectConfig;
    mockConfigService.getProjects.mockResolvedValueOnce([project]);
    mockThumbnailCache.acquire.mockClear();

    component.fetchProjects();
    await Promise.resolve();
    await Promise.resolve();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.high-res-img')).toBeNull();
    expect(mockThumbnailCache.acquire).not.toHaveBeenCalled();

    loading.set(false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.high-res-img')).not.toBeNull();
    expect(mockThumbnailCache.acquire).toHaveBeenCalledWith(
      {bucket: '', projectId: ''},
      {path: 'candidate.jpg'},
      false,
    );
  });

  it.each([
    {
      label: 'a provided video scene',
      scene: {
        id: 'scene-a',
        name: 'Scene',
        type: 'video',
        video: {path: 'scene.mp4', url: 'scene-url'},
      },
    },
    {
      label: 'a generated scene with a video-only candidate',
      scene: {
        id: 'scene-a',
        name: 'Scene',
        type: 'generated',
        selectedCandidateIndex: 0,
        candidates: [
          {
            runNumber: 1,
            durationSeconds: 4,
            model: 'model',
            prompt: 'prompt',
            generateAudio: false,
            resolution: '1080p',
            video: {path: 'candidate.mp4', url: 'candidate-url'},
          },
        ],
      },
    },
  ])(
    'renders a placeholder for $label without a hover video',
    async ({scene}) => {
      const project = {
        id: 'video-project',
        name: 'Video project',
        aspectRatio: '16:9',
        storyboard: [scene],
      } as unknown as ProjectConfig;
      mockConfigService.getProjects.mockResolvedValueOnce([project]);

      component.fetchProjects();
      await Promise.resolve();
      await Promise.resolve();
      await fixture.whenStable();
      fixture.detectChanges();

      const card = fixture.nativeElement.querySelector('.project-thumbnail');
      expect(card.querySelector('video')).toBeNull();
      expect(card.querySelector('.placeholder-thumbnail')).not.toBeNull();
      card.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
      await fixture.whenStable();
      expect(card.querySelector('video')).toBeNull();
    },
  );

  it('does not refetch the project list until the server delete resolves', async () => {
    // Let the constructor's synchronous fetch settle before measuring.
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();

    // Make deleteProject return a promise we control so we can observe the
    // ordering: the list must NOT be refetched while the delete is in flight.
    let resolveDelete!: () => void;
    const pendingDelete = new Promise<void>(resolve => {
      resolveDelete = resolve;
    });
    mockConfigService.deleteProject.mockReturnValue(pendingDelete);

    component.deleteProject('proj-1');

    // Let the afterClosed subscribe + async IIFE start and reach the await.
    await Promise.resolve();
    await Promise.resolve();

    // Delete was issued but, because it is still pending, the list must not
    // have been refetched yet (this is the race the fix closes).
    expect(mockConfigService.deleteProject).toHaveBeenCalledWith('proj-1');
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();

    // Now let the server delete complete.
    resolveDelete();
    await pendingDelete;
    // Flush the microtasks for the awaited refetch.
    await Promise.resolve();
    await Promise.resolve();

    // Only after the delete resolved should the list be re-read.
    expect(mockConfigService.getProjects).toHaveBeenCalledTimes(1);
  });

  it('does not refetch the project list when the server delete fails', async () => {
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();

    mockConfigService.deleteProject.mockRejectedValue(new Error('boom'));

    component.deleteProject('proj-1');

    // Flush the rejected delete + the catch branch.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConfigService.deleteProject).toHaveBeenCalledWith('proj-1');
    // A failed delete must leave the list untouched (no optimistic removal,
    // no refetch) so the project is not falsely shown as deleted.
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();
  });

  it('does not delete when the confirm dialog is dismissed', async () => {
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();
    mockMatDialog.open.mockReturnValue({afterClosed: () => of(false)});

    component.deleteProject('proj-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConfigService.deleteProject).not.toHaveBeenCalled();
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();
  });
});
