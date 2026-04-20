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
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Storage} from '@angular/fire/storage';
import {MatDialog} from '@angular/material/dialog';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Storyboard} from './storyboard';

describe('Storyboard', () => {
  let component: Storyboard;
  let fixture: ComponentFixture<Storyboard>;
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
    sceneIdCounter: sceneIdCounterSignal,
    isGeneratedScene: (
      scene: GeneratedScene | ProvidedVideoScene,
    ): scene is GeneratedScene => scene?.type === 'generated',
    isProvidedVideoScene: (
      scene: GeneratedScene | ProvidedVideoScene,
    ): scene is ProvidedVideoScene => scene?.type === 'video',
  };
  let mockRemixEngineService = {
    uploadMedia: vi.fn(),
    generatingSceneIds: signal(new Set()),
  };
  let mockMatDialog = {
    open: vi.fn().mockReturnValue({
      afterClosed: () => of({type: 'generate'}),
    }),
  };

  beforeEach(async () => {
    sceneIdCounterSignal.set(0);
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
      sceneIdCounter: sceneIdCounterSignal,
      isGeneratedScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is GeneratedScene => scene?.type === 'generated',
      isProvidedVideoScene: (
        scene: GeneratedScene | ProvidedVideoScene,
      ): scene is ProvidedVideoScene => scene?.type === 'video',
    };

    mockRemixEngineService = {
      uploadMedia: vi.fn(),
      generatingSceneIds: signal(new Set()),
    };

    mockMatDialog = {
      open: vi.fn().mockReturnValue({
        afterClosed: () => of({type: 'generate'}),
      }),
    };

    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        {provide: ConfigService, useValue: mockConfigService},
        {provide: Storage, useValue: {}},
        {provide: RemixEngineService, useValue: mockRemixEngineService},
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

  it('should create', () => {
    expect(component).toBeTruthy();
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

  it('should display reference image in filmstrip when available', () => {
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test',
      candidates: [
        {
          referenceImage: {
            url: 'http://example.com/ref-image.jpg',
            path: 'path/to/image',
          },
          runNumber: 1,
          durationSeconds: 10,
          trim: {start: 2, end: 8},
          prompt: 'test prompt',
          model: 'test-model',
          generateAudio: false,
          resolution: '1080p',
        },
      ],
      selectedCandidateIndex: 0,
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
    fixture.detectChanges();

    const filmstripItem =
      fixture.nativeElement.querySelector('.filmstrip-item');
    const img = filmstripItem.querySelector('img.reference-image-bg');
    expect(img).toBeTruthy();
    expect(img.src).toBe('http://example.com/ref-image.jpg');

    // Default icon should not be present (except potentially loading spinner if generating, which is false here)
    const defaultIcon = filmstripItem.querySelector('.scene-icon mat-icon');
    expect(defaultIcon).toBeNull();
  });
});
