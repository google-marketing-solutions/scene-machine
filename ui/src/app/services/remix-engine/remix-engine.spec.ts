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
import {of, take, filter, repeat, defer} from 'rxjs';
import {TestScheduler} from 'rxjs/testing';
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
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
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

    it('should poll until sink output is defined', () => {
      const testScheduler = new TestScheduler((actual: any, expected: any) => {
        expect(actual).toEqual(expected);
      });

      testScheduler.run(({expectObservable, cold}: any) => {
        const mockResponse1 = {sink: {output: undefined}};
        const mockResponse2 = {sink: {output: {'0': {video: []}}}};

        httpClientMock.get
          .mockReturnValueOnce(cold('(a|)', {a: mockResponse1}))
          .mockReturnValueOnce(cold('b', {b: mockResponse2}));

        // Recreate the pipe in the test to test it with marbles
        const poll$ = defer(() =>
          (service as any).getWorkflowStatus('mock-execution-id'),
        ).pipe(
          repeat({delay: 10}),
          take(5),
          filter((response: any) => response.sink?.output !== undefined),
          take(1),
        );

        expectObservable(poll$).toBe('----------(b|)', {b: mockResponse2});
      });
    });

    it('should throw ProjectChangedError if project changes', async () => {
      const mockResponse = {sink: {output: undefined}};
      httpClientMock.get.mockReturnValue(of(mockResponse));
      configServiceMock.projectConfig.value.mockReturnValue({
        id: 'different-project-id',
      });

      await expect(
        service.pollWorkflow('mock-execution-id', 'mock-project-id'),
      ).rejects.toThrow('Project changed');
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

      (storage.getDownloadURL as any).mockResolvedValue('http://mock-url');

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
        resolution: 'LANDSCAPE' as any,
      });

      expect(configServiceMock.updateProjectConfig).toHaveBeenCalled();
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
      (storage.getBlob as any).mockResolvedValue(mockBlob);
      (storage.getDownloadURL as any).mockResolvedValue('http://mock-url');

      const result = await service.generateStoryboard(
        mockProducts as any,
        'mock briefing',
        'none',
      );

      expect(result).toBeTruthy();
      expect(result!.length).toBe(1);
      expect(result![0].type).toBe('generated');
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

      (storage.getDownloadURL as any).mockResolvedValue(
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
            resolution: 'LANDSCAPE' as any,
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
      (storage.getDownloadURL as any).mockResolvedValue(
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
            resolution: 'LANDSCAPE' as any,
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
      (storage.getDownloadURL as any).mockResolvedValue(
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
            resolution: 'LANDSCAPE' as any,
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
      (storage.getDownloadURL as any).mockResolvedValue(
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
            resolution: 'LANDSCAPE' as any,
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
            resolution: 'LANDSCAPE' as any,
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
      (storage.getDownloadURL as any).mockResolvedValue(
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
            resolution: 'LANDSCAPE' as any,
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
            resolution: 'LANDSCAPE' as any,
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
      (storage.getDownloadURL as any).mockResolvedValue(
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
  });
});
