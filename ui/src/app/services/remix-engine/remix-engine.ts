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

import {HttpClient} from '@angular/common/http';
import {
  EnvironmentInjector,
  inject,
  Injectable,
  runInInjectionContext,
  signal,
} from '@angular/core';
import {
  getBlob,
  getDownloadURL,
  ref,
  Storage,
  uploadBytes,
  uploadString,
} from '@angular/fire/storage';
import {MatSnackBar} from '@angular/material/snack-bar';
import {filter, firstValueFrom, Observable, repeat, retry, tap} from 'rxjs';
import {
  ASPECT_RATIO_DEVIATION_THRESHOLD,
  AudioTrack,
  Candidate,
  ConfigService,
  DEFAULT_TRANSITION_OVERLAP,
  GeneratedScene,
  Product,
  ProductImage,
  ProvidedVideoScene,
  RenderRun,
  Resolution,
  VisualOverlay,
} from '../config/config';
import {GenerateThumbnailService} from '../generate-thumbnail/generate-thumbnail';
import {
  CombineVideoArrangement as CombineScenesArrangement,
  CombineScenesWorkflowParameters,
  StoryboardGenerationWorkflowParameters,
  StoryboardItem,
  SupplyNodeResponse,
  VideoGenerationWorkflowParameters,
  WORKFLOW_STATUS_POLL_INTERVAL_MS,
  WorkflowStatusResponse,
} from './remix-engine.interface';

class ProjectChangedError extends Error {
  constructor() {
    super('Project changed, cancelling workflow polling');
    this.name = 'ProjectChangedError';
  }
}

/**
 * Service for interacting with the Remix Engine.
 */
@Injectable({
  providedIn: 'root',
})
export class RemixEngineService {
  private configService = inject(ConfigService);
  private httpClient = inject(HttpClient);
  private injector = inject(EnvironmentInjector);
  private storage = inject(Storage);
  private thumbnailService = inject(GenerateThumbnailService);

  private startWorkflow(
    workflowDefinition: object,
  ): Observable<SupplyNodeResponse> {
    return this.httpClient.post<SupplyNodeResponse>(
      `${this.configService.globalConfig.value()!.gatewayBaseUrl}/supplyNode?api_key=${this.configService.globalConfig.value()!.gatewayApiKey}`,
      workflowDefinition,
    );
  }

  private getWorkflowStatus(
    executionId: string,
  ): Observable<WorkflowStatusResponse> {
    return this.httpClient.get<WorkflowStatusResponse>(
      `${this.configService.globalConfig.value()!.gatewayBaseUrl}/getStatus?api_key=${this.configService.globalConfig.value()!.gatewayApiKey}&executionId=${executionId}&signedUrls=false&gcsBucket=${this.configService.globalConfig.value()!.gcsBucket}`,
    );
  }

  async pollWorkflow(
    workflowId: string,
    projectId: string,
  ): Promise<WorkflowStatusResponse> {
    return await firstValueFrom(
      this.getWorkflowStatus(workflowId).pipe(
        retry({delay: WORKFLOW_STATUS_POLL_INTERVAL_MS}),
        tap(() => {
          if (this.configService.projectConfig.value().id !== projectId) {
            throw new ProjectChangedError();
          }
        }),
        filter(response => response.sink?.output !== undefined),
        repeat({delay: WORKFLOW_STATUS_POLL_INTERVAL_MS}),
      ),
    );
  }

