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

import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {
  MatSnackBar,
  MatSnackBarRef,
  TextOnlySnackBar,
} from '@angular/material/snack-bar';
import {
  filter,
  firstValueFrom,
  Observable,
  retry,
  tap,
  throwError,
  timeout,
  timer,
  switchMap,
  take,
} from 'rxjs';
import {env} from '../../../env';
import {ClientMediaService} from '../client-media/client-media';
import {MediaService} from '../media/media';
import {
  ASPECT_RATIO_DEVIATION_THRESHOLD,
  AudioTrack,
  Candidate,
  ConfigService,
  DEFAULT_TRANSITION_OVERLAP,
  GcsFile,
  GeneratedScene,
  PendingGeneration,
  PendingRender,
  Product,
  ProductImage,
  ProvidedVideoScene,
  RenderRun,
  findTransitionContractViolation,
  resolveSceneRenderClip,
  Resolution,
  VisualOverlay,
} from '../config/config';
import {
  CombineVideoArrangement as CombineScenesArrangement,
  CombineScenesWorkflowParameters,
  NodeItem,
  SIGN_URL_RETRY_DELAYS_MS,
  StoryboardGenerationWorkflowParameters,
  StoryboardItem,
  SupplyNodeResponse,
  VideoEditWorkflowParameters,
  VideoGenerationWorkflowParameters,
  WORKFLOW_STATUS_POLL_INTERVAL_MS,
  WORKFLOW_STATUS_POLL_TIMEOUT_MS,
  WorkflowStatusResponse,
} from './remix-engine.interface';

class ProjectChangedError extends Error {
  constructor() {
    super('Project changed, cancelling workflow polling');
    this.name = 'ProjectChangedError';
  }
}

class RenderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderContractError';
  }
}

/**
 * Thrown when a status poll exceeds WORKFLOW_STATUS_POLL_TIMEOUT_MS without the
 * workflow's terminal sink output arriving. Treated like ProjectChangedError —
 * the in-flight marker is kept so reopening the project resumes — but, unlike a
 * deliberate navigation, it surfaces a user-facing message because the run may
 * be stuck (e.g. an unrecovered IAP session) rather than merely backgrounded.
 */
class PollTimeoutError extends Error {
  constructor() {
    super('Workflow status polling timed out');
    this.name = 'PollTimeoutError';
  }
}

/**
 * Thrown when a generation COMPLETED (the workflow produced video outputs) but
 * signing every output's URL failed transiently — e.g. a brief /api/signUrl
 * blip after the run finished. Treated like PollTimeoutError (keep the
 * pendingGeneration marker so reopening re-collects the finished videos) rather
 * than a definitive failure, which would delete the marker and permanently lose
 * a successful generation. (E3)
 */
class CandidateSigningError extends Error {
  constructor(readonly reason: unknown) {
    super('Failed to sign generated video URLs');
    this.name = 'CandidateSigningError';
  }
}

/**
 * Thrown when a COMPLETED combine-scenes render's output URL cannot be signed
 * right now (transient /api/signUrl failure). The render-path analogue of
 * CandidateSigningError: callers keep the pendingRender marker so reopening the
 * project re-collects the finished video, rather than recording a definitive
 * failure that would discard a successful — and expensive — render. (E3)
 */
