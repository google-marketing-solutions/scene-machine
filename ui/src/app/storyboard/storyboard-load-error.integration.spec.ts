import {
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {provideRouter} from '@angular/router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
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
          useValue: {acquire: vi.fn().mockResolvedValue(null)},
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

  it('renders GET 500 recovery, then the successful retried project', async () => {
    config.loadProjectConfig('project-1');
    fixture.detectChanges();
    http
      .expectOne('/api/projects/project-1')
      .flush({error: 'temporary outage'}, {status: 500, statusText: 'Server Error'});
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
    const retryRequest = http.expectOne('/api/projects/project-1');
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
      inputConfig: {products: [], composition: ''},
      audioTracks: [],
      visualOverlays: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(config.projectLoadError()).toBe(false);
    expect(config.projectConfig.value().id).toBe('project-1');
    expect(fixture.nativeElement.querySelector('.loading-state')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Could not load this project',
    );
  });
});