  async startVideoGenerationWorkflow(
    scene: GeneratedScene,
    forceExecution: boolean,
  ): Promise<Observable<SupplyNodeResponse> | undefined> {
    const workflowId = crypto.randomUUID();
    const globalConfig = this.configService.globalConfig.value();
    const projectConfig = this.configService.projectConfig.value();
    const resolution = projectConfig.resolution;
    try {
      const promptPath = await this.uploadText(scene.prompt, 'video-prompt');
      return this.startWorkflow(
        this.getVideoGenerationWorkflowDefinition({
          workflowId,
          gcpProject: globalConfig!.gcpProject,
          gcpLocation: globalConfig!.gcpLocation,
          gcsBucket: globalConfig!.gcsBucket,
          forceExecution,
          numberOfVideos: projectConfig.numberOfCandidates,
          videoDuration: projectConfig.candidateDurationSeconds,
          generateAudio: projectConfig.generateAudio,
          veoModel: projectConfig.model,
          veoLocation: globalConfig!.veoLocation,
          aspectRatio: projectConfig!.aspectRatio,
          productImagePath: scene.referenceImage?.path,
          promptPath,
          resolution,
          tasksQueuePrefix: globalConfig!.tasksQueuePrefix,
        }),
      );
    } catch (error) {
      console.error(error);
    }
    return;
  }

  async startStoryboardWorkflow(
    products: Product[],
    briefing: string,
    imageDecision: 'none' | 'crop' | 'outpaint',
    forceExecution = false,
  ): Promise<Observable<SupplyNodeResponse> | undefined> {
    const workflowId = crypto.randomUUID();
    try {
      let briefingPath = undefined;
      if (briefing !== '') {
        briefingPath = await this.uploadText(briefing, 'briefing');
      }
      return this.startWorkflow(
        this.getStoryboardWorkflowDefinition(
          {
            workflowId,
            gcpProject: this.configService.globalConfig.value()!.gcpProject,
            gcpLocation: this.configService.globalConfig.value()!.gcpLocation,
            gcsBucket: this.configService.globalConfig.value()!.gcsBucket,
            forceExecution,
            tasksQueuePrefix:
              this.configService.globalConfig.value()!.tasksQueuePrefix,
            briefingPath,
            geminiModel: this.configService.globalConfig.value()!.geminiModel,
            imageDecision,
            geminiLocation:
              this.configService.globalConfig.value()!.geminiLocation,
            aspectRatio: this.configService.projectConfig.value().aspectRatio,
          },
          products,
        ),
      );
    } catch (error) {
      console.error(error);
    }
    return;
  }

  async startCombineScenesWorkflow(
    arrangement: CombineScenesArrangement[],
    forceExecution = false,
  ) {
    const workflowId = crypto.randomUUID();
    const projectConfig = this.configService.projectConfig.value();
    const aspectRatio = projectConfig.aspectRatio;
    let resolution = '1280:720';
    if (projectConfig.resolution === '720p') {
      resolution = aspectRatio === '16:9' ? '1280:720' : '720:1280';
    } else if (projectConfig.resolution === '1080p') {
      resolution = aspectRatio === '16:9' ? '1920:1080' : '1080:1920';
    } else if (projectConfig.resolution === '4k') {
      resolution = aspectRatio === '16:9' ? '3840:2160' : '2160:3840';
    }
    try {
      const arrangementPath = await this.uploadText(
        JSON.stringify(arrangement),
        'arrangement',
      );
      return this.startWorkflow(
        this.getCombineScenesWorkflowDefinition({
          workflowId,
          gcpProject: this.configService.globalConfig.value()!.gcpProject,
          gcpLocation: this.configService.globalConfig.value()!.gcpLocation,
          gcsBucket: this.configService.globalConfig.value()!.gcsBucket,
          forceExecution,
          tasksQueuePrefix:
            this.configService.globalConfig.value()!.tasksQueuePrefix,
          arrangementPath,
          resolution,
          encodingSpeed: this.configService.globalConfig.value()!.encodingSpeed,
          qualityLevel: this.configService.globalConfig.value()!.qualityLevel,
        }),
      );
    } catch (error) {
      console.error(error);
    }
    return;
  }

