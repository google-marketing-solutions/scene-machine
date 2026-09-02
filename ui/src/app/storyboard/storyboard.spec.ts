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
import {HarnessLoader} from '@angular/cdk/testing';
import {TestbedHarnessEnvironment} from '@angular/cdk/testing/testbed';
import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatSelectHarness} from '@angular/material/select/testing';
import {MatSlideToggle} from '@angular/material/slide-toggle';
import {MatSlider} from '@angular/material/slider';
import {By} from '@angular/platform-browser';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
  ProvidedVideoScene,
  resolveSceneRenderClip,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {EditCandidateDialog} from './edit-candidate-dialog';
import {Storyboard} from './storyboard';

describe('Storyboard', () => {
  let component: Storyboard;
  let fixture: ComponentFixture<Storyboard>;
  let loader: HarnessLoader;
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
  const canEditCandidatesSignal = signal(false);
  const durationSliderSignal = signal({min: 4, max: 8, step: 2});
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
    canEditCandidates: canEditCandidatesSignal,
    audioLocked: () => false,
    durationSlider: durationSliderSignal,
    selectVideoModel: vi.fn(),
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
    editCandidate: vi.fn(),
    generatingSceneIds: signal(new Set()),
  };
  let mockMatDialog = {
    open: vi.fn().mockReturnValue({
      afterClosed: () => of({type: 'generate'}),
    }),
  };

  beforeEach(async () => {
    sceneIdCounterSignal.set(0);
    canEditCandidatesSignal.set(false);
    durationSliderSignal.set({min: 4, max: 8, step: 2});
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
      canEditCandidates: canEditCandidatesSignal,
      audioLocked: () => false,
      durationSlider: durationSliderSignal,
      selectVideoModel: vi.fn(),
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
      editCandidate: vi.fn(),
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
    loader = TestbedHarnessEnvironment.loader(fixture);
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

  function selectTrimScene(scene: GeneratedScene | ProvidedVideoScene) {
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [scene],
    }));
    component.selectScene(scene.id);
    component.videoDuration.set(10);
  }

  function currentProvidedTrim() {
    return (projectConfigSignal().storyboard[0] as ProvidedVideoScene).trim;
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('drives the candidate-duration slider from durationSlider()', () => {
    durationSliderSignal.set({min: 3, max: 10, step: 1});
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();

    const sliders = fixture.debugElement.queryAll(
      By.css('.setting-group mat-slider'),
    );
    const durationSlider = sliders[1].componentInstance as MatSlider;

    expect(durationSlider.min).toBe(3);
    expect(durationSlider.max).toBe(10);
    expect(durationSlider.step).toBe(1);
  });

  it('shows the audio toggle checked and disabled when the model always generates audio', async () => {
    mockConfigService.audioLocked = () => true;
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();
    // NgModel writes to its ControlValueAccessor (MatSlideToggle.checked) in
    // a microtask, so let that settle before reading it back.
    await fixture.whenStable();

    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle))
      .componentInstance as MatSlideToggle;

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
  });

  it('leaves the audio toggle enabled and following generateAudio when the model does not always generate audio', async () => {
    mockConfigService.audioLocked = () => false;
    projectConfigSignal.update(config => ({
      ...config,
      generateAudio: true,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();
    await fixture.whenStable();

    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle))
      .componentInstance as MatSlideToggle;

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it('calls selectVideoModel when a model is chosen for the selected scene', async () => {
    (mockConfigService as {videoModels: () => string[]}).videoModels = () => [
      'veo-default',
      'omni-1',
    ];
    projectConfigSignal.update(config => ({
      ...config,
      storyboard: [
        {id: '1', type: 'generated', name: 'Scene 1', prompt: 'test'},
      ],
    }));
    component.selectScene('1');
    fixture.detectChanges();

    const select = await loader.getHarness(MatSelectHarness);
    await select.open();
    await select.clickOptions({text: 'omni-1'});

    expect(mockConfigService.selectVideoModel).toHaveBeenCalledWith('omni-1');
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

  it('keeps at least one 24fps frame when trim start crosses trim end', () => {
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
    const scene: GeneratedScene = {
      id: '1',
      type: 'generated',
      name: 'Scene 1',
      prompt: 'test prompt',
      candidates: [candidate],
      selectedCandidateIndex: 0,
    };
    selectTrimScene(scene);

    component.updateTrim({start: 9});

    expect(candidate.trim).toEqual({start: 7.958, end: 8});
    const resolution = resolveSceneRenderClip(scene);
    expect(resolution.state).toBe('ready');
    if (resolution.state === 'ready') {
      expect(Math.round(resolution.clip.duration * 24)).toBe(1);
    }
  });

  it('keeps at least one 24fps frame when trim end crosses trim start', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({end: 1});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
    const trim = currentProvidedTrim()!;
    expect(Math.round((trim.end! - trim.start!) * 24)).toBe(1);
  });

  it('keeps trim endpoints strictly ordered after rounding', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({end: 2});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
  });

  it('repairs a two-endpoint trim that becomes equal after rounding', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 1, end: 8},
    };
    selectTrimScene(scene);

    component.updateTrim({start: 2, end: 2.0009});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 2.042});
  });

  describe('resolveSceneRenderClip source bounds', () => {
    function providedScene(
      durationSeconds: number | undefined,
      trim: {start?: number; end?: number},
    ): ProvidedVideoScene {
      return {
        id: 'b',
        type: 'video',
        name: 'Bounds',
        video: {url: 'http://test.mp4', path: 'videos/test.mp4'},
        durationSeconds,
        trim,
      } as ProvidedVideoScene;
    }

    it('rejects a trim starting at the source end', () => {
      // Long enough to pass the minimum-duration check, but there is no
      // source video left to read: ffmpeg yields an audio-only output.
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 5, end: 5.042})).state,
      ).toBe('invalid');
    });

    it('rejects a trim ending beyond the source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 4, end: 6})).state,
      ).toBe('invalid');
    });

    it('rejects an explicit trim with no source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(undefined, {start: 0, end: 2}))
          .state,
      ).toBe('invalid');
    });

    it('rejects a negative trim start', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: -1, end: 2})).state,
      ).toBe('invalid');
    });

    it('still accepts a trim that ends exactly at the source duration', () => {
      expect(
        resolveSceneRenderClip(providedScene(5, {start: 1, end: 5})).state,
      ).toBe('ready');
    });
  });

  it('preserves millisecond trim precision through the round trip', () => {
    // 1.001 * 1000 is 1000.9999999999999 in IEEE-754, so a naive
    // Math.floor(seconds * 1000)/1000 pre-rounding step truncates 1.001s to
    // 1.000s before the millisecond math ever runs.
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 0, end: 10},
    };
    selectTrimScene(scene);

    component.updateTrim({start: 1.001, end: 5.001});

    expect(currentProvidedTrim()).toEqual({start: 1.001, end: 5.001});
  });

  it('does not change trim before video metadata loads', () => {
    const scene: ProvidedVideoScene = {
      id: '1',
      type: 'video',
      name: 'Scene 1',
      video: {url: 'http://test.mp4', path: 'test/path'},
      durationSeconds: 10,
      trim: {start: 2, end: 8},
    };
    selectTrimScene(scene);
    component.videoDuration.set(0);
    const updateSpy = vi.spyOn(mockConfigService, 'updateProjectConfig');

    component.updateTrim({start: 3});

    expect(currentProvidedTrim()).toEqual({start: 2, end: 8});
    expect(updateSpy).not.toHaveBeenCalled();
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

  describe('Edit button', () => {
    const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
      video: {url: 'r1.mp4', path: 'path/r1.mp4'},
      runNumber: 1,
      durationSeconds: 4,
      prompt: 'test prompt',
      model: 'test-model',
      generateAudio: false,
      resolution: '1080p',
      ...overrides,
    });

    const selectSceneWithOneCandidate = () => {
      const scene: GeneratedScene = {
        id: '1',
        type: 'generated',
        name: 'Scene 1',
        prompt: 'test',
        candidates: [makeCandidate()],
      };
      projectConfigSignal.update(config => ({
        ...config,
        storyboard: [scene],
      }));
      component.selectScene('1');
      fixture.detectChanges();
    };

    it('does not render the Edit button when canEditCandidates() is false', () => {
      canEditCandidatesSignal.set(false);
      selectSceneWithOneCandidate();

      expect(
        fixture.nativeElement.querySelector('.candidate-list .edit-btn'),
      ).toBeNull();
    });

    it('renders the Edit button when canEditCandidates() is true', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithOneCandidate();

      expect(
        fixture.nativeElement.querySelector('.candidate-list .edit-btn'),
      ).not.toBeNull();
    });

    it('opens the dialog and calls editCandidate with a non-empty result, without selecting the candidate', () => {
      canEditCandidatesSignal.set(true);
      selectSceneWithOneCandidate();
      mockMatDialog.open = vi.fn().mockReturnValue({
        afterClosed: () => of('make the sky purple'),
      });

      const scene = component.config.projectConfig.value()
        .storyboard[0] as GeneratedScene;
      const btn = fixture.nativeElement.querySelector(
        '.candidate-list .edit-btn',
      );
      btn.click();
      fixture.detectChanges();

      expect(mockMatDialog.open).toHaveBeenCalledWith(EditCandidateDialog);
      expect(mockRemixEngineService.editCandidate).toHaveBeenCalledWith(
        scene,
        0,
        'make the sky purple',
      );
      // The click on the edit button must not also select the candidate
      // (stopPropagation keeps it from bubbling to the video-item's click).
      expect(
        (component.config.projectConfig.value().storyboard[0] as GeneratedScene)
          .selectedCandidateIndex,
      ).toBeUndefined();
    });

    for (const emptyResult of [undefined, '']) {
      it(`calls nothing when the dialog closes with ${JSON.stringify(emptyResult)}`, () => {
        canEditCandidatesSignal.set(true);
        selectSceneWithOneCandidate();
        mockMatDialog.open = vi.fn().mockReturnValue({
          afterClosed: () => of(emptyResult),
        });

        const btn = fixture.nativeElement.querySelector(
          '.candidate-list .edit-btn',
        );
        btn.click();
        fixture.detectChanges();

        expect(mockRemixEngineService.editCandidate).not.toHaveBeenCalled();
      });
    }
  });
});
