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
    videoModels: () => [],
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
      videoModels: () => [],
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
});
