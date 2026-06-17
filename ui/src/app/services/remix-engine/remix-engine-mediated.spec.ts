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
import '@angular/compiler';
import {HttpClient} from '@angular/common/http';
import {EnvironmentInjector} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../client-media/client-media';
import {ConfigService} from '../config/config';
import {MediaService} from '../media/media';
import {RemixEngineService} from './remix-engine';

// Pin the env to the fully mediated front-door composition: these tests
// cover persist/resume of in-flight generations (dataPlaneMode) and the
// signUrl retry/allSettled completion path (mediaMode).
vi.mock('../../../env', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    env: {
      ...actual.env,
      controlPlaneMode: 'iap',
      mediaMode: 'mediated',
      dataPlaneMode: 'mediated',
    },
  };
});

// Shorten the poll interval and the signUrl retry backoff for tests.
vi.mock('./remix-engine.interface', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    WORKFLOW_STATUS_POLL_INTERVAL_MS: 10,
    SIGN_URL_RETRY_DELAYS_MS: [5, 5],
  };
});

const mockGet = vi.fn();
const mockInjector = {get: mockGet};
// The service's constructor registers a resume effect on the mediated data
// plane; capture its callback so tests can drive the scan deterministically.
const effectCallbacks: Array<() => void> = [];

// Mock @angular/core to bypass runInInjectionContext, provide inject and
// capture effect callbacks.
vi.mock('@angular/core', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    runInInjectionContext: vi.fn((injector: any, fn: () => any) => fn()),
    inject: vi.fn((token: any) => mockGet(token)),
    effect: vi.fn((fn: any) => {
      effectCallbacks.push(fn);
      return {destroy: vi.fn()};
    }),
  };
});

describe('RemixEngineService (mediated)', () => {
  let service: RemixEngineService;
  let httpClientMock: any;
  let configServiceMock: any;
  let clientMediaServiceMock: any;
  let matSnackBarMock: any;
  let mediaServiceMock: any;

  const generationParams = {
    durationSeconds: 5,
    model: 'model-1',
    generateAudio: false,
    resolution: '720p' as const,
  };

  /** Runs the captured resume-effect callback(s), as Angular would on a
   * projectConfig change. */
  function runResumeScan() {
    for (const callback of [...effectCallbacks]) {
      callback();
    }
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

  beforeEach(() => {
    vi.clearAllMocks();
    effectCallbacks.length = 0;
    (globalThis as any).window = {location: {origin: 'http://localhost'}};

    httpClientMock = {
      post: vi.fn(),
      get: vi.fn(),
    };

    configServiceMock = {
      globalConfig: {
        value: vi.fn().mockReturnValue({
          gcpProject: 'mock-project',
          gcpLocation: 'mock-location',
          gcsBucket: 'mock-bucket',
          tasksQueuePrefix: 'mock-queue',
          veoLocation: 'mock-veo-loc',
          duration: 5,
          veoModel: 'mock-veo',
          numberOfCandidates: 2,
          generateAudio: true,
        }),
      },
      projectConfig: {
        value: vi.fn().mockReturnValue({
          id: 'project-1',
          resolution: '720p',
          aspectRatio: '16:9',
          numberOfCandidates: 2,
          candidateDurationSeconds: 5,
          generateAudio: true,
          model: 'mock-veo',
          storyboard: [],
        }),
      },
      isGeneratedScene: vi.fn((scene: any) => scene?.type === 'generated'),
      isProvidedVideoScene: vi.fn((scene: any) => scene?.type === 'video'),
      updateProjectConfig: vi.fn(),
      addRenderRun: vi.fn(),
      setPendingRender: vi.fn(),
      flushPendingSave: vi.fn(),
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

    mockGet.mockImplementation((token: any) => {
      if (token === HttpClient) return httpClientMock;
      if (token === ConfigService) return configServiceMock;
      if (token === ClientMediaService) return clientMediaServiceMock;
      if (token === MatSnackBar) return matSnackBarMock;
      if (token === MediaService) return mediaServiceMock;
      if (token === EnvironmentInjector) return mockInjector;
      return null;
    });

    service = new RemixEngineService();
  });

  afterEach(() => {
    // Restore any console.error spies installed by the failure-path tests so
    // a real error in a later test is not silently swallowed.
    vi.restoreAllMocks();
  });

  it('should register exactly one resume effect at construction', () => {
    expect(effectCallbacks.length).toBe(1);
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
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
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
      configServiceMock.projectConfig.value.mockReturnValue({
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

      await service.generateCandidates(mockScene as any, generationParams);

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

      await service.generateCandidates(mockScene as any, generationParams);

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

      await service.generateCandidates(mockScene as any, generationParams);

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
      configServiceMock.projectConfig.value.mockReturnValue(project);
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
      configServiceMock.projectConfig.value.mockReturnValue({
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
      configServiceMock.projectConfig.value.mockReturnValue(project);
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
      configServiceMock.globalConfig.value.mockReturnValue(undefined);
      runResumeScan();
      expect(pollSpy).not.toHaveBeenCalled();
      expect(service.generatingSceneIds().has('scene-1')).toBe(false);

      // Once /api/config resolves, the effect re-runs and the resume proceeds.
      configServiceMock.globalConfig.value.mockReturnValue({
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
      configServiceMock.projectConfig.value.mockReturnValue(project);
      return project;
    }

    it("resumes a different project's pending render even while another render is in flight (E2)", () => {
      // Simulate project A's live render in flight: the SHARED combiningScenes
      // flag is set. The old gate keyed on this flag, so opening any other
      // project with its own pendingRender was wrongly skipped. The guard is
      // now per-execution, so project B's distinct render resumes regardless.
      service.combiningScenes.set(true);
      configServiceMock.projectConfig.value.mockReturnValue({
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

      runResumeScan();
      await vi.waitFor(() =>
        expect(configServiceMock.addRenderRun).toHaveBeenCalled(),
      );

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
      await vi.waitFor(() => expect(service.combiningScenes()).toBe(false));
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
      configServiceMock.projectConfig.value.mockReturnValue({
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
      configServiceMock.projectConfig.value.mockReturnValue(project);
      const pollSpy = vi
        .spyOn(service, 'pollWorkflow')
        .mockReturnValue(new Promise(() => {}));
      runResumeScan();
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

      runResumeScan();
      await vi.waitFor(() => expect(service.combiningScenes()).toBe(false));

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
      configServiceMock.globalConfig.value.mockReturnValue(undefined);

      await service.generateStoryboard([], '', 'none');

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Configuration is not loaded yet. ' +
          'Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('fails combineScenes with a recoverable message when global config is not loaded', async () => {
      configServiceMock.globalConfig.value.mockReturnValue(undefined);

      await service.combineScenes();

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });
  });
});