class RenderSigningError extends Error {
  constructor(readonly reason: unknown) {
    super('Failed to sign rendered video URL');
    this.name = 'RenderSigningError';
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
  private clientMediaService = inject(ClientMediaService);
  private mediaService = inject(MediaService);

  /**
   * Execution ids whose resume has already been kicked off this session, so
   * the effect below does not start a second poll for the same run.
   */
  private readonly resumedExecutionIds = new Set<string>();

  /** As resumedExecutionIds, but for render (combine-scenes) runs. */
  private readonly resumedRenderExecutionIds = new Set<string>();

  constructor() {
    // Resume persisted in-flight candidate generations whenever a project
    // with pendingGeneration markers is loaded (or re-loaded).
    effect(() => {
      const config = this.configService.projectConfig.value();
      // Don't resume until global config has loaded: the poll path
      // (getWorkflowStatus) reads globalConfig().gcsBucket. globalConfig is a
      // separate async resource with no default value, so a resume that fires
      // before /api/config resolves would dereference undefined and — because
      // the TypeError is swallowed by the generic error branch — clear a
      // healthy run's pendingGeneration marker. Reading globalConfig here
      // registers it as a dependency, so the effect re-runs once it loads. (E1)
      if (!this.configService.globalConfig.value()) {
        return;
      }
      // untracked: generatingSceneIds changes must not re-run this scan.
      const generating = untracked(this.generatingSceneIds);
      for (const scene of config.storyboard) {
        if (!this.configService.isGeneratedScene(scene)) {
          continue;
        }
        const pending = scene.pendingGeneration;
        if (
          !pending ||
          this.resumedExecutionIds.has(pending.executionId) ||
          generating.has(scene.id)
        ) {
          continue;
        }
        this.resumedExecutionIds.add(pending.executionId);
        void this.resumeGeneration(config.id, scene.id, pending);
      }

      // Resume a persisted in-flight render the same way, guarded per-execution
      // by resumedRenderExecutionIds. A live combineScenes() run claims its own
      // executionId in that set the moment it starts, so it is never resumed as
      // a duplicate — without coupling this to the SHARED combiningScenes flag,
      // which would wrongly block resuming a DIFFERENT project's render while
      // any render is in flight. (E2)
      const pendingRender = config.pendingRender;
      if (
        pendingRender &&
        !this.resumedRenderExecutionIds.has(pendingRender.executionId)
      ) {
        this.resumedRenderExecutionIds.add(pendingRender.executionId);
        void this.resumeRender(config.id, pendingRender);
      }
    });
  }

  private startWorkflow(
    workflowDefinition: object,
  ): Observable<SupplyNodeResponse> {
    // Same-origin: the app service serves the SPA and /api from one Cloud Run
    // service, so the control plane is always reached relative to the page.
    const url = '/api/supplyNode';
    return this.httpClient.post<SupplyNodeResponse>(url, workflowDefinition);
  }

  private getWorkflowStatus(
    executionId: string,
  ): Observable<WorkflowStatusResponse> {
    const globalConfig = this.configService.globalConfig.value();
    if (!globalConfig) {
      // The resume effect gates on this, and live generation only runs after
      // config has loaded, so this is a defensive guard for any future caller:
      // fail loud instead of dereferencing undefined with a non-null assertion.
      return throwError(() => new Error('Global config not loaded'));
    }
    const url = `/api/getStatus?executionId=${executionId}&signedUrls=false&gcsBucket=${globalConfig.gcsBucket}`;
    return this.httpClient.get<WorkflowStatusResponse>(url);
  }

  async pollWorkflow(
    workflowId: string,
    projectId: string,
  ): Promise<WorkflowStatusResponse> {
    return await firstValueFrom(
      timer(0, WORKFLOW_STATUS_POLL_INTERVAL_MS).pipe(
        switchMap(() => this.getWorkflowStatus(workflowId)),
        retry({
          delay: error => {
            if (
              env.controlPlaneMode === 'iap' &&
              error instanceof HttpErrorResponse &&
              error.status === 401
            ) {
              // IAP session-cookie expiry: open ONE session-refresh tab per
              // expiry episode. The 401 consumes no retry budget and keeps
              // the normal poll cadence, so the loop survives arbitrarily
              // long expiry windows instead of dying silently.
              this.onIapSessionExpiry();
            }
            // Non-401 (and non-iap) errors take exactly today's path: an
            // unconditional retry after the poll interval.
            return timer(WORKFLOW_STATUS_POLL_INTERVAL_MS);
          },
        }),
        tap(() => {
          if (this.iapExpiryEpisodeActive) {
            // A poll succeeded again: the session is valid — close the
            // expiry episode. A later expiry is a new episode (and may
            // open one new refresh tab).
            this.iapExpiryEpisodeActive = false;
            this.iapExpirySnackBarRef?.dismiss();
            this.iapExpirySnackBarRef = undefined;
          }
          if (this.configService.projectConfig.value().id !== projectId) {
            throw new ProjectChangedError();
          }
        }),
        filter(response => response.sink?.output !== undefined),
        // Overall backstop so a poll can never spin forever (e.g. an IAP
        // session that never recovers, or a backend run that ends without
        // writing its sink output). Placed AFTER filter, so the clock measures
        // time-to-terminal-output and is unaffected by the inner retry loop;
        // it fires once if no sink output arrives within the window. The catch
        // sites treat PollTimeoutError like ProjectChangedError (keep the marker
        // so a reopen resumes), plus a user-facing "taking longer" message.
        timeout({
          first: WORKFLOW_STATUS_POLL_TIMEOUT_MS,
          with: () => throwError(() => new PollTimeoutError()),
        }),
        take(1),
      ),
    );
  }

  /**
   * True while an IAP session-expiry episode is in progress (401s on the
   * status polls). Service-level so that N concurrent polls share one
   * episode: at most one refresh tab is opened per expiry, not per poll.
   */
  private iapExpiryEpisodeActive = false;
  private iapExpirySnackBarRef?: MatSnackBarRef<TextOnlySnackBar>;

  /**
   * Handles an HTTP 401 on a status poll under the IAP control plane (the
   * session cookie expired; the interceptor's X-Requested-With makes IAP
   * return 401 instead of a 302 the XHR cannot follow). Opens the IAP
   * session-refresh flow in a new tab once per episode and shows a
   * persistent snackbar. Its "Sign in" action re-opens the tab — the
   * window.open below runs from a timer callback (not a user gesture) and
   * may be popup-blocked; the snackbar action IS a gesture.
   */
  private onIapSessionExpiry() {
    if (this.iapExpiryEpisodeActive) {
      return;
    }
    this.iapExpiryEpisodeActive = true;
    const refreshUrl = `${window.location.origin}/?gcp-iap-mode=DO_SESSION_REFRESH`;
    window.open(refreshUrl);
    this.iapExpirySnackBarRef = this.matSnackBar.open(
      'Your session expired — sign in again in the opened tab. ' +
        'Generation will resume automatically.',
      'Sign in',
      {panelClass: ['error-snackbar']},
    );
    this.iapExpirySnackBarRef.onAction().subscribe(() => {
      window.open(refreshUrl);
    });
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
          // A model whose catalog entry always generates audio overrides the
          // project's own toggle (the toggle itself is shown on and disabled
          // for such a model, but the posted value must match regardless).
          generateAudio:
            this.configService.audioLocked() || projectConfig.generateAudio,
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
            imageModel: this.configService.globalConfig.value()!.imageModel,
            imageLocation:
              this.configService.globalConfig.value()!.imageLocation,
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
            image_model: params.imageModel,
            image_model_location: params.imageLocation,
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
          product_description: string;
          image_id: string;
          image_instruction: string;
        }>,
        user_prompt: [] as Array<{file: string}>,
      },
    };

    for (const product of products) {
      for (const [index, image] of product.images.entries()) {
        let imageInstruction = params.imageDecision;
        if (image.aspectRatioDeviation === 0) {
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
          // The storyboard node consumes (flattens) this as a dimension and
          // actions/generate_storyboard.py reads this exact key to build the
          // prompt — it must be 'product_description', not 'description'.
          product_description: product.description ?? '',
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

  /**
   * Builds the edit_video workflow body for a single candidate edit. The
   * sink's input is named `video` on purpose (not `edited_video`): the same
   * pollWorkflow/resumeGeneration consumers that read a generation's
   * sink.output['0']['video'] read this run's output too. inputFiles carry
   * only `file` (no image_id/run number/timestamp) and parameters carry only
   * `model` and `gcp_location`, so two identical edits hash to the same
   * worker cache key.
   */
  private getVideoEditWorkflowDefinition(params: VideoEditWorkflowParameters) {
    return {
      workflowDefinition: {
        root: {
          action: 'pass',
          input: {
            video: null,
            prompt: null,
          },
          types: {
            video: 'video',
            prompt: 'string',
          },
        },
        n_0: {
          action: 'edit_video',
          input: {
            video: {
              node: 'root',
              output: 'video',
            },
            prompt: {
              node: 'root',
              output: 'prompt',
            },
          },
          parameters: {
            model: params.model,
            gcp_location: params.location,
          },
        },
        sink: {
          action: 'pass',
          input: {
            video: {
              node: 'n_0',
              output: 'edited_video',
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
        video: [
          {
            file: params.videoPath,
          },
        ],
        prompt: [
          {
            file: params.promptPath,
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
    const hashedFileName = `${fileName}-${contentHash}.txt`;
    const {path} = await this.mediaService.upload(
      content,
      'remix-input',
      hashedFileName,
    );
    return path;
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
      generateAudio: requestedGenerateAudio,
      resolution,
    }: {
      durationSeconds: number;
      model: string;
      generateAudio: boolean;
      resolution: Resolution;
    },
  ) {
    // A model whose catalog entry always generates audio overrides the
    // caller's own choice (the toggle is shown on and disabled for such a
    // model, but a caller that read a stale value must not undercut it).
    const generateAudio =
      this.configService.audioLocked() || requestedGenerateAudio;
    const projectId = this.configService.projectConfig.value().id;
    if (this.generatingSceneIds().has(s.id)) {
      return;
    }
    // Fail fast and clearly if /api/config has not loaded: startVideoGeneration
    // Workflow reads globalConfig fields. Without this guard an undefined config
    // surfaces as a vague "Failed to start workflow" AND marks the scene
    // permanently failed (generationError + "!" badge). Surface a recoverable
    // "try again" and do NOT flag the scene, mirroring the storyboard and
    // combine guards. (E1)
    if (!this.configService.globalConfig.value()) {
      this.matSnackBar.open(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
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
        `${this.sceneLabel(scene.id)} — video generation workflow started:`,
        `${window.location.origin}/status?executionId=${executionId}`,
      );
      // Persist the in-flight run immediately (not debounced): navigating
      // away must not lose it. Self-healing: if the completion save below
      // never lands, the document still carries pendingGeneration and the
      // next open re-collects the results from the completed execution.
      const pending: PendingGeneration = {
        executionId,
        requestedCount:
          this.configService.projectConfig.value().numberOfCandidates,
        startedAt: new Date().toISOString(),
        durationSeconds,
        model,
        generateAudio,
        resolution,
        prompt: scene.prompt,
      };
      if (scene.referenceImage) {
        pending.referenceImage = {...scene.referenceImage};
      }
      this.setScenePendingGeneration(scene.id, pending);
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
      const newCandidates = await this.collectCandidates(
        workflowStatus.sink.output['0']['video'],
        currentMaxRun,
        {
          durationSeconds,
          model,
          generateAudio,
          resolution,
          prompt: scene.prompt,
          referenceImage: scene.referenceImage,
        },
      );
      // Collecting/signing the candidates above is async; if the user navigated
      // to another project meanwhile, attaching now would write this scene's
      // candidates to the wrong project (or silently drop them, since that
      // project has no scene with this id). Bail like a navigation so the marker
      // survives and reopening the original project re-collects them. (E5)
      this.assertProjectUnchanged(projectId);
      if (newCandidates.length === 0) {
        // The run is complete but produced no (new) videos: clear the
        // persisted in-flight marker now instead of leaving it for the
        // next project open's resume pass to clean up.
        this.setScenePendingGeneration(scene.id, undefined);
        return;
      }
      const candidates = [...(scene.candidates ?? []), ...newCandidates];
      this.attachCandidates(scene.id, candidates);
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        // The user left the project mid-run: pendingGeneration stays
        // persisted so the run is resumed when the project is re-opened.
        console.info(error.message);
        return;
      } else if (error instanceof PollTimeoutError) {
        // Stalled, not failed: keep pendingGeneration so reopening the project
        // resumes and still collects a late result. Only clear the in-memory
        // spinner (finally) and tell the user it may still finish.
        this.matSnackBar.open(
          'Generation is taking longer than expected. It may still finish — ' +
            'reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof CandidateSigningError) {
        // The run finished but its video URLs could not be signed right now.
        // Keep pendingGeneration so reopening re-collects the finished videos;
        // do NOT mark the scene failed (which would discard a successful run).
        this.matSnackBar.open(
          'Generated videos are ready but could not be loaded right now — ' +
            'reopen the project to retry.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof Error) {
        // Definitive failure: record the error on the scene itself — shown where
        // the video would be, with a "!" badge on its thumbnail — instead of only
        // a transient snackbar, so the user can tell which scene failed and why
        // after the snackbar is gone. This also drops any in-flight marker so the
        // next open does not replay the error.
        this.setSceneGenerationError(scene.id, error.message);
        console.error('Video generation error:', {executionId, error});
        console.error(
          `${this.sceneLabel(scene.id)} — debug URL:`,
          `${window.location.origin}/status?executionId=${executionId}`,
        );
        this.matSnackBar.open(
          `${this.sceneLabel(scene.id)} failed to generate — open the marked scene to see why.`,
          'Dismiss',
          {panelClass: ['error-snackbar']},
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

  /**
   * Selects the model edit_video runs with: the first (sorted) edit-capable
   * model at the configured Veo location, preferring the catalog's own Omni
   * default when that default is itself edit-capable there. Never derived
   * from the project's own model — a project set to a Veo id must still
   * route edits through an edit-capable model. Returns undefined when no
   * model can edit at this location.
   */
  private selectEditModel(): string | undefined {
    const editModels = this.configService.videoEditModels();
    if (editModels.length === 0) {
      return undefined;
    }
    const omniDefault =
      this.configService.globalConfig.value()?.modelCatalog?.defaults['omni'];
    return omniDefault && editModels.includes(omniDefault)
      ? omniDefault
      : editModels[0];
  }

  /**
   * Turns one candidate into a new candidate by running edit_video with a
   * text instruction. Follows the same start/persist/poll/collect/attach path
   * as generateCandidates, with requestedCount 1 and the source candidate's
   * own duration/trim/resolution/prompt/referenceImage carried onto both the
   * request and the resulting candidate (an edit changes only the video,
   * never the scene's other settings). Identical edits hash to the same
   * worker cache key: a cache-hit result (a path already attached to the
   * scene) is deduped rather than attached a second time.
   */
  async editCandidate(
    scene: GeneratedScene,
    candidateIndex: number,
    editPrompt: string,
  ): Promise<void> {
    const source = scene.candidates?.[candidateIndex];
    const model = this.selectEditModel();
    if (!model) {
      this.matSnackBar.open(
        'No model can edit video at this location.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      return;
    }
    if (!source?.video) {
      // An errored candidate has nothing to edit — not a catalog problem, so
      // no "no model" message.
      return;
    }
    if (this.generatingSceneIds().has(scene.id)) {
      return;
    }
    const globalConfig = this.configService.globalConfig.value();
    if (!globalConfig) {
      this.matSnackBar.open(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      return;
    }
    const projectId = this.configService.projectConfig.value().id;
    this.generatingSceneIds.update(ids => {
      const newIds = new Set(ids);
      newIds.add(scene.id);
      return newIds;
    });

    let executionId = '';
    try {
      const workflowId = crypto.randomUUID();
      const promptPath = await this.uploadText(editPrompt, 'edit-prompt');
      const response = this.startWorkflow(
        this.getVideoEditWorkflowDefinition({
          workflowId,
          gcpProject: globalConfig.gcpProject,
          gcpLocation: globalConfig.gcpLocation,
          gcsBucket: globalConfig.gcsBucket,
          forceExecution: false,
          tasksQueuePrefix: globalConfig.tasksQueuePrefix,
          model,
          location: globalConfig.veoLocation,
          videoPath: source.video.path,
          promptPath,
        }),
      );
      executionId = (await firstValueFrom(response)).executionId;
      console.debug(
        `${this.sceneLabel(scene.id)} — video edit workflow started:`,
        `${window.location.origin}/status?executionId=${executionId}`,
      );
      // Persist the in-flight run immediately, exactly like generateCandidates:
      // navigating away must not lose it.
      const pending: PendingGeneration = {
        executionId,
        requestedCount: 1,
        startedAt: new Date().toISOString(),
        durationSeconds: source.durationSeconds,
        model,
        // An edit always runs through the edit-capable (Omni) model, which
        // always generates audio.
        generateAudio: true,
        resolution: source.resolution,
        prompt: source.prompt,
        editPrompt,
        editedFromRun: source.runNumber,
      };
      if (source.trim) {
        pending.trim = {...source.trim};
      }
      if (source.referenceImage) {
        pending.referenceImage = {...source.referenceImage};
      }
      this.setScenePendingGeneration(scene.id, pending);
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
      const currentScene = this.configService.projectConfig
        .value()
        .storyboard.find(
          (s): s is GeneratedScene =>
            s.id === scene.id && this.configService.isGeneratedScene(s),
        );
      const existingCandidates = currentScene?.candidates ?? [];
      // Dedupe against a cache hit: an identical edit hashes to the same
      // worker output path, which may already be attached as a candidate.
      const attachedPaths = new Set(
        existingCandidates
          .map(c => c.video?.path)
          .filter((p): p is string => p !== undefined),
      );
      const videoItems = workflowStatus.sink.output['0']['video'];
      const newVideoItems = videoItems.filter(
        e => e.file === undefined || !attachedPaths.has(e.file),
      );
      // Signing/collecting below is async; bail like a navigation if the
      // project changed meanwhile, mirroring generateCandidates. (E5)
      this.assertProjectUnchanged(projectId);
      if (newVideoItems.length === 0 && videoItems.length > 0) {
        this.setScenePendingGeneration(scene.id, undefined);
        this.matSnackBar.open(
          'This edit already exists as a candidate',
          'Dismiss',
        );
        return;
      }
      const currentMaxRun = existingCandidates.length
        ? Math.max(...existingCandidates.map(c => c.runNumber))
        : 0;
      const newCandidates = await this.collectCandidates(
        newVideoItems,
        currentMaxRun,
        {
          durationSeconds: source.durationSeconds,
          model,
          generateAudio: true,
          resolution: source.resolution,
          prompt: source.prompt,
          referenceImage: source.referenceImage,
          trim: source.trim,
          editPrompt,
          editedFromRun: source.runNumber,
        },
      );
      this.assertProjectUnchanged(projectId);
      if (newCandidates.length === 0) {
        this.setScenePendingGeneration(scene.id, undefined);
        return;
      }
      this.attachCandidates(scene.id, [
        ...existingCandidates,
        ...newCandidates,
      ]);
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        return;
      } else if (error instanceof PollTimeoutError) {
        this.matSnackBar.open(
          'Generation is taking longer than expected. It may still finish — ' +
            'reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof CandidateSigningError) {
        this.matSnackBar.open(
          'Generated videos are ready but could not be loaded right now — ' +
            'reopen the project to retry.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof Error) {
        this.setSceneGenerationError(scene.id, error.message);
        console.error('Video edit error:', {executionId, error});
        console.error(
          `${this.sceneLabel(scene.id)} — debug URL:`,
          `${window.location.origin}/status?executionId=${executionId}`,
        );
        this.matSnackBar.open(
          `${this.sceneLabel(scene.id)} failed to generate — open the marked scene to see why.`,
          'Dismiss',
          {panelClass: ['error-snackbar']},
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

  /**
   * Resumes a candidate generation persisted in the project document
   * (mediated data plane): re-registers the scene as generating (so the
   * storyboard renders its loading placeholders), polls the persisted
   * execution and runs the shared completion path.
   */
  private async resumeGeneration(
    projectId: string,
    sceneId: string,
    pending: PendingGeneration,
  ) {
    this.generatingSceneIds.update(ids => {
      const newIds = new Set(ids);
      newIds.add(sceneId);
      return newIds;
    });
    try {
      console.debug(
        `${this.sceneLabel(sceneId)} — resuming video generation workflow:`,
        `${window.location.origin}/status?executionId=${pending.executionId}`,
      );
      const workflowStatus = await this.pollWorkflow(
        pending.executionId,
        projectId,
      );
      if (workflowStatus.sink?.output['0']['video'][0]['_error']) {
        const errorMsg =
          workflowStatus.sink?.output['0']['video'][0]['_error'] ||
          'Unknown error';
        throw new Error(errorMsg);
      }
      if (!workflowStatus.sink) {
        throw new Error('Workflow completed without output');
      }
      const currentScene = this.configService.projectConfig
        .value()
        .storyboard.find(
          (s): s is GeneratedScene =>
            s.id === sceneId && this.configService.isGeneratedScene(s),
        );
      const existingCandidates = currentScene?.candidates ?? [];
      // Idempotency: a prior completion save may already have attached some
      // of these videos — skip any whose path is present on the scene.
      const attachedPaths = new Set(
        existingCandidates
          .map(c => c.video?.path)
          .filter((p): p is string => p !== undefined),
      );
      const videoItems = workflowStatus.sink.output['0']['video'].filter(
        e => e.file === undefined || !attachedPaths.has(e.file),
      );
      const currentMaxRun = existingCandidates.length
        ? Math.max(...existingCandidates.map(c => c.runNumber))
        : 0;
      const newCandidates = await this.collectCandidates(
        videoItems,
        currentMaxRun,
        {
          durationSeconds: pending.durationSeconds,
          model: pending.model,
          generateAudio: pending.generateAudio,
          resolution: pending.resolution,
          prompt: pending.prompt,
          referenceImage: pending.referenceImage,
          trim: pending.trim,
          editPrompt: pending.editPrompt,
          editedFromRun: pending.editedFromRun,
        },
      );
      // Attach even when newCandidates is empty: the run is complete, so
      // the pendingGeneration marker must be cleared either way. But signing
      // above is async: if the user navigated away meanwhile, bail like a
      // navigation so the marker survives and a later return re-collects, rather
      // than attaching to (or clearing the marker on) the wrong project. (E5)
      this.assertProjectUnchanged(projectId);
      this.attachCandidates(sceneId, [...existingCandidates, ...newCandidates]);
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        // The user left again: keep pendingGeneration persisted and allow a
        // later return to this project to resume once more.
        this.resumedExecutionIds.delete(pending.executionId);
        return;
      } else if (error instanceof PollTimeoutError) {
        // Stalled, not failed: keep pendingGeneration and allow a later reopen
        // to resume again; surface a message rather than discarding the run.
        this.resumedExecutionIds.delete(pending.executionId);
        this.matSnackBar.open(
          'Generation is taking longer than expected. It may still finish — ' +
            'reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof CandidateSigningError) {
        // The run finished but its video URLs could not be signed right now.
        // Keep pendingGeneration so reopening re-collects the finished videos;
        // release the resume claim so a later reopen retries. (E3)
        this.resumedExecutionIds.delete(pending.executionId);
        this.matSnackBar.open(
          'Generated videos are ready but could not be loaded right now — ' +
            'reopen the project to retry.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof Error) {
        // Definitive failure: record the error on the scene (shown in the
        // preview, with a "!" badge) and clear the marker so reopening the
        // project does not replay the error.
        this.setSceneGenerationError(sceneId, error.message);
        console.error('Video generation resume error:', {
          executionId: pending.executionId,
          error,
        });
        console.error(
          `${this.sceneLabel(sceneId)} — debug URL:`,
          `${window.location.origin}/status?executionId=${pending.executionId}`,
        );
        this.matSnackBar.open(
          `${this.sceneLabel(sceneId)} failed to generate — open the marked scene to see why.`,
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
      }
    } finally {
      this.generatingSceneIds.update(ids => {
        const newIds = new Set(ids);
        newIds.delete(sceneId);
        return newIds;
      });
    }
  }

  /**
   * Builds Candidate objects (signed URL + thumbnails) for the workflow's
   * video outputs. The signUrl HTTP call is wrapped in a bounded retry and
   * per-candidate failures are tolerated (allSettled) — only an all-failed
   * batch escalates to the caller's error path.
   */
  private async collectCandidates(
    videoItems: NodeItem[],
    currentMaxRun: number,
    params: {
      durationSeconds: number;
      model: string;
      generateAudio: boolean;
      resolution: Resolution;
      prompt: string;
      referenceImage?: GcsFile;
      // Present only for a run started by editCandidate; carried onto the
      // resulting candidate below.
      trim?: {start?: number; end?: number};
      editPrompt?: string;
      editedFromRun?: number;
    },
  ): Promise<Candidate[]> {
    const buildCandidate = async (
      e: NodeItem & {file: string},
    ): Promise<Candidate> => {
      const path = e.file;
      const url = await this.withRetry(() => this.mediaService.signUrl(path));

      const lowQualityThumbnail = await this.clientMediaService
        .generateLowQualityThumbnail(url, 'video')
        .then(blob => this.clientMediaService.toBase64(blob))
        .catch(e => {
          console.error(e);
          return undefined;
        });
      const highQualityThumbnail = await this.clientMediaService
        .generateHighQualityThumbnail(url, 'video')
        .then(blob => this.clientMediaService.toFile(blob))
        .then(file => this.uploadThumbnail(file))
        .catch(e => {
          console.error(e);
          return undefined;
        });

      const newCandidate: Candidate = {
        runNumber: currentMaxRun + 1,
        durationSeconds: params.durationSeconds,
        prompt: params.prompt,
        model: params.model,
        generateAudio: params.generateAudio,
        resolution: params.resolution,
        video: {url, path},
        lowQualityThumbnail,
        highQualityThumbnail,
      };
      if (params.referenceImage) {
        newCandidate.referenceImage = {...params.referenceImage};
      }
      if (params.trim) {
        newCandidate.trim = {...params.trim};
      }
      if (params.editPrompt !== undefined) {
        newCandidate.editPrompt = params.editPrompt;
      }
      if (params.editedFromRun !== undefined) {
        newCandidate.editedFromRun = params.editedFromRun;
      }
      return newCandidate;
    };
    // Drop file-less outputs: the resume filter keeps items with no `file`
    // (they have no path to test against already-attached candidates), but such
    // an item is not a real video — it has neither a file to sign nor an
    // `_error`. Signing the literal path "undefined" would surface a scene that
    // actually succeeded as a broken, definitive failure. Skip them so they are
    // neither turned into candidates nor counted as load failures.
    const fileItems = videoItems.filter(
      (e): e is NodeItem & {file: string} => e.file !== undefined,
    );
    // Warm the cache in one request so the per-candidate signUrl calls below
    // dedup into it; best-effort, withRetry re-signs each path if it fails.
    void this.mediaService.signUrls(fileItems.map(e => e.file)).catch(() => {});
    const settled = await Promise.allSettled(fileItems.map(buildCandidate));
    const candidates = settled
      .filter(
        (r): r is PromiseFulfilledResult<Candidate> => r.status === 'fulfilled',
      )
      .map(r => r.value);
    const failures = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error('Failed to load a generated video:', failure.reason);
      }
      if (candidates.length === 0) {
        // Everything failed. The only thing that can reject buildCandidate is
        // signUrl (thumbnail steps are caught), and we only reach here when the
        // run produced video outputs — so this is a transient signing failure on
        // a COMPLETED run, not a failed generation. Signal it as such so the
        // caller keeps the marker instead of deleting a successful run. (E3)
        throw new CandidateSigningError(failures[0].reason);
      }
      this.matSnackBar.open(
        `${failures.length} of ${fileItems.length} generated videos could not be loaded`,
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
    }
    return candidates;
  }

  /**
   * Attaches the full candidate list to a scene, clearing its
   * pendingGeneration marker in the same signal update (atomic), and — on
   * the mediated data plane — persists immediately.
   */
  private attachCandidates(sceneId: string, candidates: Candidate[]) {
    const scenes = this.configService.projectConfig
      .value()
      .storyboard.map(s => {
        if (s.id !== sceneId || !this.configService.isGeneratedScene(s)) {
          return s;
        }
        const updated: GeneratedScene = {
          ...s,
          candidates,
          selectedCandidateIndex: s.selectedCandidateIndex ?? 0,
        };
        delete updated.pendingGeneration;
        // A successful run clears any prior failure marker + "!" badge.
        delete updated.generationError;
        delete updated.generationErrorAcknowledged;
        return updated;
      });
    this.configService.updateProjectConfig({storyboard: scenes});
    this.configService.flushPendingSave();
  }

  /**
   * Sets or clears the persisted in-flight marker on a scene and persists
   * the project immediately (mediated-only call sites).
   */
  private setScenePendingGeneration(
    sceneId: string,
    pendingGeneration: PendingGeneration | undefined,
  ) {
    const scenes = this.configService.projectConfig
      .value()
      .storyboard.map(s => {
        if (s.id !== sceneId || !this.configService.isGeneratedScene(s)) {
          return s;
        }
        const updated: GeneratedScene = {...s};
        if (pendingGeneration === undefined) {
          delete updated.pendingGeneration;
        } else {
          updated.pendingGeneration = pendingGeneration;
          // Starting a (re)generation clears any prior failure marker + "!" badge.
          delete updated.generationError;
          delete updated.generationErrorAcknowledged;
        }
        return updated;
      });
    this.configService.updateProjectConfig({storyboard: scenes});
    this.configService.flushPendingSave();
  }

  /**
   * A short, position-based label for a scene, used in user messages and console
   * hints, e.g. `Scene: [2] "Scene 55 a..."`. Uses the scene's CURRENT position
   * (1-based) in the storyboard at the moment the message is built — not its
   * title — and clips the name to ~10 characters so messages stay short.
   */
  private sceneLabel(sceneId: string): string {
    const storyboard = this.configService.projectConfig.value().storyboard;
    const index = storyboard.findIndex(s => s.id === sceneId);
    const position = index >= 0 ? `${index + 1}` : '?';
    const name = (index >= 0 ? storyboard[index].name : '') ?? '';
    const clipped = name.length > 10 ? `${name.slice(0, 10)}...` : name;
    return `Scene: [${position}] "${clipped}"`;
  }

  /**
   * Records a definitive generation failure on a scene: stores the error
   * message (shown in the preview area where the video would be), marks it
   * unseen (drives the "!" badge on the thumbnail), and drops any in-flight
   * marker. Persists immediately.
   */
  private setSceneGenerationError(sceneId: string, message: string) {
    const scenes = this.configService.projectConfig
      .value()
      .storyboard.map(s => {
        if (s.id !== sceneId || !this.configService.isGeneratedScene(s)) {
          return s;
        }
        const updated: GeneratedScene = {
          ...s,
          generationError: message,
          generationErrorAcknowledged: false,
        };
        delete updated.pendingGeneration;
        return updated;
      });
    this.configService.updateProjectConfig({storyboard: scenes});
    this.configService.flushPendingSave();
  }

  /**
   * Bounded retry with backoff for transient failures (the mediated signUrl
   * is an HTTP call, unlike the near-infallible SDK getDownloadURL it
   * replaces). Attempts = SIGN_URL_RETRY_DELAYS_MS.length + 1.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= SIGN_URL_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      if (attempt > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, SIGN_URL_RETRY_DELAYS_MS[attempt - 1]),
        );
      }
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async generateStoryboard(
    products: Product[],
    briefing: string,
    imageDecision: 'none' | 'crop' | 'outpaint',
  ) {
    const projectId = this.configService.projectConfig.value().id;
    let executionId;
    try {
      // Fail fast and clearly if /api/config has not loaded: the workflow
      // builder below reads globalConfig fields. Without this guard an
      // undefined config throws a TypeError that surfaces as a vague "Failed to
      // start workflow" instead of a recoverable "try again". (E1)
      if (!this.configService.globalConfig.value()) {
        throw new Error(
          'Configuration is not loaded yet. Please try again in a moment.',
        );
      }
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

      const storyboardJson = JSON.parse(
        await (await this.mediaService.getBlob(storyboardJsonFile)).text(),
      );

      if (
        !('storyboard' in storyboardJson) ||
        !Array.isArray(storyboardJson['storyboard'])
      ) {
        throw new Error('Storyboard JSON file is missing storyboard');
      }

      const outpaintedImages =
        workflowStatus.sink.output['0']['outpainted_images'];
      const productsToOutpaintedImages: Record<
        string,
        Record<string, ProductImage>
      > = {};
      // Warm the cache in one request so the per-image signUrl calls below
      // dedup into it.
      void this.mediaService
        .signUrls(
          outpaintedImages
            .filter(image => image.product_id !== undefined)
            .map(image => String(image.file)),
        )
        .catch(() => {});
      for (const image of outpaintedImages) {
        if (image.product_id !== undefined) {
          const productId = String(image.product_id);
          const imagePath = String(image.file);
          if (!productsToOutpaintedImages[productId]) {
            productsToOutpaintedImages[productId] = {};
          }
          productsToOutpaintedImages[productId][String(image.image_id)] = {
            url: await this.mediaService.signUrl(imagePath),
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
      } else if (error instanceof PollTimeoutError) {
        this.matSnackBar.open(
          'Storyboard generation is taking longer than expected. It may still ' +
            'finish — reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
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
      // Fail fast and clearly if /api/config has not loaded: the workflow
      // builder reads globalConfig fields. Without this guard an undefined
      // config throws a TypeError that surfaces as a vague "Failed to combine
      // scenes" instead of a recoverable "try again". (E1)
      if (!this.configService.globalConfig.value()) {
        throw new Error(
          'Configuration is not loaded yet. Please try again in a moment.',
        );
      }
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
      // Persist the in-flight render immediately so leaving and re-opening
      // the project resumes it instead of abandoning the result and leaving
      // the button stuck (mirrors the per-scene pendingGeneration marker).
      this.configService.setPendingRender({
        executionId,
        startedAt: new Date().toISOString(),
      });
      // Claim this executionId so the resume effect treats the live render as
      // already-resumed and never double-resumes it. (E2 — replaces the old
      // reliance on the shared combiningScenes flag.)
      this.resumedRenderExecutionIds.add(executionId);
      const workflowStatus = await this.pollWorkflow(executionId, projectId);
      await this.recordRenderOutput(workflowStatus, projectId);
      this.combiningScenes.set(false);
    } catch (error) {
      if (error instanceof RenderContractError) {
        this.combiningScenes.set(false);
        this.matSnackBar.open(error.message, 'Dismiss', {
          panelClass: ['error-snackbar'],
        });
        return;
      } else if (error instanceof ProjectChangedError) {
        // The user left the project mid-render: reset the in-memory button
        // state (otherwise it stays stuck on "Rendering...") but keep the
        // persisted marker so returning to the project resumes the run. Release
        // the per-execution claim so that return can re-resume it. (E2 —
        // mirrors resumeRender's ProjectChangedError branch.)
        console.info(error.message);
        if (executionId) {
          this.resumedRenderExecutionIds.delete(executionId);
        }
        this.combiningScenes.set(false);
        return;
      } else if (error instanceof PollTimeoutError) {
        // Stalled, not failed: clear the button but keep pendingRender so a
        // reopen resumes and collects a late result. Release the per-execution
        // claim (added at start) so that reopen can actually re-resume it —
        // otherwise the resumed-id guard would skip it. (E2)
        if (executionId) {
          this.resumedRenderExecutionIds.delete(executionId);
        }
        this.combiningScenes.set(false);
        this.matSnackBar.open(
          'Rendering is taking longer than expected. It may still finish — ' +
            'reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof RenderSigningError) {
        // The render finished but its output URL could not be signed right now.
        // Keep pendingRender so a reopen re-collects the finished video; release
        // the per-execution claim so that reopen can re-resume it. Do NOT record
        // an error run or clear the marker, which would discard the render. (E3)
        if (executionId) {
          this.resumedRenderExecutionIds.delete(executionId);
        }
        this.combiningScenes.set(false);
        this.matSnackBar.open(
          'Your video is ready but could not be loaded right now — ' +
            'reopen the project to retry.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
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
        // Definitive failure: clear the marker so reopening does not replay.
        this.configService.setPendingRender(undefined);
        this.combiningScenes.set(false);
      }
    }
  }

  /**
   * Throws ProjectChangedError when the loaded project is no longer
   * `projectId`. Called right before a completed run's result is written:
   * pollWorkflow guards project identity only DURING polling, so a navigation
   * in the async gap between a successful poll and the write (e.g. while the
   * output URL is being signed) would otherwise persist the result against
   * whatever project is now loaded, losing it from the project it belongs to.
   * Throwing routes into the existing ProjectChangedError handlers, which keep
   * the in-flight marker and release the resume claim, so reopening the
   * original project re-collects the finished result. (E5)
   */
  private assertProjectUnchanged(projectId: string) {
    if (this.configService.projectConfig.value().id !== projectId) {
      throw new ProjectChangedError();
    }
  }

  /**
   * Records a completed combine-scenes workflow's output as a render run and
   * clears the in-flight render marker. Throws on a workflow error or missing
   * output so the caller's catch handles it. Shared by combineScenes() and
   * resumeRender() so the two paths cannot diverge.
   */
  private async recordRenderOutput(
    workflowStatus: WorkflowStatusResponse,
    projectId: string,
  ) {
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
    let videoUrl: string;
    try {
      // Retry transient signing failures, then signal an all-fail as a
      // RenderSigningError so the caller keeps pendingRender instead of
      // discarding this completed render (mirrors collectCandidates). (E3)
      videoUrl = await this.withRetry(() =>
        this.mediaService.signUrl(videoPath!),
      );
    } catch (error) {
      throw new RenderSigningError(error);
    }
    // The poll succeeded and the URL is signed, but signing was async: if the
    // user navigated to another project meanwhile, recording now would attach
    // this render to the wrong project and clear ITS marker, losing the render
    // from the project it belongs to. Bail like a navigation so the marker
    // survives and reopening the original project re-collects it. (E5)
    this.assertProjectUnchanged(projectId);
    this.configService.addRenderRun({
      createdAt: new Date(),
      outputVideo: {
        path: videoPath!,
        url: videoUrl,
      },
      wasPlayed: false,
    });
    this.configService.setPendingRender(undefined);
  }

  /**
   * Resumes a persisted in-flight render when its project is (re-)opened,
   * mirroring resumeGeneration: re-poll the execution, record the finished
   * video, and clear the marker. Keeps the marker on a repeat navigate-away
   * so a later return can resume again; clears it on a definitive error.
   */
  private async resumeRender(projectId: string, pending: PendingRender) {
    try {
      this.combiningScenes.set(true);
      console.debug(
        'Resuming combine scenes workflow:',
        `${window.location.origin}/status?executionId=${pending.executionId}`,
      );
      const workflowStatus = await this.pollWorkflow(
        pending.executionId,
        projectId,
      );
      await this.recordRenderOutput(workflowStatus, projectId);
      this.combiningScenes.set(false);
    } catch (error) {
      if (error instanceof ProjectChangedError) {
        console.info(error.message);
        this.resumedRenderExecutionIds.delete(pending.executionId);
        this.combiningScenes.set(false);
        return;
      } else if (error instanceof PollTimeoutError) {
        // Stalled, not failed: keep pendingRender so a later reopen resumes and
        // collects a late result (mirrors combineScenes). Do NOT record an
        // error run or clear the marker, which would permanently abandon a
        // render that is merely slow. Release the per-execution claim so the
        // reopen can re-resume it (mirrors resumeGeneration's timeout branch). (E2)
        this.resumedRenderExecutionIds.delete(pending.executionId);
        this.combiningScenes.set(false);
        this.matSnackBar.open(
          'Rendering is taking longer than expected. It may still finish — ' +
            'reopen the project to check.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof RenderSigningError) {
        // The render finished but its output URL could not be signed right now.
        // Keep pendingRender so a later reopen re-collects the finished video;
        // release the per-execution claim so the reopen can re-resume it. Do NOT
        // record an error run or clear the marker. (E3)
        this.resumedRenderExecutionIds.delete(pending.executionId);
        this.combiningScenes.set(false);
        this.matSnackBar.open(
          'Your video is ready but could not be loaded right now — ' +
            'reopen the project to retry.',
          'Dismiss',
          {panelClass: ['error-snackbar']},
        );
        return;
      } else if (error instanceof Error) {
        this.configService.addRenderRun({
          createdAt: new Date(),
          errorMessage: error.message,
        });
        this.configService.setPendingRender(undefined);
        console.error('Combine scenes resume error:', {
          executionId: pending.executionId,
          error,
        });
        this.matSnackBar.open(
          error.message || 'Failed to combine scenes',
          'Dismiss',
          {
            panelClass: ['error-snackbar'],
          },
        );
        this.combiningScenes.set(false);
      }
    }
  }

  private getCombineScenesArrangements(
    scenes: Array<GeneratedScene | ProvidedVideoScene>,
    audioTracks: AudioTrack[],
    visualOverlays: VisualOverlay[],
  ) {
    const arrangement: CombineScenesArrangement[] = [];
    const resolvedScenes = scenes.map(scene => ({
      scene,
      resolution: resolveSceneRenderClip(scene),
    }));
    if (resolvedScenes.some(({resolution}) => resolution.state === 'invalid')) {
      throw new RenderContractError(
        'One or more selected scene videos are missing a storage path or valid ' +
          'duration, or have an invalid trim.',
      );
    }
    if (!resolvedScenes.some(({resolution}) => resolution.state === 'ready')) {
      throw new RenderContractError(
        'Select or upload at least one scene video before rendering.',
      );
    }
    const transitionViolation = findTransitionContractViolation(scenes);
    if (transitionViolation) {
      throw new RenderContractError(transitionViolation);
    }
    for (const {scene, resolution} of resolvedScenes) {
      if (resolution.state !== 'ready') {
        continue;
      }
      const {video, start, duration} = resolution.clip;
      const videoArrangement: CombineScenesArrangement = {
        file_type: 'video',
        file_path: video.path,
        start_time: 0,
        skip_time: start,
        duration,
      };
      if (scene.transition) {
        videoArrangement.transition = scene.transition;
        videoArrangement.transition_overlap =
          scene.transitionOverlap ?? DEFAULT_TRANSITION_OVERLAP;
      }
      arrangement.push(videoArrangement);
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
    // Same hash-derived object name; the server skips the PUT when the object
    // already exists.
    return this.mediaService.upload(media, path, fileName);
  }

  async uploadThumbnail(media: File) {
    return this.uploadMedia(media, 'thumbnail');
  }
}
