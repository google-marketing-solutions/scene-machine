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
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Composition} from './composition';

describe('CompositionComponent', () => {
  let component: Composition;
  let fixture: ComponentFixture<Composition>;
  let mockConfigService: unknown;
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

    await TestBed.configureTestingModule({
      imports: [Composition, MatSnackBarModule],
      providers: [
        {provide: ConfigService, useValue: mockConfigService},
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

  it('should show a video scene in the filmstrip if it has a videoUrl', () => {
    const videoScene: ProvidedVideoScene = {
      id: '2',
      type: 'video',
      name: 'Scene 2',
      video: {url: 'http://video.url/2', path: 'path/to/video/2'},
    };

    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard: [videoScene],
    });

    expect(component.filmstripScenes().length).toBe(1);
    expect(component.filmstripScenes()[0].id).toBe('2');
  });

  it('should NOT show a video scene in the filmstrip if it has NO videoUrl', () => {
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

  it('should enable the render button when combiningScenes is false', () => {
    const remixEngineService = TestBed.inject(RemixEngineService);
    remixEngineService.combiningScenes.set(false);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button.mat-primary');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Render Video');
  });
});