  private getStoryboardWorkflowDefinition(
    params: StoryboardGenerationWorkflowParameters,
    products: Product[],
  ) {
    const workflowDefinition = {
      workflowDefinition: {
        root: {
          action: 'pass',
          input: {
            images: null,
            user_prompt: null,
          },
          types: {
            images: 'image',
            user_prompt: 'string',
          },
        },
        n_outpaint: {
          action: 'outpaint_image',
          input: {
            image: {
              node: 'root',
              output: 'images',
            },
          },
          parameters: {
            target_ratio: params.aspectRatio,
          },
        },
        n_storyboard: {
          action: 'generate_storyboard',
          input: {
            images: {
              node: 'n_outpaint',
              output: 'outpainted_image',
            },
            user_prompt: {
              node: 'root',
              output: 'user_prompt',
            },
          },
          parameters: {
            gemini_model: params.geminiModel,
            gemini_model_location: params.geminiLocation,
          },
          dimensionsConsumed: [
            'product_id',
            'image_id',
            'product_description',
            'image_instruction',
          ],
        },
        sink: {
          action: 'pass',
          input: {
            outpainted_images: {
              node: 'n_outpaint',
              output: 'outpainted_image',
            },
            storyboard: {
              node: 'n_storyboard',
              output: 'storyboard',
            },
          },
        },
      },
      nodeId: 'root',
      workflowId: params.workflowId,
      forceExecution: params.forceExecution,
      workflowParams: {
        gcpProject: params.gcpProject,
        gcpLocation: params.gcpLocation,
        gcsBucket: params.gcsBucket,
        tasksQueuePrefix: params.tasksQueuePrefix,
      },
      inputFiles: {
        images: [] as Array<{
          file: string;
          product_id: string;
          description: string;
          image_id: string;
          image_instruction: string;
        }>,
        user_prompt: [] as Array<{file: string}>,
      },
    };

    for (const product of products) {
      for (const [index, image] of product.images.entries()) {
        let imageInstruction = params.imageDecision;
        if (image.aspectRatioDeviation && image.aspectRatioDeviation === 0) {
          imageInstruction = 'none';
        } else if (
          image.aspectRatioDeviation &&
          image.aspectRatioDeviation <= ASPECT_RATIO_DEVIATION_THRESHOLD
        ) {
          imageInstruction = 'crop';
        }
        workflowDefinition.inputFiles.images.push({
          file: image.path,
          product_id: product.id.toString(),
          image_id: (index + 1).toString(),
          description: product.description ?? '',
          image_instruction: imageInstruction,
        });
      }
    }
    if (params.briefingPath) {
      workflowDefinition.inputFiles.user_prompt.push({
        file: params.briefingPath,
      });
    }
    return workflowDefinition;
  }

  private getVideoGenerationWorkflowDefinition(
    params: VideoGenerationWorkflowParameters,
  ) {
    const productImages = [];
    if (params.productImagePath !== undefined) {
      productImages.push({
        file: params.productImagePath,
        image_id: '1',
      });
    }
    return {
      workflowDefinition: {
        root: {
          action: 'pass',
          input: {
            product_image: null,
            prompt: null,
          },
          types: {
            product_image: 'image',
            prompt: 'string',
          },
        },
        n_0: {
          action: 'generate_video',
          input: {
            prompt: {
              node: 'root',
              output: 'prompt',
            },
            image: {
              node: 'root',
              output: 'product_image',
            },
          },
          parameters: {
            video_variant_quantity: Number(params.numberOfVideos),
            aspect_ratio: params.aspectRatio,
            duration_seconds: Number(params.videoDuration),
            gcp_project: '',
            gcp_location: params.veoLocation,
            model: params.veoModel,
            generate_audio: params.generateAudio,
            resolution: params.resolution,
          },
        },
        sink: {
          action: 'pass',
          input: {
            video: {
              node: 'n_0',
              output: 'video',
            },
          },
        },
      },
      nodeId: 'root',
      workflowId: params.workflowId,
      forceExecution: params.forceExecution,
      workflowParams: {
        gcpProject: params.gcpProject,
        gcpLocation: params.gcpLocation,
        gcsBucket: params.gcsBucket,
        tasksQueuePrefix: params.tasksQueuePrefix,
      },
      inputFiles: {
        product_image: productImages,
        prompt: [
          {
            file: params.promptPath,
            image_id: '1',
          },
        ],
      },
    };
  }

