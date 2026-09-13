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

import {provideHttpClient, withInterceptorsFromDi} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {provideRouter} from '@angular/router';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../services/client-media/client-media';
import {ConfigService} from '../services/config/config';
import {ImageImportService} from '../services/image-import/image-import';
import {ImagePreviewService} from '../services/image-preview/image-preview';
import {MediaService} from '../services/media/media';
import {CandidateVideoCacheService} from '../services/media/candidate-video-cache';
import {ThumbnailCacheService} from '../services/media/thumbnail-cache';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Storyboard} from './storyboard';

describe('Storyboard project-load recovery (real ConfigService)', () => {
  let fixture: ComponentFixture<Storyboard>;
  let config: ConfigService;
  let http: HttpTestingController;

  afterEach(() => http.verify());

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        ConfigService,
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: ClientMediaService, useValue: {}},
        {provide: ImageImportService, useValue: {}},
        {provide: ImagePreviewService, useValue: {}},
        {
          provide: MediaService,
          useValue: {
            getCachedUrl: vi.fn().mockReturnValue(undefined),
            resolve: vi.fn().mockResolvedValue(''),
          },
        },
        {
          provide: CandidateVideoCacheService,
          useValue: {acquireCached: vi.fn().mockResolvedValue(null)},
        },
        {
          provide: ThumbnailCacheService,
          useValue: {
            acquire: vi.fn().mockResolvedValue({
              url: 'blob:thumbnail-fixture',
              release: vi.fn(),
            }),
          },
        },
        {
          provide: RemixEngineService,
          useValue: {
            generatingSceneIds: signal(new Set<string>()),
            editingSceneIds: signal(new Set<string>()),
          },
        },
        {
          provide: MatDialog,
          useValue: {open: vi.fn()},
        },
        {
          provide: MatSnackBar,
          useValue: {open: vi.fn()},
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Storyboard);
    config = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/config').flush({});
    await fixture.whenStable();
  });

  it('renders editor GET 500 recovery, then the successful retried project', async () => {
    config.loadProjectConfig('project-1', 'editor');
    fixture.detectChanges();
    http
      .expectOne('/api/projects/project-1?view=editor')
      .flush(
        {error: 'temporary outage'},
        {status: 500, statusText: 'Server Error'},
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(config.projectLoadError()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Could not load this project',
    );
    const retry = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(retry?.textContent).toContain('Retry');

    retry.click();
    fixture.detectChanges();
    const retryRequest = http.expectOne('/api/projects/project-1?view=editor');
    retryRequest.flush({
      id: 'project-1',
      name: 'Loaded project',
      storyboard: [],
      aspectRatio: '16:9',
      resolution: '720p',
      candidateDurationSeconds: 4,
      generateAudio: false,
      numberOfCandidates: 1,
      model: 'veo',
      audioTracks: [],
      visualOverlays: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(config.projectLoadError()).toBe(false);
    expect(config.projectConfig.value().id).toBe('project-1');
    expect(config.projectConfig.value().inputConfig).toBeUndefined();
    http.expectNone(
      request =>
        request.method === 'PATCH' &&
        request.url === '/api/projects/project-1/editor',
    );
    expect(fixture.nativeElement.querySelector('.loading-state')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Could not load this project',
    );
  });
});
