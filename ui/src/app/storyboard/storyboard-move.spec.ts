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
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {provideRouter} from '@angular/router';
import {Subject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
} from '../services/config/config';
import {ClientMediaService} from '../services/client-media/client-media';
import {ImageImportService} from '../services/image-import/image-import';
import {MediaService} from '../services/media/media';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Storyboard} from './storyboard';

describe('Storyboard move persistence', () => {
  let component: Storyboard;
  let fixture: ComponentFixture<Storyboard>;
  let config: ConfigService;
  let http: HttpTestingController;
  let retryAction: Subject<void>;
  let snackBar: {open: ReturnType<typeof vi.fn>};

  const sourceCandidate: Candidate = {
    runNumber: 1,
    durationSeconds: 4,
    model: 'veo',
    prompt: 'candidate prompt',
    generateAudio: true,
    resolution: '1080p',
    video: {path: 'video-1', url: 'url-1'},
  };

  const initialProject: ProjectConfig = {
    id: 'project-1',
    name: 'Project',
    storyboard: [
      {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'keep prompt',
        candidates: [sourceCandidate],
        selectedCandidateIndex: 0,
      },
    ],
    aspectRatio: '16:9',
    resolution: '1080p',
    candidateDurationSeconds: 4,
    generateAudio: true,
    numberOfCandidates: 1,
    model: 'veo',
    inputConfig: {products: [], composition: ''},
    audioTracks: [],
    visualOverlays: [],
  };

  async function settleResource() {
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function flushGlobalConfig() {
    http.expectOne('/api/config').flush({
      duration: 4,
      veoModel: 'veo',
      numberOfCandidates: 1,
      generateAudio: true,
      resolution: '1080p',
      aspectRatio: '16:9',
    });
  }

  async function loadProject(project: ProjectConfig) {
    config.loadProjectConfig(project.id);
    fixture.detectChanges();
    await Promise.resolve();
    http.expectOne(`/api/projects/${project.id}`).flush(project);
    await vi.waitFor(() =>
      expect(config.projectConfig.value().id).toBe(project.id),
    );
    await settleResource();
  }

  beforeEach(async () => {
    retryAction = new Subject<void>();
    snackBar = {
      open: vi.fn().mockReturnValue({onAction: () => retryAction}),
    };

    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        ConfigService,
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: MatDialog, useValue: {open: vi.fn()}},
        {provide: MatSnackBar, useValue: snackBar},
        {
          provide: RemixEngineService,
          useValue: {
            generatingSceneIds: signal(new Set<string>()),
            editingSceneIds: signal(new Set<string>()),
            setForegroundScene: vi.fn(),
            clearForegroundScene: vi.fn(),
          },
        },
        {provide: ClientMediaService, useValue: {}},
        {provide: ImageImportService, useValue: {}},
        {provide: MediaService, useValue: {}},
      ],
    })
      .overrideComponent(Storyboard, {set: {template: '<div></div>'}})
      .compileComponents();

    config = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);

    fixture = TestBed.createComponent(Storyboard);
    component = fixture.componentInstance;
    fixture.detectChanges();
    flushGlobalConfig();
    await settleResource();
  });

  afterEach(() => {
    http.verify();
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('moves through Storyboard, retries the failed save, and reloads one placement', async () => {
    await loadProject(initialProject);

    const source = config.projectConfig.value().storyboard[0] as GeneratedScene;
    component.prepareMoveCandidate(source, 0);
    component.movePreparedCandidate(new Event('click'), {
      kind: 'new-after-source',
      id: '2',
    });
    await settleResource();

    const moved = config.projectConfig.value().storyboard;
    expect(moved).toHaveLength(2);
    expect((moved[0] as GeneratedScene).candidates).toBeUndefined();
    expect((moved[0] as GeneratedScene).prompt).toBe('keep prompt');
    expect((moved[1] as GeneratedScene).candidates).toHaveLength(1);
    expect(component.selectedSceneId()).toBe('2');
    expect(component.selectedScene()?.id).toBe('2');

    const firstPatch = http.expectOne('/api/projects/project-1');
    const persistedPayload = firstPatch.request.body as ProjectConfig;
    expect(persistedPayload.storyboard).toHaveLength(2);
    expect(persistedPayload.storyboard[0]).not.toHaveProperty('candidates');
    expect(
      (persistedPayload.storyboard[1] as GeneratedScene).candidates,
    ).toHaveLength(1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    firstPatch.flush('failed', {status: 500, statusText: 'failed'});
    expect(snackBar.open).toHaveBeenCalledWith(
      'Unsaved changes — failed to save the project.',
      'Retry',
      {panelClass: ['error-snackbar']},
    );

    retryAction.next();
    const retryPatch = http.expectOne('/api/projects/project-1');
    const retryPayload = retryPatch.request.body as ProjectConfig;
    expect(retryPayload.storyboard).toEqual(persistedPayload.storyboard);
    retryPatch.flush({});
    errorSpy.mockRestore();

    const otherProject: ProjectConfig = {
      ...retryPayload,
      id: 'other-project',
      name: 'Other project',
      storyboard: [],
    };
    await loadProject(otherProject);

    await loadProject(retryPayload);
    const reloaded = config.projectConfig.value().storyboard;
    expect(reloaded).toHaveLength(2);
    expect((reloaded[0] as GeneratedScene).candidates).toBeUndefined();
    expect((reloaded[0] as GeneratedScene).prompt).toBe('keep prompt');
    expect((reloaded[1] as GeneratedScene).candidates).toHaveLength(1);
    expect((reloaded[1] as GeneratedScene).selectedCandidateIndex).toBe(0);
    expect((reloaded[1] as GeneratedScene).candidates?.[0].video?.path).toBe(
      'video-1',
    );
  });
});
