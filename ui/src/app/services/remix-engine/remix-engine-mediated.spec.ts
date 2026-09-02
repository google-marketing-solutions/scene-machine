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

/* eslint-disable @typescript-eslint/no-explicit-any */
import {HttpClient} from '@angular/common/http';
import {signal, type WritableSignal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {from, of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../client-media/client-media';
import {ConfigService} from '../config/config';
import {MediaService} from '../media/media';
import {RemixEngineService} from './remix-engine';

describe('RemixEngineService (mediated)', () => {
  let service: RemixEngineService;
  let httpClientMock: any;
  let configServiceMock: any;
  let clientMediaServiceMock: any;
  let matSnackBarMock: any;
  let mediaServiceMock: any;
  // The fake ConfigService exposes projectConfig/globalConfig as REAL signals so
  // the service's resume effect tracks them and re-runs when a test writes a new
  // value (a vi.fn() getter would not retrigger a real effect).
  let projectConfigSignal: WritableSignal<any>;
  let globalConfigSignal: WritableSignal<any>;

  const generationParams = {
    durationSeconds: 5,
    model: 'model-1',
    generateAudio: false,
    resolution: '720p' as const,
  };

  /**
   * Re-runs the resume effect deterministically. Writing a fresh project
   * reference makes the effect's projectConfig dependency look changed; the
   * TestBed.tick() flush then runs the effect, exactly as Angular would on a
   * real projectConfig change.
   */
  function runResumeScan() {
    projectConfigSignal.set({...projectConfigSignal()});
    TestBed.tick();
  }

  /** Lets the pending microtask chain settle (one macrotask). */
  function settle() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function setupHappyMedia() {
    mediaServiceMock.signUrl.mockImplementation((path: string) =>
      Promise.resolve(`https://signed.example/${path}`),
    );
    clientMediaServiceMock.generateLowQualityThumbnail.mockResolvedValue(
      new Blob(),
    );
    clientMediaServiceMock.toBase64.mockResolvedValue('mock-base64');
    clientMediaServiceMock.generateHighQualityThumbnail.mockResolvedValue(
      new Blob(),
    );
    clientMediaServiceMock.toFile.mockResolvedValue(new File([], 'mock-file'));
    vi.spyOn(service, 'uploadThumbnail').mockResolvedValue({
      path: 'mock-thumb-path',
      url: 'mock-thumb-url',
    });
  }

  function lastUpdatedScene() {
    const calls = configServiceMock.updateProjectConfig.mock.calls;
    return calls[calls.length - 1][0].storyboard[0];
  }

  function setRenderStoryboard(storyboard: any[]) {
    projectConfigSignal.set({
      ...projectConfigSignal(),
      storyboard,
      audioTracks: [],
      visualOverlays: [],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Do NOT replace the global `window` here. jsdom already provides
    // window.location.origin (only used in debug log strings, never asserted),
    // and clobbering window with a bare stub strips navigator / matchMedia /
    // addEventListener. Under the official builder's parallel file runner that
    // leak corrupts the DOM environment for component specs sharing a worker.

    httpClientMock = {
      post: vi.fn(),
      get: vi.fn(),
    };

    globalConfigSignal = signal<any>({
      gcpProject: 'mock-project',
      gcpLocation: 'mock-location',
      gcsBucket: 'mock-bucket',
      tasksQueuePrefix: 'mock-queue',
      veoLocation: 'mock-veo-loc',
      duration: 5,
      veoModel: 'mock-veo',
      numberOfCandidates: 2,
      generateAudio: true,
    });
    projectConfigSignal = signal<any>({
      id: 'project-1',
      resolution: '720p',
      aspectRatio: '16:9',
      numberOfCandidates: 2,
      candidateDurationSeconds: 5,
      generateAudio: true,
      model: 'mock-veo',
      storyboard: [],
    });

    configServiceMock = {
      globalConfig: {value: globalConfigSignal},
      projectConfig: {value: projectConfigSignal},
      isGeneratedScene: vi.fn((scene: any) => scene?.type === 'generated'),
      isProvidedVideoScene: vi.fn((scene: any) => scene?.type === 'video'),
      updateProjectConfig: vi.fn(),
      addRenderRun: vi.fn(),
      setPendingRender: vi.fn(),
      flushPendingSave: vi.fn(),
      videoEditModels: vi.fn().mockReturnValue([]),
      canEditCandidates: vi.fn().mockReturnValue(false),
      audioLocked: vi.fn().mockReturnValue(false),
      resolveVideoLocation: vi.fn().mockReturnValue('mock-veo-loc'),
    };

    clientMediaServiceMock = {
      generateLowQualityThumbnail: vi.fn(),
      generateHighQualityThumbnail: vi.fn(),
      toBase64: vi.fn(),
      toFile: vi.fn(),
    };

    matSnackBarMock = {
      open: vi.fn(),
    };

    mediaServiceMock = {
      signUrl: vi.fn(),
      signUrls: vi.fn().mockResolvedValue(new Map()),
      upload: vi.fn(),
      getBlob: vi.fn(),
      resolve: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        RemixEngineService,
        {provide: ConfigService, useValue: configServiceMock},
        {provide: HttpClient, useValue: httpClientMock},
        {provide: ClientMediaService, useValue: clientMediaServiceMock},
        {provide: MediaService, useValue: mediaServiceMock},
        {provide: MatSnackBar, useValue: matSnackBarMock},
      ],
    });
    service = TestBed.inject(RemixEngineService);
    // Run the resume effect once at construction. The default project has no
    // pending work, so this primes the effect as a harmless no-op.
    TestBed.tick();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore any console.error spies installed by the failure-path tests so
    // a real error in a later test is not silently swallowed.
    vi.restoreAllMocks();
  });

  describe('generateCandidates: immediate persistence', () => {
    function mockSceneAndProject() {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [],
      };
      const mockProject = {
        id: 'project-1',
        numberOfCandidates: 2,
        storyboard: [mockScene],
      };
      projectConfigSignal.set(mockProject);
      return mockScene;
    }

    it('should persist pendingGeneration and flush while the poll is still in flight', async () => {
      const mockScene = mockSceneAndProject();
      setupHappyMedia();
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      let resolvePoll!: (value: any) => void;
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(
        new Promise(resolve => (resolvePoll = resolve)),
      );

      const generatePromise = service.generateCandidates(
        mockScene as any,
        generationParams,
      );
      await settle();

      // The poll has NOT completed, yet the in-flight marker is already
      // persisted (immediately, not debounced).
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);
      const persistedScene =
        configServiceMock.updateProjectConfig.mock.calls[0][0].storyboard[0];
      expect(persistedScene.pendingGeneration).toEqual({
        executionId: 'mock-execution-id',
        requestedCount: 2,
        startedAt: expect.any(String),
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
        prompt: 'prompt 1',
      });
      // startedAt is a round-trippable ISO string, NOT a Date (the backend
      // only converts lastEdited/renderRuns dates).
      const startedAt = persistedScene.pendingGeneration.startedAt;
      expect(new Date(startedAt).toISOString()).toBe(startedAt);
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(1);

      resolvePoll({sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}}});
      await generatePromise;
    });

    it('should clear pendingGeneration in the same update that attaches candidates, then flush', async () => {
      const mockScene = mockSceneAndProject();
      setupHappyMedia();
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);

      await service.generateCandidates(mockScene as any, generationParams);

      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          runNumber: 1,
          video: {url: 'https://signed.example/p/v1.mp4', path: 'p/v1.mp4'},
          prompt: 'prompt 1',
          model: 'model-1',
        }),
      ]);
      // One flush for the start persist, one for the completion.
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(2);
    });

    it('should clear pendingGeneration on a definitive workflow error', async () => {
      const mockScene = mockSceneAndProject();
      // The error is logged by design; spy so the failure-path log does not
      // pollute the test output, then assert it was emitted.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{_error: 'Mock workflow error'}]}}},
      } as any);

      await service.generateCandidates(mockScene as any, generationParams);

      expect(errSpy).toHaveBeenCalledWith(
        'Video generation error:',
        expect.objectContaining({executionId: 'mock-execution-id'}),
      );
      // First update persisted the marker, second one cleared it.
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(2);
      expect(lastUpdatedScene()).not.toHaveProperty('pendingGeneration');
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(2);
      expect(lastUpdatedScene()).toHaveProperty(
        'generationError',
        'Mock workflow error',
      );
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining(
          'failed to generate — open the marked scene to see why.',
        ),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should skip a file-less workflow output instead of signing "undefined"', async () => {
      // A workflow can return an output entry with no `file` (neither a real
      // video nor an `_error`). It must not become a signed-but-broken
      // candidate, nor be reported as a load failure: the scene succeeded.
      const mockScene = mockSceneAndProject();
      setupHappyMedia();
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {
          output: {
            '0': {
              video: [
                {file: 'p/v1.mp4'},
                {
                  /* no file */
                },
              ],
            },
          },
        },
      } as any);

      await service.generateCandidates(mockScene as any, generationParams);

      // The file-less item is never signed (no "undefined" path).
      expect(mediaServiceMock.signUrl).toHaveBeenCalledTimes(1);
      expect(mediaServiceMock.signUrl).toHaveBeenCalledWith('p/v1.mp4');
      expect(mediaServiceMock.signUrl).not.toHaveBeenCalledWith('undefined');

      // Only the real video becomes a candidate; the run is not a failure.
      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(finalScene).not.toHaveProperty('generationError');
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          runNumber: 1,
          video: {url: 'https://signed.example/p/v1.mp4', path: 'p/v1.mp4'},
        }),
      ]);
      expect(matSnackBarMock.open).not.toHaveBeenCalled();
    });

    it('should clear pendingGeneration when the run completes with zero new candidates', async () => {
      const mockScene = mockSceneAndProject();
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);
      // The completion path yields nothing attachable (zero usable outputs).
      vi.spyOn(service as any, 'collectCandidates').mockResolvedValue([]);

      await service.generateCandidates(mockScene as any, generationParams);

      // First update persisted the marker, the second cleared it: the
      // document must not carry the marker into the next session.
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(2);
      expect(lastUpdatedScene()).not.toHaveProperty('pendingGeneration');
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(2);
      // Not a failure: no error snackbar.
      expect(matSnackBarMock.open).not.toHaveBeenCalled();
    });
  });

  describe('generateCandidates: completion-path resilience', () => {
    function mockTwoVideoRun() {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [],
      };
      projectConfigSignal.set({
        id: 'project-1',
        numberOfCandidates: 2,
        storyboard: [mockScene],
      });
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {
          output: {'0': {video: [{file: 'p/v1.mp4'}, {file: 'p/v2.mp4'}]}},
        },
      } as any);
      return mockScene;
    }

    it('should attach the surviving candidates when one signUrl fails persistently', async () => {
      const mockScene = mockTwoVideoRun();
      setupHappyMedia();
      // The per-candidate failure is logged by design; spy to keep it out of
      // the test output, then assert it was emitted for the failing path.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mediaServiceMock.signUrl.mockImplementation((path: string) =>
        path === 'p/v2.mp4'
          ? Promise.reject(new Error('sign failed'))
          : Promise.resolve(`https://signed.example/${path}`),
      );

      vi.useFakeTimers();
      const generatePromise = service.generateCandidates(
        mockScene as any,
        generationParams,
      );
      // pollWorkflow is spied, so the only timers are the finite signUrl retry
      // backoffs; drain them to completion.
      await vi.runAllTimersAsync();
      await generatePromise;

      expect(errSpy).toHaveBeenCalledWith(
        'Failed to load a generated video:',
        expect.objectContaining({message: 'sign failed'}),
      );
      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          video: {url: 'https://signed.example/p/v1.mp4', path: 'p/v1.mp4'},
        }),
      ]);
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        '1 of 2 generated videos could not be loaded',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      // Not the all-or-nothing failure path.
      expect(matSnackBarMock.open).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to generate video(s).'),
        'Dismiss',
        expect.anything(),
      );
      // Bounded retry: 3 attempts for the failing path, 1 for the good one.
      const v2Calls = mediaServiceMock.signUrl.mock.calls.filter(
        (c: string[]) => c[0] === 'p/v2.mp4',
      );
      expect(v2Calls.length).toBe(3);
    });

    it('should retry a transient signUrl failure and attach all candidates', async () => {
      const mockScene = mockTwoVideoRun();
      setupHappyMedia();
      let v2Attempts = 0;
      mediaServiceMock.signUrl.mockImplementation((path: string) => {
        if (path === 'p/v2.mp4' && ++v2Attempts === 1) {
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve(`https://signed.example/${path}`);
      });

      vi.useFakeTimers();
      const generatePromise = service.generateCandidates(
        mockScene as any,
        generationParams,
      );
      await vi.runAllTimersAsync();
      await generatePromise;

      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toHaveLength(2);
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          video: {url: 'https://signed.example/p/v1.mp4', path: 'p/v1.mp4'},
        }),
        expect.objectContaining({
          video: {url: 'https://signed.example/p/v2.mp4', path: 'p/v2.mp4'},
        }),
      ]);
      expect(v2Attempts).toBe(2);
      // No warning, no error: everything was recovered.
      expect(matSnackBarMock.open).not.toHaveBeenCalled();
    });

    it('keeps the in-flight marker (does not fail the scene) when signing every completed video fails', async () => {
      const mockScene = mockTwoVideoRun();
      setupHappyMedia();
      // The per-candidate signing failures are logged by design; spy to keep
      // them out of the test output.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mediaServiceMock.signUrl.mockRejectedValue(new Error('sign failed'));

      vi.useFakeTimers();
      const generatePromise = service.generateCandidates(
        mockScene as any,
        generationParams,
      );
      await vi.runAllTimersAsync();
      await generatePromise;

      // The run COMPLETED (it produced video outputs) but signing them all
      // failed transiently. (E3) That is not a generation failure: the marker
      // is KEPT so reopening re-collects the finished videos, the scene is NOT
      // stamped with a generationError, and the user is told to reopen.
      expect(errSpy).toHaveBeenCalledWith(
        'Failed to load a generated video:',
        expect.objectContaining({message: 'sign failed'}),
      );
      // The definitive-failure path (which would clear the marker and stamp the
      // scene) is NOT taken.
      expect(errSpy).not.toHaveBeenCalledWith(
        'Video generation error:',
        expect.anything(),
      );
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining('could not be loaded right now'),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(matSnackBarMock.open).not.toHaveBeenCalledWith(
        expect.stringContaining('failed to generate'),
        expect.anything(),
        expect.anything(),
      );
      // Only the start marker was persisted; the signing-failure path did not
      // write again, so pendingGeneration survives and no generationError set.
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);
      const finalScene = lastUpdatedScene();
      expect(finalScene).toHaveProperty('pendingGeneration');
      expect(finalScene).not.toHaveProperty('generationError');
    });

    it('does not attach candidates to the wrong project when the user navigates while signing (E5)', async () => {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [],
      };
      projectConfigSignal.set({
        id: 'project-1',
        numberOfCandidates: 2,
        storyboard: [mockScene],
      });
      setupHappyMedia();
      // Hold signing open so the user can navigate AFTER the poll completes but
      // BEFORE the candidates are attached — the exact reported race.
      let resolveSign!: (url: string) => void;
      mediaServiceMock.signUrl.mockReturnValue(
        new Promise<string>(resolve => (resolveSign = resolve)),
      );
      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);

      const generatePromise = service.generateCandidates(
        mockScene as any,
        generationParams,
      );
      await settle(); // reach the signing await
      // Only the start marker has been persisted so far.
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);

      // User leaves project-1 for another project before signing finishes.
      projectConfigSignal.set({id: 'project-B', storyboard: []});
      resolveSign('https://signed.example/p/v1.mp4');
      await generatePromise;

      // The finished candidates were NOT attached to the now-loaded project-B
      // (no second update), so project-1's pendingGeneration marker survives for
      // its reopen to re-collect. Nothing landed in the wrong project.
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);
      expect(lastUpdatedScene()).toHaveProperty('pendingGeneration');
    });
  });

  describe('editCandidate', () => {
    const editCatalog = {
      defaults: {omni: 'omni-1'},
      actions: {
        edit_video: {location_param: 'gcp_location', default_key: 'veoModel'},
      },
      models: {
        'omni-1': {
          family: 'omni',
          actions: ['generate_video', 'edit_video'],
          locations: ['mock-veo-loc'],
          capabilities: {audio_always_on: true},
        },
      },
    };

    function mockSceneWithCandidate(candidateOverrides: any = {}) {
      const sourceCandidate = {
        runNumber: 1,
        durationSeconds: 5,
        model: 'mock-veo',
        prompt: 'prompt 1',
        generateAudio: false,
        resolution: '720p',
        video: {
          url: 'https://signed.example/p/source.mp4',
          path: 'p/source.mp4',
        },
        ...candidateOverrides,
      };
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [sourceCandidate],
      };
      const mockProject = {
        id: 'project-1',
        numberOfCandidates: 2,
        storyboard: [mockScene],
      };
      projectConfigSignal.set(mockProject);
      return {mockScene, sourceCandidate};
    }

    /** Configures configServiceMock as if one Omni-like model can edit. */
    function enableEditing() {
      configServiceMock.videoEditModels.mockReturnValue(['omni-1']);
      configServiceMock.canEditCandidates.mockReturnValue(true);
      globalConfigSignal.set({
        ...globalConfigSignal(),
        modelCatalog: editCatalog,
      });
    }

    it('posts the edit_video workflow body built from the source candidate', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'remix-input/edit-prompt-abc123.txt',
      );
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      expect(httpClientMock.post).toHaveBeenCalledWith('/api/supplyNode', {
        workflowDefinition: {
          root: {
            action: 'pass',
            input: {video: null, prompt: null},
            types: {video: 'video', prompt: 'string'},
          },
          n_0: {
            action: 'edit_video',
            input: {
              video: {node: 'root', output: 'video'},
              prompt: {node: 'root', output: 'prompt'},
            },
            parameters: {
              model: 'omni-1',
              gcp_location: 'mock-veo-loc',
              resolution: '720p',
            },
          },
          sink: {
            action: 'pass',
            input: {video: {node: 'n_0', output: 'edited_video'}},
          },
        },
        nodeId: 'root',
        workflowId: expect.any(String),
        forceExecution: false,
        workflowParams: {
          gcpProject: 'mock-project',
          gcpLocation: 'mock-location',
          gcsBucket: 'mock-bucket',
          tasksQueuePrefix: 'mock-queue',
        },
        inputFiles: {
          video: [{file: 'p/source.mp4'}],
          prompt: [{file: 'remix-input/edit-prompt-abc123.txt'}],
        },
      });
    });

    it('posts the global fallback location when the edit model does not list the configured Veo location', async () => {
      const {mockScene} = mockSceneWithCandidate();
      const globalOnlyEditCatalog = {
        ...editCatalog,
        models: {
          ...editCatalog.models,
          'omni-1': {...editCatalog.models['omni-1'], locations: ['global']},
        },
      };
      configServiceMock.videoEditModels.mockReturnValue(['omni-1']);
      configServiceMock.canEditCandidates.mockReturnValue(true);
      globalConfigSignal.set({
        ...globalConfigSignal(),
        modelCatalog: globalOnlyEditCatalog,
      });
      configServiceMock.resolveVideoLocation.mockReturnValue('global');
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'remix-input/edit-prompt-abc123.txt',
      );
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/supplyNode',
        expect.objectContaining({
          workflowDefinition: expect.objectContaining({
            n_0: expect.objectContaining({
              parameters: expect.objectContaining({gcp_location: 'global'}),
            }),
          }),
        }),
      );
      expect(configServiceMock.resolveVideoLocation).toHaveBeenCalledWith(
        'omni-1',
      );
    });

    it.each([['1080p'], ['4k']] as const)(
      'posts the source candidate resolution (%s) in n_0.parameters and on the attached candidate',
      async resolution => {
        const {mockScene} = mockSceneWithCandidate({resolution});
        enableEditing();
        setupHappyMedia();
        vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
        httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
        vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
          sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
        } as any);

        await service.editCandidate(mockScene as any, 0, 'make the sky purple');

        const [, body] = httpClientMock.post.mock.calls[0];
        expect((body as any).workflowDefinition.n_0.parameters.resolution).toBe(
          resolution,
        );
        const finalScene = lastUpdatedScene();
        expect(finalScene.candidates[1]).toEqual(
          expect.objectContaining({resolution}),
        );
      },
    );

    it('posts no resolution when the source candidate has none', async () => {
      const {mockScene, sourceCandidate} = mockSceneWithCandidate();
      delete sourceCandidate.resolution;
      enableEditing();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      const [, body] = httpClientMock.post.mock.calls[0];
      const parameters = (body as any).workflowDefinition.n_0.parameters;
      expect(parameters.resolution).toBeUndefined();
      // The key is dropped once serialised to JSON, so an older backend
      // (or a candidate with no resolution) never sees the field at all.
      expect(JSON.parse(JSON.stringify(parameters))).not.toHaveProperty(
        'resolution',
      );
    });

    it('keeps the trim the edit was started with when the storyboard mutates the live candidate mid-run', async () => {
      // storyboard.ts mutates candidate.trim in place while an edit is
      // running; the attached edited candidate must carry the trim from the
      // moment the run was submitted, not whatever trim the storyboard has
      // moved on to by completion.
      const {mockScene, sourceCandidate} = mockSceneWithCandidate({
        trim: {start: 1, end: 4},
      });
      enableEditing();
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      let resolvePoll!: (value: any) => void;
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(
        new Promise(resolve => (resolvePoll = resolve)),
      );

      const editPromise = service.editCandidate(
        mockScene as any,
        0,
        'make the sky purple',
      );
      await settle(); // reach the poll await; the source has been captured

      // The storyboard mutates the live candidate's trim while the edit runs.
      sourceCandidate.trim.end = 9;

      resolvePoll({
        sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
      });
      await editPromise;

      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates[1]).toEqual(
        expect.objectContaining({trim: {start: 1, end: 4}}),
      );
    });

    it('chooses the edit model from the catalog default, never the project model', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      // The project's own model is a Veo id, not the Omni edit model.
      projectConfigSignal.set({...projectConfigSignal(), model: 'mock-veo'});
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/supplyNode',
        expect.objectContaining({
          workflowDefinition: expect.objectContaining({
            n_0: expect.objectContaining({
              parameters: {
                model: 'omni-1',
                gcp_location: 'mock-veo-loc',
                resolution: '720p',
              },
            }),
          }),
        }),
      );
    });

    it('falls back to videoEditModels()[0] when the catalog has no omni default', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      // No 'omni' key in defaults at all — production models.json today has
      // no such default, so selectEditModel must take the editModels[0]
      // fallback branch, not throw or post an undefined model.
      globalConfigSignal.set({
        ...globalConfigSignal(),
        modelCatalog: {...editCatalog, defaults: {}},
      });
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      const [, body] = httpClientMock.post.mock.calls[0];
      expect((body as any).workflowDefinition.n_0.parameters).toEqual({
        model: 'omni-1',
        gcp_location: 'mock-veo-loc',
        resolution: '720p',
      });
    });

    it('falls back to the sorted first edit model when there is no catalog default at all', async () => {
      const {mockScene} = mockSceneWithCandidate();
      configServiceMock.videoEditModels.mockReturnValue(['a-model', 'omni-1']);
      configServiceMock.canEditCandidates.mockReturnValue(true);
      globalConfigSignal.set({
        ...globalConfigSignal(),
        modelCatalog: {...editCatalog, defaults: {}},
      });
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      const [, body] = httpClientMock.post.mock.calls[0];
      expect((body as any).workflowDefinition.n_0.parameters).toEqual({
        model: 'a-model',
        gcp_location: 'mock-veo-loc',
        resolution: '720p',
      });
    });

    it('refuses without posting when no model can edit at this location', async () => {
      const {mockScene} = mockSceneWithCandidate();
      // canEditCandidates()/videoEditModels() default to false/[] in this
      // file's beforeEach — no enableEditing() call.

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');

      expect(httpClientMock.post).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'No model can edit video at this location.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('produces byte-identical bodies for two identical edits except workflowId', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
      } as any);

      // First edit runs to completion (clearing the generating flag) before
      // the second starts, so both are free to run and post independently.
      await service.editCandidate(mockScene as any, 0, 'make the sky purple');
      const [firstBody] = httpClientMock.post.mock.calls[0].slice(1);

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');
      const [secondBody] = httpClientMock.post.mock.calls[1].slice(1);

      const stripId = (body: any) => {
        const clone = {...body};
        delete clone.workflowId;
        return JSON.stringify(clone);
      };
      expect(stripId(firstBody)).toBe(stripId(secondBody));
      expect(firstBody.workflowId).not.toBe(secondBody.workflowId);
    });

    it('marks the scene generating and persists a PendingGeneration immediately', async () => {
      const {mockScene, sourceCandidate} = mockSceneWithCandidate({
        trim: {start: 1, end: 4},
        referenceImage: {
          path: 'ref/p.png',
          url: 'https://signed.example/ref/p.png',
        },
      });
      enableEditing();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockReturnValue(new Promise(() => {}));

      void service.editCandidate(mockScene as any, 0, 'make the sky purple');
      await settle();

      expect(service.generatingSceneIds().has('scene-1')).toBe(true);
      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);
      const persistedScene = lastUpdatedScene();
      expect(persistedScene.pendingGeneration).toEqual({
        executionId: 'edit-exec-id',
        requestedCount: 1,
        startedAt: expect.any(String),
        durationSeconds: sourceCandidate.durationSeconds,
        trim: {start: 1, end: 4},
        model: 'omni-1',
        generateAudio: true,
        resolution: sourceCandidate.resolution,
        prompt: sourceCandidate.prompt,
        editPrompt: 'make the sky purple',
        editedFromRun: sourceCandidate.runNumber,
        referenceImage: sourceCandidate.referenceImage,
      });
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(1);
    });

    it('attaches an edited candidate carrying the source fields and the edit metadata', async () => {
      const {mockScene, sourceCandidate} = mockSceneWithCandidate({
        trim: {start: 1, end: 4},
        referenceImage: {
          path: 'ref/p.png',
          url: 'https://signed.example/ref/p.png',
        },
      });
      enableEditing();
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
      } as any);

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');

      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(finalScene.candidates).toEqual([
        sourceCandidate,
        expect.objectContaining({
          runNumber: sourceCandidate.runNumber + 1,
          durationSeconds: sourceCandidate.durationSeconds,
          resolution: sourceCandidate.resolution,
          prompt: sourceCandidate.prompt,
          model: 'omni-1',
          generateAudio: true,
          editPrompt: 'make the sky purple',
          editedFromRun: sourceCandidate.runNumber,
          trim: {start: 1, end: 4},
          referenceImage: sourceCandidate.referenceImage,
          video: {
            url: 'https://signed.example/p/edited.mp4',
            path: 'p/edited.mp4',
          },
        }),
      ]);
    });

    it('does not attach a duplicate when the edit is a cache hit, and tells the user', async () => {
      const {mockScene} = mockSceneWithCandidate();
      // The scene already has a candidate at the path the worker will return
      // (an identical prior edit already landed).
      mockScene.candidates.push({
        runNumber: 2,
        durationSeconds: 5,
        model: 'omni-1',
        prompt: 'prompt 1',
        generateAudio: true,
        resolution: '720p',
        video: {
          url: 'https://signed.example/p/edited.mp4',
          path: 'p/edited.mp4',
        },
        editPrompt: 'make the sky purple',
        editedFromRun: 1,
      } as any);
      enableEditing();
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
      } as any);

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');

      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toHaveLength(2);
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      // Informational, not an error — no error-snackbar panel class.
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'This edit already exists as a candidate',
        'Dismiss',
      );
    });

    it('sets the scene generation error the way generateCandidates does on a definitive failure', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{_error: 'Mock edit error'}]}}},
      } as any);

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');

      expect(errSpy).toHaveBeenCalled();
      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(finalScene).toHaveProperty('generationError', 'Mock edit error');
      expect(service.generatingSceneIds().has('scene-1')).toBe(false);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining(
          'failed to generate — open the marked scene to see why.',
        ),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('sets the scene generation error when the poll itself rejects', async () => {
      const {mockScene} = mockSceneWithCandidate();
      enableEditing();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
      httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
      vi.spyOn(service, 'pollWorkflow').mockRejectedValue(
        new Error('poll failed'),
      );

      await service.editCandidate(mockScene as any, 0, 'make the sky purple');

      expect(errSpy).toHaveBeenCalled();
      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      expect(finalScene).toHaveProperty('generationError', 'poll failed');
      expect(service.generatingSceneIds().has('scene-1')).toBe(false);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining(
          'failed to generate — open the marked scene to see why.',
        ),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    describe('project guards (never write into the wrong project)', () => {
      it('does not post the workflow when the project changes while the prompt is uploading, and leaves project B untouched', async () => {
        const {mockScene} = mockSceneWithCandidate();
        enableEditing();
        let resolveUpload!: (path: string) => void;
        vi.spyOn(service, 'uploadText').mockReturnValue(
          new Promise<string>(resolve => (resolveUpload = resolve)),
        );

        const editPromise = service.editCandidate(
          mockScene as any,
          0,
          'make the sky purple',
        );
        await settle(); // reach the upload await

        // User leaves project-1 for another project before the upload
        // finishes.
        projectConfigSignal.set({id: 'project-B', storyboard: []});
        resolveUpload('p/edit-prompt.txt');
        await editPromise;

        // Nothing is paid yet: the workflow is never posted, and nothing was
        // written into the now-loaded project-B.
        expect(httpClientMock.post).not.toHaveBeenCalled();
        expect(configServiceMock.updateProjectConfig).not.toHaveBeenCalled();
      });

      it('does not write an error into project B when the project changes while the prompt is uploading and the upload rejects', async () => {
        const {mockScene} = mockSceneWithCandidate();
        enableEditing();
        // The orphaned-run log is expected; spy to keep it out of the test
        // output.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let rejectUpload!: (err: Error) => void;
        vi.spyOn(service, 'uploadText').mockReturnValue(
          new Promise<string>((_, reject) => (rejectUpload = reject)),
        );

        const editPromise = service.editCandidate(
          mockScene as any,
          0,
          'make the sky purple',
        );
        await settle();

        projectConfigSignal.set({id: 'project-B', storyboard: []});
        rejectUpload(new Error('upload failed'));
        await editPromise;

        // The failure must not be stamped onto whatever project is loaded
        // now (project-B), and no failure snackbar is shown for it.
        expect(configServiceMock.updateProjectConfig).not.toHaveBeenCalled();
        expect(matSnackBarMock.open).not.toHaveBeenCalled();
      });

      it('does not write the pending marker or poll when the project changes while the workflow POST is pending', async () => {
        const {mockScene} = mockSceneWithCandidate();
        enableEditing();
        vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
        let resolvePost!: (value: {executionId: string}) => void;
        httpClientMock.post.mockReturnValue(
          from(
            new Promise<{executionId: string}>(
              resolve => (resolvePost = resolve),
            ),
          ),
        );
        const pollSpy = vi.spyOn(service, 'pollWorkflow');

        const editPromise = service.editCandidate(
          mockScene as any,
          0,
          'make the sky purple',
        );
        await settle(); // reach the POST await

        // User leaves project-1 for another project before the POST
        // resolves.
        projectConfigSignal.set({id: 'project-B', storyboard: []});
        resolvePost({executionId: 'edit-exec-id'});
        await editPromise;

        // The run is paid for and started, but the marker is never written
        // and it is never polled: it would otherwise leak into project-B.
        expect(pollSpy).not.toHaveBeenCalled();
        expect(configServiceMock.updateProjectConfig).not.toHaveBeenCalled();
      });

      it('logs the orphaned run instead of writing an error into project B when the poll rejects with a generic error after the project changed', async () => {
        const {mockScene} = mockSceneWithCandidate();
        enableEditing();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(service, 'uploadText').mockResolvedValue('p/edit-prompt.txt');
        httpClientMock.post.mockReturnValue(of({executionId: 'edit-exec-id'}));
        let rejectPoll!: (err: Error) => void;
        vi.spyOn(service, 'pollWorkflow').mockReturnValue(
          new Promise((_, reject) => (rejectPoll = reject)),
        );

        const editPromise = service.editCandidate(
          mockScene as any,
          0,
          'make the sky purple',
        );
        await settle(); // the marker is persisted into project-1, now polling

        projectConfigSignal.set({id: 'project-B', storyboard: []});
        rejectPoll(new Error('poll failed'));
        await editPromise;

        // Only the original in-flight marker (written into project-1 before
        // the switch) was ever persisted: the failure is not written into
        // project-B, and no failure snackbar is shown for it.
        expect(configServiceMock.updateProjectConfig).toHaveBeenCalledTimes(1);
        expect(matSnackBarMock.open).not.toHaveBeenCalled();
        expect(errSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            sceneId: 'scene-1',
            projectId: 'project-1',
            executionId: 'edit-exec-id',
          }),
        );
      });
    });
  });

  describe('resume of persisted in-flight generations', () => {
    const persistedPending = {
      executionId: 'persisted-exec-id',
      requestedCount: 2,
      startedAt: '2026-06-12T00:00:00.000Z',
      durationSeconds: 7,
      model: 'persisted-model',
      generateAudio: true,
      resolution: '1080p',
      prompt: 'persisted prompt',
    };

    function mockProjectWithPending(candidates: any[] = []) {
      const scene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'live prompt',
        candidates,
        pendingGeneration: {...persistedPending},
      };
      const project = {id: 'project-1', storyboard: [scene]};
      projectConfigSignal.set(project);
      return project;
    }

    it('should show placeholders, poll the persisted execution and attach on completion', async () => {
      mockProjectWithPending();
      setupHappyMedia();
      let resolvePoll!: (value: any) => void;
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(resolve => (resolvePoll = resolve)));

      runResumeScan();

      // Placeholders render through the same transient signal as in-session
      // runs, with zero storyboard changes.
      expect(service.generatingSceneIds().has('scene-1')).toBe(true);
      expect(pollSpy).toHaveBeenCalledWith('persisted-exec-id', 'project-1');

      resolvePoll({sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}}});
      await vi.waitFor(() =>
        expect(configServiceMock.updateProjectConfig).toHaveBeenCalled(),
      );
      await vi.waitFor(() =>
        expect(service.generatingSceneIds().has('scene-1')).toBe(false),
      );

      const finalScene = lastUpdatedScene();
      expect(finalScene).not.toHaveProperty('pendingGeneration');
      // Candidates are built from the persisted generation parameters.
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          runNumber: 1,
          video: {url: 'https://signed.example/p/v1.mp4', path: 'p/v1.mp4'},
          prompt: 'persisted prompt',
          model: 'persisted-model',
          durationSeconds: 7,
          generateAudio: true,
          resolution: '1080p',
        }),
      ]);
      expect(configServiceMock.flushPendingSave).toHaveBeenCalled();
    });

    it('should not double-poll when the scan triggers repeatedly', async () => {
      mockProjectWithPending();
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));

      runResumeScan();
      runResumeScan();
      await settle();
      runResumeScan();

      expect(pollSpy).toHaveBeenCalledTimes(1);
    });

    it('should keep pendingGeneration on ProjectChangedError and resume on a later return', async () => {
      const project = mockProjectWithPending();
      // Real pollWorkflow: first status arrives after the user has left.
      httpClientMock.get.mockReturnValue(of({sink: {output: undefined}}));

      runResumeScan();
      expect(service.generatingSceneIds().has('scene-1')).toBe(true);
      // Navigate away before the first status emission is processed.
      projectConfigSignal.set({
        id: 'other-project',
        storyboard: [],
      });

      await vi.waitFor(() =>
        expect(service.generatingSceneIds().has('scene-1')).toBe(false),
      );

      // The persisted marker was not touched: no update, no flush, no error.
      expect(configServiceMock.updateProjectConfig).not.toHaveBeenCalled();
      expect(configServiceMock.flushPendingSave).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).not.toHaveBeenCalled();

      // Returning to the project resumes the same execution again.
      projectConfigSignal.set(project);
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));
      runResumeScan();
      expect(pollSpy).toHaveBeenCalledWith('persisted-exec-id', 'project-1');
    });

    it('should clear pendingGeneration when the resumed workflow reports an error', async () => {
      mockProjectWithPending();
      // The resume error is logged by design; spy to keep it out of the test
      // output, then assert it was emitted.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{_error: 'Resumed run failed'}]}}},
      } as any);

      runResumeScan();
      await vi.waitFor(() =>
        expect(service.generatingSceneIds().has('scene-1')).toBe(false),
      );

      expect(errSpy).toHaveBeenCalledWith(
        'Video generation resume error:',
        expect.objectContaining({executionId: 'persisted-exec-id'}),
      );
      expect(lastUpdatedScene()).not.toHaveProperty('pendingGeneration');
      expect(lastUpdatedScene()).toHaveProperty(
        'generationError',
        'Resumed run failed',
      );
      expect(configServiceMock.flushPendingSave).toHaveBeenCalledTimes(1);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining(
          'failed to generate — open the marked scene to see why.',
        ),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should skip videos already attached to the scene (idempotent attach)', async () => {
      const existingCandidate = {
        runNumber: 1,
        durationSeconds: 7,
        prompt: 'persisted prompt',
        model: 'persisted-model',
        generateAudio: true,
        resolution: '1080p',
        video: {url: 'https://old.example/p/v1.mp4', path: 'p/v1.mp4'},
      };
      mockProjectWithPending([existingCandidate]);
      setupHappyMedia();
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {
          output: {'0': {video: [{file: 'p/v1.mp4'}, {file: 'p/v2.mp4'}]}},
        },
      } as any);

      runResumeScan();
      await vi.waitFor(() =>
        expect(service.generatingSceneIds().has('scene-1')).toBe(false),
      );

      // Only the missing video was resolved and attached.
      expect(mediaServiceMock.signUrl).toHaveBeenCalledTimes(1);
      expect(mediaServiceMock.signUrl).toHaveBeenCalledWith('p/v2.mp4');
      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({
          video: {url: 'https://old.example/p/v1.mp4', path: 'p/v1.mp4'},
        }),
        expect.objectContaining({
          runNumber: 2,
          video: {url: 'https://signed.example/p/v2.mp4', path: 'p/v2.mp4'},
        }),
      ]);
      expect(finalScene).not.toHaveProperty('pendingGeneration');
    });

    it('resumes an edit pending record, passing trim/editPrompt/editedFromRun through to the candidate', async () => {
      const scene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'live prompt',
        candidates: [
          {
            runNumber: 1,
            durationSeconds: 5,
            model: 'mock-veo',
            prompt: 'live prompt',
            generateAudio: false,
            resolution: '720p',
            video: {
              url: 'https://old.example/p/source.mp4',
              path: 'p/source.mp4',
            },
          },
        ],
        pendingGeneration: {
          executionId: 'edit-exec-id',
          requestedCount: 1,
          startedAt: '2026-06-12T00:00:00.000Z',
          durationSeconds: 5,
          trim: {start: 1, end: 4},
          model: 'omni-1',
          generateAudio: true,
          resolution: '720p',
          prompt: 'live prompt',
          editPrompt: 'make the sky purple',
          editedFromRun: 1,
        },
      };
      projectConfigSignal.set({id: 'project-1', storyboard: [scene]});
      setupHappyMedia();
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/edited.mp4'}]}}},
      } as any);

      runResumeScan();
      await vi.waitFor(() =>
        expect(service.generatingSceneIds().has('scene-1')).toBe(false),
      );

      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toEqual([
        scene.candidates[0],
        expect.objectContaining({
          runNumber: 2,
          trim: {start: 1, end: 4},
          model: 'omni-1',
          generateAudio: true,
          editPrompt: 'make the sky purple',
          editedFromRun: 1,
          video: {
            url: 'https://signed.example/p/edited.mp4',
            path: 'p/edited.mp4',
          },
        }),
      ]);
    });

    it('should not resume scenes that are already generating in this session', () => {
      mockProjectWithPending();
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));
      service.generatingSceneIds.update(ids => {
        const newIds = new Set(ids);
        newIds.add('scene-1');
        return newIds;
      });

      runResumeScan();

      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('does not resume until global config has loaded (E1)', () => {
      mockProjectWithPending();
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));

      // Global config (gcsBucket etc.) has not loaded yet. The poll path would
      // dereference it, so the resume effect must early-return and NOT resume
      // (which, before the guard, threw a swallowed TypeError that could clear
      // a healthy run's marker).
      globalConfigSignal.set(undefined);
      runResumeScan();
      expect(pollSpy).not.toHaveBeenCalled();
      expect(service.generatingSceneIds().has('scene-1')).toBe(false);

      // Once /api/config resolves, the effect re-runs and the resume proceeds.
      globalConfigSignal.set({
        gcsBucket: 'mock-bucket',
      });
      runResumeScan();
      expect(pollSpy).toHaveBeenCalledWith('persisted-exec-id', 'project-1');
    });
  });

  describe('resume of a persisted in-flight render', () => {
    function mockProjectWithRender(renderRuns: any[] = []) {
      const project = {
        id: 'project-1',
        storyboard: [],
        renderRuns,
        pendingRender: {
          executionId: 'render-exec-id',
          startedAt: '2026-06-12T00:00:00.000Z',
        },
      };
      projectConfigSignal.set(project);
      return project;
    }

    it("resumes a different project's pending render even while another render is in flight (E2)", () => {
      // Simulate project A's live render in flight: the SHARED combiningScenes
      // flag is set. The old gate keyed on this flag, so opening any other
      // project with its own pendingRender was wrongly skipped. The guard is
      // now per-execution, so project B's distinct render resumes regardless.
      service.combiningScenes.set(true);
      projectConfigSignal.set({
        id: 'project-B',
        storyboard: [],
        pendingRender: {
          executionId: 'render-exec-B',
          startedAt: '2026-06-12T00:00:00.000Z',
        },
      });
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));

      runResumeScan();

      expect(pollSpy).toHaveBeenCalledWith('render-exec-B', 'project-B');
    });

    it('resumes the render, records the output and clears the marker', async () => {
      mockProjectWithRender();
      setupHappyMedia();
      let resolvePoll!: (value: any) => void;
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(resolve => (resolvePoll = resolve)));

      runResumeScan();

      // The button shows "Rendering..." again on return, and the persisted
      // execution is re-polled.
      expect(service.combiningScenes()).toBe(true);
      expect(pollSpy).toHaveBeenCalledWith('render-exec-id', 'project-1');

      resolvePoll({sink: {output: {'0': {video: [{file: 'p/final.mp4'}]}}}});
      await vi.waitFor(() =>
        expect(configServiceMock.addRenderRun).toHaveBeenCalled(),
      );

      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outputVideo: {
            path: 'p/final.mp4',
            url: 'https://signed.example/p/final.mp4',
          },
          wasPlayed: false,
        }),
      );
      expect(configServiceMock.setPendingRender).toHaveBeenCalledWith(
        undefined,
      );
      await vi.waitFor(() => expect(service.combiningScenes()).toBe(false));
    });

    it('retries a transient signing failure, then records the resumed render and clears the marker', async () => {
      mockProjectWithRender();
      setupHappyMedia();
      // The render finished; signing its output URL fails once (a transient
      // /api/signUrl blip) then succeeds on retry via withRetry. The finished
      // video must be recorded normally and the marker cleared, not lost. (E3)
      let attempts = 0;
      mediaServiceMock.signUrl.mockImplementation((path: string) => {
        if (++attempts === 1) {
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve(`https://signed.example/${path}`);
      });
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/final.mp4'}]}}},
      } as any);

      vi.useFakeTimers();
      runResumeScan();
      // Drive the withRetry backoff (real SIGN_URL_RETRY_DELAYS_MS) to
      // completion; pollWorkflow is spied, so the only timers in flight are the
      // finite retry delays — safe to drain.
      await vi.runAllTimersAsync();

      expect(attempts).toBe(2); // failed once, retried, succeeded
      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outputVideo: {
            path: 'p/final.mp4',
            url: 'https://signed.example/p/final.mp4',
          },
          wasPlayed: false,
        }),
      );
      expect(configServiceMock.setPendingRender).toHaveBeenCalledWith(
        undefined,
      );
      // No error surfaced: the blip was fully recovered.
      expect(matSnackBarMock.open).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);
    });

    it('does not double-poll when the scan triggers repeatedly', async () => {
      mockProjectWithRender();
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));

      runResumeScan();
      runResumeScan();
      await settle();
      runResumeScan();

      expect(pollSpy).toHaveBeenCalledTimes(1);
    });

    it('unsticks the button on ProjectChangedError, keeps the marker, and resumes on return', async () => {
      const project = mockProjectWithRender();
      // Real pollWorkflow: the first status arrives after the user has left.
      httpClientMock.get.mockReturnValue(of({sink: {output: undefined}}));

      runResumeScan();
      expect(service.combiningScenes()).toBe(true);
      // Navigate away before the first status emission is processed.
      projectConfigSignal.set({
        id: 'other-project',
        storyboard: [],
      });

      // The button is reset (not left stuck on "Rendering...").
      await vi.waitFor(() => expect(service.combiningScenes()).toBe(false));

      // The persisted marker was not touched: no record, no clear, no error.
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).not.toHaveBeenCalled();

      // Returning to the project resumes the same execution again.
      projectConfigSignal.set(project);
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));
      runResumeScan();
      expect(pollSpy).toHaveBeenCalledWith('render-exec-id', 'project-1');
    });

    it('does not record the render to the wrong project when navigation happens while signing, and re-resumes on return (E5)', async () => {
      const project = mockProjectWithRender();
      // The poll completes with a finished render...
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/final.mp4'}]}}},
      } as any);
      // ...but signing its output URL is still in flight, leaving a window for
      // the user to navigate away before the render is recorded.
      let resolveSign!: (url: string) => void;
      mediaServiceMock.signUrl.mockReturnValue(
        new Promise<string>(resolve => (resolveSign = resolve)),
      );

      runResumeScan();
      await settle(); // reach the signing await
      expect(service.combiningScenes()).toBe(true);

      // User navigates to another project before signing finishes.
      projectConfigSignal.set({id: 'project-B', storyboard: []});
      resolveSign('https://signed.example/p/final.mp4');
      await settle();

      // The finished render was NOT recorded against project-B and project-1's
      // marker was NOT cleared: it is not lost to the wrong project. The button
      // is reset rather than left stuck.
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);

      // Returning to project-1 re-resumes the same execution (the resume claim
      // was released), so the render is re-collected into the correct project.
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));
      projectConfigSignal.set(project);
      TestBed.tick();
      expect(pollSpy).toHaveBeenCalledWith('render-exec-id', 'project-1');
    });

    it('clears the marker and records the error when the resumed render fails', async () => {
      mockProjectWithRender();
      // The resume error is logged by design; spy to keep it out of the test
      // output, then assert it was emitted.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{_error: 'Resumed render failed'}]}}},
      } as any);

      runResumeScan();
      await vi.waitFor(() => expect(service.combiningScenes()).toBe(false));

      expect(errSpy).toHaveBeenCalledWith(
        'Combine scenes resume error:',
        expect.objectContaining({executionId: 'render-exec-id'}),
      );
      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({errorMessage: 'Resumed render failed'}),
      );
      expect(configServiceMock.setPendingRender).toHaveBeenCalledWith(
        undefined,
      );
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Resumed render failed',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('keeps the marker and records no error when the resumed render cannot be signed', async () => {
      mockProjectWithRender();
      // The render finished, but signing its output URL fails persistently
      // (transient /api/signUrl outage). withRetry exhausts its attempts and the
      // path is treated like a stalled render — not a failure — so the finished
      // video is not discarded: the marker is kept for a later reopen. (E3)
      mediaServiceMock.signUrl.mockRejectedValue(new Error('sign failed'));
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/final.mp4'}]}}},
      } as any);

      vi.useFakeTimers();
      runResumeScan();
      // Drain the full withRetry backoff (real SIGN_URL_RETRY_DELAYS_MS) to its
      // exhaustion; pollWorkflow is spied, so only finite retry timers run.
      await vi.runAllTimersAsync();

      // No error run recorded and the marker is never cleared (kept for retry).
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Your video is ready but could not be loaded right now — ' +
          'reopen the project to retry.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });
  });

  describe('global config guard (E1)', () => {
    // The workflow builders read globalConfig fields. If /api/config has not
    // loaded (value() is undefined), the generation paths must fail fast with a
    // clear, recoverable message instead of a vague "Failed to start workflow"
    // from a non-null-assertion TypeError.
    it('fails generateStoryboard with a recoverable message when global config is not loaded', async () => {
      globalConfigSignal.set(undefined);

      await service.generateStoryboard([], '', 'none');

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Configuration is not loaded yet. ' +
          'Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('fails combineScenes with a recoverable message when global config is not loaded', async () => {
      globalConfigSignal.set(undefined);

      await service.combineScenes();

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('fails candidate generation with a recoverable message and does NOT flag the scene when global config is not loaded', async () => {
      globalConfigSignal.set(undefined);

      await service.generateCandidates(
        {id: 'scene-1', type: 'generated'} as any,
        generationParams,
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      // No workflow started and the scene is NOT marked failed (no
      // generationError / "!" badge): a missing config is recoverable.
      expect(configServiceMock.updateProjectConfig).not.toHaveBeenCalled();
      expect(service.generatingSceneIds().has('scene-1')).toBe(false);
    });
  });

  describe('audio lock in generation', () => {
    function mockSceneAndProject() {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [],
      };
      const mockProject = {
        id: 'project-1',
        numberOfCandidates: 2,
        storyboard: [mockScene],
      };
      projectConfigSignal.set(mockProject);
      return mockScene;
    }

    it('posts generate_audio: true and records generateAudio: true when the model always generates audio', async () => {
      configServiceMock.audioLocked.mockReturnValue(true);
      const mockScene = mockSceneAndProject();
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/video-prompt.txt');
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);

      // The project itself asked for no audio; the model's lock overrides it.
      await service.generateCandidates(mockScene as any, {
        ...generationParams,
        generateAudio: false,
      });

      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/supplyNode',
        expect.objectContaining({
          workflowDefinition: expect.objectContaining({
            n_0: expect.objectContaining({
              parameters: expect.objectContaining({generate_audio: true}),
            }),
          }),
        }),
      );
      const finalScene = lastUpdatedScene();
      expect(finalScene.candidates).toEqual([
        expect.objectContaining({generateAudio: true}),
      ]);
      // The persisted in-flight marker must also carry the locked value, not
      // the caller-requested one, so a resumed run stays locked too.
      const pendingScene =
        configServiceMock.updateProjectConfig.mock.calls[0][0].storyboard[0];
      expect(pendingScene.pendingGeneration).toEqual(
        expect.objectContaining({generateAudio: true}),
      );
    });
  });

  describe('video location resolution in generation', () => {
    function mockSceneAndProject(model: string) {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        prompt: 'prompt 1',
        candidates: [],
      };
      const mockProject = {
        id: 'project-1',
        numberOfCandidates: 2,
        model,
        storyboard: [mockScene],
      };
      projectConfigSignal.set(mockProject);
      return mockScene;
    }

    it('posts the resolved location for a regional Veo model', async () => {
      globalConfigSignal.set({
        ...globalConfigSignal(),
        veoLocation: 'us-central1',
      });
      configServiceMock.resolveVideoLocation.mockReturnValue('us-central1');
      const mockScene = mockSceneAndProject('veo-default');
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/video-prompt.txt');
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);

      await service.generateCandidates(mockScene as any, generationParams);

      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/supplyNode',
        expect.objectContaining({
          workflowDefinition: expect.objectContaining({
            n_0: expect.objectContaining({
              parameters: expect.objectContaining({
                gcp_location: 'us-central1',
              }),
            }),
          }),
        }),
      );
      expect(configServiceMock.resolveVideoLocation).toHaveBeenCalledWith(
        'veo-default',
      );
    });

    it('posts the global fallback for a global-only Omni model at a regional deployment', async () => {
      globalConfigSignal.set({
        ...globalConfigSignal(),
        veoLocation: 'us-central1',
      });
      configServiceMock.resolveVideoLocation.mockReturnValue('global');
      const mockScene = mockSceneAndProject('omni-1');
      setupHappyMedia();
      vi.spyOn(service, 'uploadText').mockResolvedValue('p/video-prompt.txt');
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/v1.mp4'}]}}},
      } as any);

      await service.generateCandidates(mockScene as any, generationParams);

      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/supplyNode',
        expect.objectContaining({
          workflowDefinition: expect.objectContaining({
            n_0: expect.objectContaining({
              parameters: expect.objectContaining({gcp_location: 'global'}),
            }),
          }),
        }),
      );
      expect(configServiceMock.resolveVideoLocation).toHaveBeenCalledWith(
        'omni-1',
      );
    });
  });

  describe('combineScenes: render contract', () => {
    it('does not submit a workflow with no renderable video', async () => {
      setRenderStoryboard([]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Select or upload at least one scene video before rendering.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
    });

    it('does not submit a workflow when a transition outlasts its clips', async () => {
      setRenderStoryboard([
        {
          id: 'short',
          type: 'video',
          name: 'Short clip',
          video: {path: 'videos/short.mp4', url: ''},
          durationSeconds: 5,
          trim: {start: 0, end: 0.042},
        },
        {
          id: 'next',
          type: 'video',
          name: 'Next clip',
          video: {path: 'videos/next.mp4', url: ''},
          durationSeconds: 5,
          transition: 'fade',
          transitionOverlap: 0.5,
        },
      ]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining('longer than the clips it joins'),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('does not submit a transition exactly as long as its own clip', async () => {
      setRenderStoryboard([
        {
          id: 'long',
          type: 'video',
          name: 'Long clip',
          video: {path: 'videos/long.mp4', url: ''},
          durationSeconds: 5,
        },
        {
          id: 'exact',
          type: 'video',
          name: 'Exact clip',
          video: {path: 'videos/exact.mp4', url: ''},
          durationSeconds: 5,
          trim: {start: 0, end: 0.5},
          transition: 'fade',
          transitionOverlap: 0.5,
        },
      ]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining('longer than the clips it joins'),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('does not submit a transition exactly as long as the previous clip', async () => {
      setRenderStoryboard([
        {
          id: 'exact-prev',
          type: 'video',
          name: 'Exact previous',
          video: {path: 'videos/prev.mp4', url: ''},
          durationSeconds: 5,
          trim: {start: 0, end: 0.5},
        },
        {
          id: 'long-next',
          type: 'video',
          name: 'Long next',
          video: {path: 'videos/next.mp4', url: ''},
          durationSeconds: 5,
          transition: 'fade',
          transitionOverlap: 0.5,
        },
      ]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining('longer than the clips it joins'),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('submits a transition that fits, using the persisted overlap', async () => {
      setRenderStoryboard([
        {
          id: 'a',
          type: 'video',
          name: 'Clip A',
          video: {path: 'videos/a.mp4', url: ''},
          durationSeconds: 5,
        },
        {
          id: 'b',
          type: 'video',
          name: 'Clip B',
          video: {path: 'videos/b.mp4', url: ''},
          durationSeconds: 5,
          transition: 'fade',
          transitionOverlap: 0,
        },
      ]);
      const startSpy = vi
        .spyOn(service, 'startCombineScenesWorkflow')
        .mockResolvedValue(of({executionId: 'render-exec-id'}) as any);
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'renders/output.mp4'}]}}},
      } as any);
      mediaServiceMock.signUrl.mockResolvedValue(
        'https://signed.example/o.mp4',
      );

      await service.combineScenes();

      expect(startSpy).toHaveBeenCalled();
      // An explicit zero overlap is a hard cut and must reach the backend as
      // 0, not be dropped or defaulted.
      expect(startSpy.mock.calls[0][0][1]).toEqual(
        expect.objectContaining({transition: 'fade', transition_overlap: 0}),
      );
    });

    it('does not submit a workflow when every scene is unselected (non-empty storyboard)', async () => {
      // Distinct from the empty-storyboard case above: the storyboard is
      // non-empty, but the only scene is a generated one with no candidate
      // chosen yet, so it resolves to 'not-selected', never 'ready'.
      setRenderStoryboard([
        {
          id: 'unselected',
          type: 'generated',
          name: 'No candidate selected',
          candidates: [
            {
              video: {path: 'videos/candidate.mp4', url: ''},
              durationSeconds: 5,
            },
          ],
        },
      ]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Select or upload at least one scene video before rendering.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('does not submit a partial render when an intended clip is invalid', async () => {
      setRenderStoryboard([
        {
          id: 'ready',
          type: 'video',
          name: 'Ready clip',
          video: {path: 'videos/ready.mp4', url: ''},
          durationSeconds: 5,
        },
        {
          id: 'invalid',
          type: 'generated',
          name: 'Invalid selected clip',
          selectedCandidateIndex: 0,
          candidates: [
            {
              video: {path: '', url: 'https://legacy.example/video.mp4'},
              durationSeconds: 5,
            },
          ],
        },
      ]);
      const startSpy = vi.spyOn(service, 'startCombineScenesWorkflow');

      await service.combineScenes();

      expect(startSpy).not.toHaveBeenCalled();
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        expect.stringContaining('storage path or valid duration'),
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);
    });

    it('submits the shared clip values and ignores an unselected generated scene', async () => {
      setRenderStoryboard([
        {
          id: 'ready',
          type: 'generated',
          name: 'Ready clip',
          selectedCandidateIndex: 0,
          candidates: [
            {
              video: {path: 'videos/ready.mp4', url: ''},
              durationSeconds: 10,
              trim: {start: 2, end: 8},
            },
          ],
        },
        {
          id: 'not-selected',
          type: 'generated',
          name: 'No candidate selected',
        },
      ]);
      const startSpy = vi
        .spyOn(service, 'startCombineScenesWorkflow')
        .mockResolvedValue(of({executionId: 'render-exec-id'}) as any);
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'renders/output.mp4'}]}}},
      } as any);
      mediaServiceMock.signUrl.mockResolvedValue(
        'https://signed.example/renders/output.mp4',
      );

      await service.combineScenes();

      expect(startSpy).toHaveBeenCalledWith(
        [
          {
            file_type: 'video',
            file_path: 'videos/ready.mp4',
            start_time: 0,
            skip_time: 2,
            duration: 6,
          },
        ],
        false,
      );
    });
  });

  describe('combineScenes: signing-failure resilience', () => {
    it('keeps the pending render and records no error when the output cannot be signed', async () => {
      // A live render finishes, but signing its output URL fails persistently
      // (transient /api/signUrl outage). withRetry exhausts its attempts and the
      // completed render is kept (marker not cleared, no error run) so a reopen
      // re-collects it, mirroring the resumed-render path. (E3)
      setRenderStoryboard([
        {
          id: 'video-1',
          type: 'video',
          name: 'Video 1',
          video: {path: 'videos/video-1.mp4', url: ''},
          durationSeconds: 5,
        },
      ]);
      vi.spyOn(service, 'startCombineScenesWorkflow').mockResolvedValue(
        of({executionId: 'render-exec-id'}) as any,
      );
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue({
        sink: {output: {'0': {video: [{file: 'p/final.mp4'}]}}},
      } as any);
      mediaServiceMock.signUrl.mockRejectedValue(new Error('sign failed'));

      vi.useFakeTimers();
      const combinePromise = service.combineScenes();
      // pollWorkflow is spied, so the only timers are the finite signUrl retry
      // backoffs; drain them to exhaustion.
      await vi.runAllTimersAsync();
      await combinePromise;

      // Marker set at start, but NEVER cleared (kept for a reopen to retry).
      expect(configServiceMock.setPendingRender).toHaveBeenCalledWith(
        expect.objectContaining({executionId: 'render-exec-id'}),
      );
      expect(configServiceMock.setPendingRender).not.toHaveBeenCalledWith(
        undefined,
      );
      // No render run recorded (neither success nor error); button resets.
      expect(configServiceMock.addRenderRun).not.toHaveBeenCalled();
      expect(service.combiningScenes()).toBe(false);
      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Your video is ready but could not be loaded right now — ' +
          'reopen the project to retry.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });
  });
});