  private getCombineScenesWorkflowDefinition(
    params: CombineScenesWorkflowParameters,
  ) {
    return {
      workflowDefinition: {
        root: {
          action: 'pass',
          input: {
            arrangement: null,
          },
          types: {
            arrangement: 'object',
          },
        },
        n_0: {
          action: 'combine_video',
          input: {
            arrangement: {
              node: 'root',
              output: 'arrangement',
            },
          },
          parameters: {
            resolution: params.resolution,
            encoding_speed: params.encodingSpeed,
            quality_level: params.qualityLevel,
          },
        },
        sink: {
          action: 'pass',
          input: {
            video: {
              node: 'n_0',
              output: 'video',
            },
          },
        },
      },
      nodeId: 'root',
      workflowId: params.workflowId,
      forceExecution: params.forceExecution,
      workflowParams: {
        gcpProject: params.gcpProject,
        gcpLocation: params.gcpLocation,
        gcsBucket: params.gcsBucket,
        tasksQueuePrefix: params.tasksQueuePrefix,
      },
      inputFiles: {
        arrangement: [
          {
            file: params.arrangementPath,
          },
        ],
      },
    };
  }

  async uploadText(content: string, fileName: string) {
    const contentHash = await this.generateHash(content);
    return runInInjectionContext(this.injector, async () => {
      const storageRef = ref(
        this.storage,
        `remix-input/${fileName}-${contentHash}.txt`,
      );
      const snapshot = await uploadString(storageRef, content, 'raw', {
        contentType: 'text/plain',
      });
      return snapshot.metadata.fullPath;
    });
  }

  async generateHash(input: string | File) {
    let buffer;
    if (input instanceof File) {
      buffer = await input.arrayBuffer();
    } else {
      buffer = new TextEncoder().encode(input);
    }
    return Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    )
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  readonly generatingSceneIds = signal<Set<string>>(new Set());
  readonly combiningScenes = signal(false);
  private matSnackBar = inject(MatSnackBar);

