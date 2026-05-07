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
import * as storage from '@angular/fire/storage';
import {Storage} from '@angular/fire/storage';
import {MatSnackBar} from '@angular/material/snack-bar';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../client-media/client-media';
import {ConfigService} from '../config/config';
import {RemixEngineService} from './remix-engine';

// Mock poll interval to be short for tests
vi.mock('./remix-engine.interface', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    WORKFLOW_STATUS_POLL_INTERVAL_MS: 10,
  };
});

// Mock Firebase Storage
vi.mock('@angular/fire/storage', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    ref: vi.fn(),
    uploadString: vi.fn(),
    uploadBytes: vi.fn(),
    getDownloadURL: vi.fn(),
    getBlob: vi.fn(),
  };
});

const mockGet = vi.fn();
const mockInjector = {get: mockGet};

// Mock @angular/core to bypass runInInjectionContext and provide inject
vi.mock('@angular/core', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    runInInjectionContext: vi.fn((injector: any, fn: () => any) => fn()),
    inject: vi.fn((token: any) => mockGet(token)),
  };
});

describe('RemixEngineService', () => {
  let service: RemixEngineService;
  let httpClientMock: any;
  let configServiceMock: any;
  let storageMock: any;
  let clientMediaServiceMock: any;
  let matSnackBarMock: any;

  beforeEach(() => {
    (globalThis as any).window = {location: {origin: 'http://localhost'}};
    httpClientMock = {
      post: vi.fn(),
      get: vi.fn(),
    };

    configServiceMock = {
      globalConfig: {
        value: vi.fn().mockReturnValue({
          gatewayBaseUrl: 'http://mock-gateway',
          gatewayApiKey: 'mock-key',
          gcpProject: 'mock-project',
          gcpLocation: 'mock-location',
          gcsBucket: 'mock-bucket',
          tasksQueuePrefix: 'mock-queue',
          veoLocation: 'mock-veo-loc',
          geminiModel: 'mock-gemini',
          geminiLocation: 'mock-gemini-loc',
          outpainterModel: 'mock-outpaint',
          outpainterLocation: 'mock-outpaint-loc',
          duration: 5,
          veoModel: 'mock-veo',
          numberOfCandidates: 3,
          generateAudio: true,
        }),
      },
      projectConfig: {
        value: vi.fn().mockReturnValue({
          id: 'mock-project-id',
          resolution: '720p',
          aspectRatio: '16:9',
          numberOfCandidates: 3,
          candidateDurationSeconds: 5,
          generateAudio: true,
          model: 'mock-veo',
          storyboard: [],
        }),
      },
      isGeneratedScene: vi.fn().mockReturnValue(true),
      isProvidedVideoScene: vi.fn().mockReturnValue(false),
      updateProjectConfig: vi.fn(),
      addRenderRun: vi.fn(),
    };

    storageMock = {};

    clientMediaServiceMock = {
      generateLowQualityThumbnail: vi.fn(),
      generateHighQualityThumbnail: vi.fn(),
      toBase64: vi.fn(),
      toFile: vi.fn(),
    };

    matSnackBarMock = {
      open: vi.fn(),
    };

    mockGet.mockImplementation((token: any) => {
      if (token === HttpClient) return httpClientMock;
      if (token === ConfigService) return configServiceMock;
      if (token === Storage) return storageMock;
      if (token === ClientMediaService) return clientMediaServiceMock;
      if (token === MatSnackBar) return matSnackBarMock;
      if (token === EnvironmentInjector) return mockInjector;
      return null;
    });

    service = new RemixEngineService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('uploadText', () => {
    it('should upload text and return path', async () => {
      const mockSnapshot = {metadata: {fullPath: 'mock-path'}};
      vi.mocked(storage.uploadString).mockResolvedValue(mockSnapshot as any);
      vi.mocked(storage.ref).mockReturnValue({} as any);

      // Mock generateHash to return a fixed value for testing
      vi.spyOn(service, 'generateHash').mockResolvedValue('mock-hash');

      const path = await service.uploadText('test content', 'testfile');

      expect(path).toBe('mock-path');
      expect(storage.uploadString).toHaveBeenCalled();
    });
  });

  describe('generateHash', () => {
    it('should generate hash for string', async () => {
      const hash = await service.generateHash('test content');
      expect(hash).toBe(
        '6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72',
      );
    });
  });

  describe('startVideoGenerationWorkflow', () => {
    it('should call startWorkflow and return observable', async () => {
      const scene = {id: '1', prompt: 'test prompt', type: 'generated'};
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue('mock-prompt-path');

      const result = await service.startVideoGenerationWorkflow(
        scene as any,
        false,
      );

      expect(result).toBeTruthy();
      expect(httpClientMock.post).toHaveBeenCalled();
    });

    it('should handle error and return undefined', async () => {
      const scene = {id: '1', prompt: 'test prompt', type: 'generated'};
      vi.spyOn(service, 'uploadText').mockRejectedValue(
        new Error('Upload failed'),
      );

      const result = await service.startVideoGenerationWorkflow(
        scene as any,
        false,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('pollWorkflow', () => {
    it('should return response when sink output is defined', async () => {
      const mockResponse = {sink: {output: {'0': {video: []}}}};
      httpClientMock.get.mockReturnValue(of(mockResponse));

      const result = await service.pollWorkflow(
        'mock-execution-id',
        'mock-project-id',
      );

      expect(result).toEqual(mockResponse);
      expect(httpClientMock.get).toHaveBeenCalled();
    });

    it('should poll until sink output is defined', async () => {
      vi.useFakeTimers();
      const mockResponse1 = {sink: {output: undefined}};
      const mockResponse2 = {sink: {output: {'0': {video: []}}}};

      let callCount = 0;
      httpClientMock.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return of(mockResponse1);
        } else {
          return of(mockResponse2);
        }
      });

      const pollPromise = service.pollWorkflow(
        'mock-execution-id',
        'mock-project-id',
      );

      // Advance timers by 1ms to let timer(0, ...) emit
      await vi.advanceTimersByTimeAsync(1);

      // First poll should happen immediately
      expect(callCount).toBe(1);

      // Advance timers by 15ms to trigger the next poll (interval is 10ms)
      await vi.advanceTimersByTimeAsync(15);

      const result = await pollPromise;

      expect(result).toEqual(mockResponse2);
      expect(callCount).toBe(2);

      vi.useRealTimers();
    }, 10000);

    it('should throw ProjectChangedError if project changes', async () => {
      vi.useFakeTimers();
      const mockResponse = {sink: {output: undefined}};
      httpClientMock.get.mockImplementation(() => {
        console.log('Test 2: Mock HTTP GET called');
        return of(mockResponse);
      });
      configServiceMock.projectConfig.value.mockReturnValue({
        id: 'different-project-id',
      });

      const pollPromise = service.pollWorkflow(
        'mock-execution-id',
        'mock-project-id',
      );
      pollPromise.catch(() => {}); // Prevent unhandled rejection warning

      // Advance timers by 1ms to let timer(0, ...) emit
      await vi.advanceTimersByTimeAsync(1);

      let thrownError: any;
      try {
        await pollPromise;
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBeTruthy();
      expect(thrownError.message).toContain('Project changed');
      vi.useRealTimers();
    });
  });

  describe('generateCandidates', () => {
    it('should generate candidates and update project config', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};
      const mockProject = {id: 'project-1', storyboard: [mockScene]};

      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              video: [{file: 'mock-path/video.mp4'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      vi.mocked(storage.getDownloadURL).mockResolvedValue('http://mock-url');

      clientMediaServiceMock.generateLowQualityThumbnail.mockResolvedValue(
        new Blob(),
      );
      clientMediaServiceMock.toBase64.mockResolvedValue('mock-base64');
      clientMediaServiceMock.generateHighQualityThumbnail.mockResolvedValue(
        new Blob(),
      );
      clientMediaServiceMock.toFile.mockResolvedValue(
        new File([], 'mock-file'),
      );

      vi.spyOn(service, 'uploadThumbnail').mockResolvedValue({
        path: 'mock-thumb-path',
        url: 'mock-thumb-url',
      });

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledWith({
        storyboard: [
          {
            id: 'scene-1',
            prompt: 'prompt 1',
            candidates: [
              {
                runNumber: 1,
                durationSeconds: 5,
                prompt: 'prompt 1',
                model: 'model-1',
                generateAudio: false,
                resolution: '720p',
                video: {url: 'http://mock-url', path: 'mock-path/video.mp4'},
                lowQualityThumbnail: 'mock-base64',
                highQualityThumbnail: {
                  path: 'mock-thumb-path',
                  url: 'mock-thumb-url',
                },
              },
            ],
            selectedCandidateIndex: 0,
          },
        ],
      });
    });

    it('should return early if already generating candidates for the scene', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};
      service.generatingSceneIds.update(ids => {
        const newIds = new Set(ids);
        newIds.add('scene-1');
        return newIds;
      });

      vi.spyOn(service, 'startVideoGenerationWorkflow');

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(service.startVideoGenerationWorkflow).not.toHaveBeenCalled();
    });

    it('should handle workflow start failure and show error snackbar', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};

      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        undefined,
      );

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate video(s). Failed to start workflow',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle workflow execution error and show error snackbar', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};

      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              video: [{_error: 'Mock workflow error'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate video(s). Mock workflow error',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle workflow completed without output and show error snackbar', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};

      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: undefined,
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate video(s). Workflow completed without output',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle thumbnail generation failure gracefully', async () => {
      const mockScene = {id: 'scene-1', prompt: 'prompt 1', candidates: []};
      const mockProject = {id: 'project-1', storyboard: [mockScene]};
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      vi.spyOn(service, 'startVideoGenerationWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              video: [{file: 'mock-path/video.mp4'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      vi.mocked(storage.getDownloadURL).mockResolvedValue('http://mock-url');

      clientMediaServiceMock.generateLowQualityThumbnail.mockRejectedValue(
        new Error('Thumbnail failed'),
      );
      clientMediaServiceMock.generateHighQualityThumbnail.mockResolvedValue(
        new Blob(),
      );
      clientMediaServiceMock.toFile.mockResolvedValue(
        new File([], 'mock-file'),
      );
      vi.spyOn(service, 'uploadThumbnail').mockResolvedValue({
        path: 'mock-thumb-path',
        url: 'mock-thumb-url',
      });

      await service.generateCandidates(mockScene as any, {
        durationSeconds: 5,
        model: 'model-1',
        generateAudio: false,
        resolution: '720p',
      });

      expect(configServiceMock.updateProjectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          storyboard: [
            expect.objectContaining({
              candidates: [
                expect.objectContaining({
                  lowQualityThumbnail: undefined,
                }),
              ],
            }),
          ],
        }),
      );
    });
  });

  describe('generateStoryboard', () => {
    it('should generate storyboard and return mapped scenes', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              storyboard: [{file: 'mock-path/storyboard.json'}],
              outpainted_images: [
                {
                  product_id: 'prod-1',
                  image_id: 'img1',
                  file: 'mock-path/outpainted.jpg',
                },
              ],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      const mockStoryboardJson = {
        storyboard: [
          {product_id: 'prod-1', image_id: 'img1', prompt: 'prompt 1'},
        ],
      };
      const mockBlob = new Blob([JSON.stringify(mockStoryboardJson)], {
        type: 'application/json',
      });
      vi.mocked(storage.getBlob).mockResolvedValue(mockBlob);
      vi.mocked(storage.getDownloadURL).mockResolvedValue('http://mock-url');

      const result = await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(result).toBeTruthy();
      expect(result!.length).toBe(1);
      expect(result![0].type).toBe('generated');
    });

    it('should handle workflow start failure and show error snackbar', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(undefined);

      await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Failed to start workflow',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle workflow execution error and show error snackbar', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              storyboard: [{_error: 'Mock storyboard error'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Mock storyboard error',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle workflow completed without output and show error snackbar', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: undefined,
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Workflow completed without output',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle storyboard JSON file not found and show error snackbar', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              storyboard: [{}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Storyboard JSON file not found',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });

    it('should handle invalid storyboard JSON structure and show error snackbar', async () => {
      const mockProducts = [{id: 'prod-1', images: [{file: 'img1'}]}];

      vi.spyOn(service, 'startStoryboardWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              storyboard: [{file: 'mock-path/storyboard.json'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      const mockStoryboardJson = {};
      const mockBlob = new Blob([JSON.stringify(mockStoryboardJson)], {
        type: 'application/json',
      });
      vi.mocked(storage.getBlob).mockResolvedValue(mockBlob);

      await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to generate storyboard. Storyboard JSON file is missing storyboard',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    });
  });

  describe('combineScenes', () => {
    it('should combine scenes and add render run', async () => {
      const mockProject = {
        id: 'project-1',
        storyboard: [],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      vi.spyOn(service as any, 'getCombineScenesArrangements').mockReturnValue({
        scenes: [],
        audio: [],
        overlays: [],
      });

      vi.spyOn(service, 'startCombineScenesWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              video: [{file: 'mock-path/final_video.mp4'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      await service.combineScenes();

      expect(configServiceMock.addRenderRun).toHaveBeenCalled();
    });

    it('should calculate scene duration correctly with trim', async () => {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video.mp4'},
            durationSeconds: 10,
            trim: {start: 2, end: 5},
            runNumber: 1,
            prompt: 'prompt 1',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
      };
      const mockProject = {
        id: 'project-1',
        storyboard: [mockScene],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const workflowStatusMock = {
        sink: {output: {'0': {video: [{file: 'final.mp4'}]}}},
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        workflowStatusMock as any,
      );
      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      let capturedArrangement: any;
      vi.spyOn(service, 'startCombineScenesWorkflow').mockImplementation(
        async (arr: any) => {
          capturedArrangement = arr;
          return of({executionId: 'mock-execution-id'}) as any;
        },
      );

      await service.combineScenes();

      expect(capturedArrangement).toBeTruthy();
      expect(capturedArrangement.length).toBe(1);
      expect(capturedArrangement[0].skip_time).toBe(2);
      expect(capturedArrangement[0].duration).toBe(3);
    });

    it('should calculate scene duration correctly with trim start only', async () => {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video.mp4'},
            durationSeconds: 10,
            trim: {start: 2},
            runNumber: 1,
            prompt: 'prompt 1',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
      };
      const mockProject = {
        id: 'project-1',
        storyboard: [mockScene],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const workflowStatusMock = {
        sink: {output: {'0': {video: [{file: 'final.mp4'}]}}},
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        workflowStatusMock as any,
      );
      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      let capturedArrangement: any;
      vi.spyOn(service, 'startCombineScenesWorkflow').mockImplementation(
        async (arr: any) => {
          capturedArrangement = arr;
          return of({executionId: 'mock-execution-id'}) as any;
        },
      );

      await service.combineScenes();

      expect(capturedArrangement).toBeTruthy();
      expect(capturedArrangement.length).toBe(1);
      expect(capturedArrangement[0].skip_time).toBe(2);
      expect(capturedArrangement[0].duration).toBe(8);
    });

    it('should calculate scene duration correctly with trim end only', async () => {
      const mockScene = {
        id: 'scene-1',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video.mp4'},
            durationSeconds: 10,
            trim: {end: 5},
            runNumber: 1,
            prompt: 'prompt 1',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
      };
      const mockProject = {
        id: 'project-1',
        storyboard: [mockScene],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const workflowStatusMock = {
        sink: {output: {'0': {video: [{file: 'final.mp4'}]}}},
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        workflowStatusMock as any,
      );
      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      let capturedArrangement: any;
      vi.spyOn(service, 'startCombineScenesWorkflow').mockImplementation(
        async (arr: any) => {
          capturedArrangement = arr;
          return of({executionId: 'mock-execution-id'}) as any;
        },
      );

      await service.combineScenes();

      expect(capturedArrangement).toBeTruthy();
      expect(capturedArrangement.length).toBe(1);
      expect(capturedArrangement[0].skip_time).toBe(0);
      expect(capturedArrangement[0].duration).toBe(5);
    });

    it('should include transition in arrangement between two scenes', async () => {
      const mockScene1 = {
        id: 'scene-1',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video1.mp4'},
            durationSeconds: 10,
            runNumber: 1,
            prompt: 'prompt 1',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
        transition: 'fade',
        transitionOverlap: 1,
      };
      const mockScene2 = {
        id: 'scene-2',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video2.mp4'},
            durationSeconds: 10,
            runNumber: 1,
            prompt: 'prompt 2',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
      };
      const mockProject = {
        id: 'project-1',
        storyboard: [mockScene1, mockScene2],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const workflowStatusMock = {
        sink: {output: {'0': {video: [{file: 'final.mp4'}]}}},
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        workflowStatusMock as any,
      );
      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      let capturedArrangement: any;
      vi.spyOn(service, 'startCombineScenesWorkflow').mockImplementation(
        async (arr: any) => {
          capturedArrangement = arr;
          return of({executionId: 'mock-execution-id'}) as any;
        },
      );

      await service.combineScenes();

      expect(capturedArrangement).toBeTruthy();
      expect(capturedArrangement.length).toBe(2);
      expect(capturedArrangement[0].transition).toBe('fade');
      expect(capturedArrangement[0].transition_overlap).toBe(1);
      expect(capturedArrangement[1].file_path).toBe('mock-path/video2.mp4');
    });

    it('should calculate duration correctly with trim and transition between two scenes', async () => {
      const mockScene1 = {
        id: 'scene-1',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video1.mp4'},
            durationSeconds: 10,
            trim: {start: 2, end: 5},
            runNumber: 1,
            prompt: 'prompt 1',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
        transition: 'fade',
        transitionOverlap: 1,
      };
      const mockScene2 = {
        id: 'scene-2',
        type: 'generated',
        candidates: [
          {
            video: {path: 'mock-path/video2.mp4'},
            durationSeconds: 10,
            runNumber: 1,
            prompt: 'prompt 2',
            model: 'model-1',
            generateAudio: false,
            resolution: '720p',
          },
        ],
        selectedCandidateIndex: 0,
      };
      const mockProject = {
        id: 'project-1',
        storyboard: [mockScene1, mockScene2],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);
      configServiceMock.isGeneratedScene.mockReturnValue(true);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const workflowStatusMock = {
        sink: {output: {'0': {video: [{file: 'final.mp4'}]}}},
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        workflowStatusMock as any,
      );
      vi.mocked(storage.getDownloadURL).mockResolvedValue(
        'http://mock-video-url',
      );

      let capturedArrangement: any;
      vi.spyOn(service, 'startCombineScenesWorkflow').mockImplementation(
        async (arr: any) => {
          capturedArrangement = arr;
          return of({executionId: 'mock-execution-id'}) as any;
        },
      );

      await service.combineScenes();

      expect(capturedArrangement).toBeTruthy();
      expect(capturedArrangement.length).toBe(2);
      expect(capturedArrangement[0].skip_time).toBe(2);
      expect(capturedArrangement[0].duration).toBe(3);
      expect(capturedArrangement[0].transition).toBe('fade');
      expect(capturedArrangement[0].transition_overlap).toBe(1);
      expect(capturedArrangement[1].file_path).toBe('mock-path/video2.mp4');
    });

    it('should handle workflow start failure and show error snackbar and add failed render run', async () => {
      const mockProject = {
        id: 'project-1',
        storyboard: [],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      vi.spyOn(service, 'startCombineScenesWorkflow').mockResolvedValue(
        undefined,
      );

      await service.combineScenes();

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Failed to start workflow',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'Failed to start workflow',
        }),
      );
    });

    it('should handle workflow execution error and show error snackbar and add failed render run', async () => {
      const mockProject = {
        id: 'project-1',
        storyboard: [],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      vi.spyOn(service, 'startCombineScenesWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: {
          output: {
            '0': {
              video: [{_error: 'Mock combine error'}],
            },
          },
        },
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.combineScenes();

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Mock combine error',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'Mock combine error',
        }),
      );
    });

    it('should handle workflow completed without output and show error snackbar and add failed render run', async () => {
      const mockProject = {
        id: 'project-1',
        storyboard: [],
        audioTracks: [],
        visualOverlays: [],
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      vi.spyOn(service, 'startCombineScenesWorkflow').mockResolvedValue(
        of({executionId: 'mock-execution-id'}) as any,
      );

      const mockWorkflowStatus = {
        sink: undefined,
      };
      vi.spyOn(service, 'pollWorkflow').mockResolvedValue(
        mockWorkflowStatus as any,
      );

      await service.combineScenes();

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Workflow completed without output',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      expect(configServiceMock.addRenderRun).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'Workflow completed without output',
        }),
      );
    });
  });

  describe('startStoryboardWorkflow', () => {
    it('should call startWorkflow and return observable', async () => {
      const products = [
        {id: 1, images: [{path: 'img1'}], description: 'prod1'},
      ];
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue('mock-briefing-path');

      const result = await service.startStoryboardWorkflow(
        products as any,
        'mock briefing',
        'none',
      );

      expect(result).toBeTruthy();
      expect(httpClientMock.post).toHaveBeenCalled();
    });

    it('should handle error and return undefined', async () => {
      const products = [
        {id: 1, images: [{path: 'img1'}], description: 'prod1'},
      ];
      vi.spyOn(service, 'uploadText').mockRejectedValue(
        new Error('Upload failed'),
      );

      const result = await service.startStoryboardWorkflow(
        products as any,
        'mock briefing',
        'none',
      );

      expect(result).toBeUndefined();
    });

    it('should not upload briefing if it is empty', async () => {
      const products = [
        {id: 1, images: [{path: 'img1'}], description: 'prod1'},
      ];
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText');

      await service.startStoryboardWorkflow(products as any, '', 'none');

      expect(service.uploadText).not.toHaveBeenCalled();
      expect(httpClientMock.post).toHaveBeenCalled();
    });

    it('should propagate error if startWorkflow fails', async () => {
      const products = [
        {id: 1, images: [{path: 'img1'}], description: 'prod1'},
      ];
      vi.spyOn(service, 'uploadText').mockResolvedValue('mock-briefing-path');
      vi.spyOn(service as any, 'startWorkflow').mockRejectedValue(
        new Error('Workflow start failed'),
      );

      await expect(
        service.startStoryboardWorkflow(
          products as any,
          'mock briefing',
          'none',
        ),
      ).rejects.toThrow('Workflow start failed');
    });
  });

  describe('startCombineScenesWorkflow', () => {
    it('should call startWorkflow and return observable', async () => {
      const arrangement = [
        {
          file_type: 'video',
          file_path: 'path',
          start_time: 0,
          skip_time: 0,
          duration: 5,
        },
      ];
      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      const result = await service.startCombineScenesWorkflow(
        arrangement as any,
        false,
      );

      expect(result).toBeTruthy();
      expect(httpClientMock.post).toHaveBeenCalled();
    });

    it('should map 1080p resolution correctly', async () => {
      const arrangement = [
        {
          file_type: 'video',
          file_path: 'path',
          start_time: 0,
          skip_time: 0,
          duration: 5,
        },
      ];
      const mockProject = {
        id: 'project-1',
        resolution: '1080p',
        aspectRatio: '16:9',
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      let capturedParams: any;
      vi.spyOn(
        service as any,
        'getCombineScenesWorkflowDefinition',
      ).mockImplementation((params: any) => {
        capturedParams = params;
        return {};
      });

      await service.startCombineScenesWorkflow(arrangement as any, false);

      expect(capturedParams.resolution).toBe('1920:1080');
    });

    it('should map 4k resolution correctly', async () => {
      const arrangement = [
        {
          file_type: 'video',
          file_path: 'path',
          start_time: 0,
          skip_time: 0,
          duration: 5,
        },
      ];
      const mockProject = {
        id: 'project-1',
        resolution: '4k',
        aspectRatio: '16:9',
      };
      configServiceMock.projectConfig.value.mockReturnValue(mockProject);

      httpClientMock.post.mockReturnValue(
        of({executionId: 'mock-execution-id'}),
      );
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );

      let capturedParams: any;
      vi.spyOn(
        service as any,
        'getCombineScenesWorkflowDefinition',
      ).mockImplementation((params: any) => {
        capturedParams = params;
        return {};
      });

      await service.startCombineScenesWorkflow(arrangement as any, false);

      expect(capturedParams.resolution).toBe('3840:2160');
    });

    it('should handle error and return undefined', async () => {
      const arrangement = [
        {
          file_type: 'video',
          file_path: 'path',
          start_time: 0,
          skip_time: 0,
          duration: 5,
        },
      ];
      vi.spyOn(service, 'uploadText').mockRejectedValue(
        new Error('Upload failed'),
      );

      const result = await service.startCombineScenesWorkflow(
        arrangement as any,
        false,
      );

      expect(result).toBeUndefined();
    });

    it('should propagate error if startWorkflow fails', async () => {
      const arrangement = [
        {
          file_type: 'video',
          file_path: 'path',
          start_time: 0,
          skip_time: 0,
          duration: 5,
        },
      ];
      vi.spyOn(service, 'uploadText').mockResolvedValue(
        'mock-arrangement-path',
      );
      vi.spyOn(service as any, 'startWorkflow').mockRejectedValue(
        new Error('Workflow start failed'),
      );

      await expect(
        service.startCombineScenesWorkflow(arrangement as any, false),
      ).rejects.toThrow('Workflow start failed');
    });
  });
});