  async generateCandidates(
    s: GeneratedScene,
    {
      durationSeconds,
      model,
      generateAudio,
      resolution,
    }: {
      durationSeconds: number;
      model: string;
      generateAudio: boolean;
      resolution: Resolution;
    },
  ) {
    const projectId = this.configService.projectConfig.value().id;
    if (this.generatingSceneIds().has(s.id)) {
      return;
    }
    const scene = structuredClone(s);
    this.generatingSceneIds.update(ids => {
      const newIds = new Set(ids);
      newIds.add(scene.id);
      return newIds;
    });

    let executionId = '';
    try {
      const response = await this.startVideoGenerationWorkflow(scene, true);
      if (!response) {
        throw new Error('Failed to start workflow');
      }
      executionId = (await firstValueFrom(response)).executionId;
      console.debug(
        'Video generation workflow started:',
        `${window.location.origin}/status?executionId=${executionId}`,
      );
      const workflowStatus = await this.pollWorkflow(executionId, projectId);
      if (workflowStatus.sink?.output['0']['video'][0]['_error']) {
        const errorMsg =
          workflowStatus.sink?.output['0']['video'][0]['_error'] ||
          'Unknown error';
        throw new Error(errorMsg);
      }
      if (!workflowStatus.sink) {
        throw new Error('Workflow completed without output');
      }
      const currentMaxRun = scene.candidates?.length
        ? Math.max(...scene.candidates.map(c => c.runNumber))
        : 0;
      const newCandidates = await Promise.all(
        workflowStatus.sink.output['0']['video'].map(async e => {
          const path = e.file!;
          const url = await runInInjectionContext(this.injector, () => {
            const reference = ref(this.storage, path);
            return getDownloadURL(reference);
          });

          const lowQualityThumbnail = await this.thumbnailService
            .generateLowQualityThumbnail(url, 'video')
            .then(blob => this.thumbnailService.toBase64(blob))
            .then(base64 => base64)
            .catch(e => {
              console.log(e);
              return '';
            });
          const highQualityThumbnail = await this.thumbnailService
            .generateHighQualityThumbnail(url, 'video')
            .then(blob => this.thumbnailService.toFile(blob))
            .then(file => this.uploadThumbnail(file))
            .then(resp => resp)
            .catch(e => {
              console.log(e);
              return {path: '', url: ''};
            });

          const newCandidate: Candidate = {
            runNumber: currentMaxRun + 1,
            durationSeconds,
            prompt: scene.prompt,
            model,
            generateAudio,
            resolution,
            video: {url, path},
            lowQualityThumbnail: lowQualityThumbnail,
            highQualityThumbnail: highQualityThumbnail,
          };
          if (scene.referenceImage) {
            newCandidate.referenceImage = {...scene.referenceImage};
          }
          return newCandidate;
        }),
      );
      if (newCandidates.length === 0) {
        return;
      }
      const candidates = [...(scene.candidates ?? []), ...newCandidates];
      const scenes = this.configService.projectConfig
        .value()
        .storyboard.map(s =>
          s.id === scene.id && this.configService.isGeneratedScene(s)
            ? {
                ...s,
                candidates,
                selectedCandidateIndex: s.selectedCandidateIndex ?? 0,
              }
            : s,
        );
      this.configService.updateProjectConfig({storyboard: scenes});
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        return;
      } else if (error instanceof Error) {
        console.error('Video generation error:', {executionId, error});
        console.error(
          'Debug URL:',
          `${window.location.origin}/status?executionId=${executionId}`,
        );
        this.matSnackBar.open(
          'Failed to generate video(s). ' + error.message,
          'Dismiss',
          {
            panelClass: ['error-snackbar'],
          },
        );
      }
    } finally {
      this.generatingSceneIds.update(ids => {
        const newIds = new Set(ids);
        newIds.delete(scene.id);
        return newIds;
      });
    }
  }

  async generateStoryboard(
    products: Product[],
    briefing: string,
    imageDecision: 'none' | 'crop' | 'outpaint',
  ) {
    const projectId = this.configService.projectConfig.value().id;
    let executionId;
    try {
      const response = await this.startStoryboardWorkflow(
        products,
        briefing,
        imageDecision,
      );

      if (!response) {
        throw new Error('Failed to start workflow');
      }
      executionId = (await firstValueFrom(response)).executionId;
      console.debug(
        'Storyboard workflow started:',
        `${window.location.origin}/status?executionId=${executionId}`,
      );
      const workflowStatus = await this.pollWorkflow(executionId, projectId);
      if (workflowStatus.sink?.output['0']['storyboard'][0]['_error']) {
        const errorMsg =
          workflowStatus.sink?.output['0']['storyboard'][0]['_error'] ||
          'Unknown error';
        throw new Error(errorMsg);
      }
      if (!workflowStatus.sink) {
        throw new Error('Workflow completed without output');
      }
      const storyboardJsonFile =
        workflowStatus.sink.output['0']['storyboard'][0]?.file;
      if (!storyboardJsonFile) {
        throw new Error('Storyboard JSON file not found');
      }

      let storyboardJson;
      try {
        storyboardJson = await runInInjectionContext(
          this.injector,
          async () => {
            const reference = ref(this.storage, storyboardJsonFile);
            const blob = await getBlob(reference);
            return JSON.parse(await blob.text());
          },
        );

        if (
          !('storyboard' in storyboardJson) ||
          !Array.isArray(storyboardJson['storyboard'])
        ) {
          throw new Error('Storyboard JSON file is missing storyboard');
        }
      } catch (error) {
        console.error('Failed to parse storyboard JSON:', error);
        throw new Error('Failed to parse storyboard JSON');
      }

      const outpaintedImages =
        workflowStatus.sink.output['0']['outpainted_images'];
      const productsToOutpaintedImages: Record<
        string,
        Record<string, ProductImage>
      > = {};
      for (const image of outpaintedImages) {
        if (image.product_id !== undefined) {
          const productId = String(image.product_id);
          const imagePath = String(image.file);
          if (!productsToOutpaintedImages[productId]) {
            productsToOutpaintedImages[productId] = {};
          }
          productsToOutpaintedImages[productId][String(image.image_id)] = {
            url: await runInInjectionContext(this.injector, async () => {
              const reference = ref(this.storage, imagePath);
              return getDownloadURL(reference);
            }),
            path: imagePath,
          };
        }
      }

      let sceneIdCounter = 1;

      return storyboardJson['storyboard'].map((s: StoryboardItem) => {
        const referenceImage =
          productsToOutpaintedImages[s.product_id][s.image_id];

        return {
          id: (sceneIdCounter++).toString(),
          type: 'generated',
          name: s.scene_name,
          prompt: s.video_prompt,
          duration: this.configService.globalConfig.value()!.duration,
          model: this.configService.globalConfig.value()!.veoModel,
          numberOfCandidates:
            this.configService.globalConfig.value()!.numberOfCandidates,
          generateAudio: this.configService.globalConfig.value()!.generateAudio,
          referenceImage: {
            url: referenceImage.url,
            path: referenceImage.path,
          },
        } as GeneratedScene;
      });
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        return;
      } else if (error instanceof Error) {
        console.error('Storyboard generation error:', error);
        if (executionId) {
          console.error(
            'Debug URL:',
            `${window.location.origin}/status?executionId=${executionId}`,
          );
        }
        this.matSnackBar.open(
          'Failed to generate storyboard. ' + error.message,
          'Dismiss',
          {
            panelClass: ['error-snackbar'],
          },
        );
      }
      return;
    }
  }

  async combineScenes(forceExecution = false) {
    const projectId = this.configService.projectConfig.value().id;
    let executionId;
    try {
      this.combiningScenes.set(true);
      const scenes = this.configService.projectConfig.value().storyboard;
      const audioTracks = this.configService.projectConfig.value().audioTracks;
      const visualOverlays =
        this.configService.projectConfig.value().visualOverlays;
      const arrangement = this.getCombineScenesArrangements(
        scenes,
        audioTracks,
        visualOverlays,
      );
      const response = await this.startCombineScenesWorkflow(
        arrangement,
        forceExecution,
      );
      if (!response) {
        throw new Error('Failed to start workflow');
      }
      executionId = (await firstValueFrom(response)).executionId;
      console.debug(
        'Combine scenes workflow started:',
        `${window.location.origin}/status?executionId=${executionId}`,
      );
      const workflowStatus = await this.pollWorkflow(executionId, projectId);
      if (workflowStatus.sink?.output['0']['video'][0]['_error']) {
        const errorMsg =
          workflowStatus.sink?.output['0']['video'][0]['_error'] ||
          'Unknown error';
        throw new Error(errorMsg);
      }
      if (!workflowStatus.sink) {
        throw new Error('Workflow completed without output');
      }
      const videoPath = workflowStatus.sink.output['0']['video'][0]['file'];
      const videoUrl = await runInInjectionContext(this.injector, () => {
        const reference = ref(this.storage, videoPath);
        return getDownloadURL(reference);
      });
      this.configService.addRenderRun({
        createdAt: new Date(),
        outputVideo: {
          path: videoPath!,
          url: videoUrl,
        },
        wasPlayed: false,
      });
      this.combiningScenes.set(false);
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        return;
      } else if (error instanceof Error) {
        console.error('Combine scenes error:', error);
        if (executionId) {
          console.error(
            'Debug URL:',
            `${window.location.origin}/status?executionId=${executionId}`,
          );
        }
        this.matSnackBar.open(
          error.message || 'Failed to combine scenes',
          'Dismiss',
          {
            panelClass: ['error-snackbar'],
          },
        );
        const renderRun: RenderRun = {
          createdAt: new Date(),
          errorMessage: error.message,
        };
        this.configService.addRenderRun(renderRun);
        this.combiningScenes.set(false);
      }
    }
  }

  private getSceneVideoDuration(
    scene: GeneratedScene | ProvidedVideoScene,
    skipTime: number,
  ) {
    if (this.configService.isGeneratedScene(scene)) {
      const candidate = scene.candidates![scene.selectedCandidateIndex!];
      const end = candidate.trim?.end ?? candidate.durationSeconds;
      return end - skipTime;
    }
    if (this.configService.isProvidedVideoScene(scene)) {
      const end = scene.trim?.end ?? scene.durationSeconds!;
      return end - skipTime;
    }
    return 0;
  }

  private getCombineScenesArrangements(
    scenes: Array<GeneratedScene | ProvidedVideoScene>,
    audioTracks: AudioTrack[],
    visualOverlays: VisualOverlay[],
  ) {
    const arrangement: CombineScenesArrangement[] = [];
    const validScenes = scenes.filter(scene => {
      if (this.configService.isProvidedVideoScene(scene)) {
        if (scene.durationSeconds) {
          return scene.video?.path;
        }
      } else if (this.configService.isGeneratedScene(scene)) {
        if (scene.candidates && scene.selectedCandidateIndex !== undefined) {
          return scene.candidates[scene.selectedCandidateIndex].video?.path;
        }
      }
      return false;
    });
    for (const scene of validScenes) {
      let gcsVideoPath;
      let skipTime = 0;
      let duration = 0;
      if (this.configService.isProvidedVideoScene(scene)) {
        gcsVideoPath = scene.video?.path;
        skipTime = scene.trim?.start ?? 0;
        duration = this.getSceneVideoDuration(scene, skipTime);
      } else if (this.configService.isGeneratedScene(scene)) {
        const candidate = scene.candidates![scene.selectedCandidateIndex!];
        gcsVideoPath = candidate.video?.path;
        skipTime = candidate.trim?.start ?? 0;
        duration = this.getSceneVideoDuration(scene, skipTime);
      }
      if (!gcsVideoPath) {
        console.log(`No video for scene ${scene.id}`);
        continue;
      }
      const videoArrangement: CombineScenesArrangement = {
        file_type: 'video',
        file_path: gcsVideoPath,
        start_time: 0,
        skip_time: skipTime,
        duration,
      };
      if (scene.transition) {
        videoArrangement.transition = scene.transition;
        videoArrangement.transition_overlap =
          scene.transitionOverlap ?? DEFAULT_TRANSITION_OVERLAP;
      }
      arrangement.push(videoArrangement);

      if (duration <= 0) {
        console.error(
          `ERROR:Unknown scene #${scene.id} video duration: ${duration}, using default value instead.`,
        );
      }
    }

    for (const track of audioTracks) {
      arrangement.push({
        file_type: 'audio',
        file_path: track.file.path,
        start_time: track.startSeconds,
        skip_time: 0, // Not used at the moment
        duration: track.durationSeconds,
      });
    }

    for (const overlay of visualOverlays) {
      arrangement.push({
        file_type: 'image',
        file_path: overlay.file.path,
        start_time: overlay.startSeconds,
        skip_time: 0, // Not used at the moment
        duration: overlay.durationSeconds,
        width: overlay.widthPixels,
        height: overlay.heightPixels,
        offset_x: overlay.pixelsFromLeft,
        offset_y: overlay.pixelsFromTop,
      });
    }
    return arrangement;
  }

  async uploadMedia(media: File, path: string = 'remix-input') {
    const fileNameParts = media.name.split('.');
    const extension = fileNameParts.pop();
    const contentHash = await this.generateHash(media);
    const fileName = `${fileNameParts.join('.')}-${contentHash}.${extension}`;
    return await runInInjectionContext(this.injector, async () => {
      const storageRef = ref(this.storage, `${path}/${fileName}`);
      try {
        const downloadUrl = await getDownloadURL(storageRef);
        return {
          path: storageRef.fullPath,
          url: downloadUrl,
        };
      } catch {
        const snapshot = await runInInjectionContext(this.injector, () =>
          uploadBytes(storageRef, media, {
            contentType: media.type,
          }),
        );
        const url = await runInInjectionContext(this.injector, () =>
          getDownloadURL(storageRef),
        );
        return {
          path: snapshot.metadata.fullPath,
          url,
        };
      }
    });
  }

  async uploadThumbnail(media: File) {
    return this.uploadMedia(media, 'thumbnail');
  }
}
