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
import {
  computed,
  DOCUMENT,
  effect,
  inject,
  Injectable,
  resource,
  signal,
} from '@angular/core';
import {toObservable} from '@angular/core/rxjs-interop';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {debounceTime, distinctUntilChanged, firstValueFrom, skip} from 'rxjs';

/**
 * Default transition overlap duration in seconds.
 */
export const DEFAULT_TRANSITION_OVERLAP = 0.5;

/** One full frame at the backend's minimum 24 fps render rate. */
export const MIN_RENDER_CLIP_DURATION_SECONDS = 0.042;

const DURATION_COMPARISON_EPSILON_SECONDS = 1e-9;

/**
 * Threshold for aspect ratio deviation beyond which a warning is shown.
 */
export const ASPECT_RATIO_DEVIATION_THRESHOLD = 0.01;

/**
 * Represents the aspect ratio of a video.
 */
export type AspectRatio = '16:9' | '9:16';

/**
 * Represents the resolution of a video.
 */
export type Resolution = '720p' | '1080p' | '4k';

/**
 * Represents a file stored in Google Cloud Storage.
 */
export interface GcsFile {
  path: string; // GCS path, starting after gcs://
  url: string; // signed GCS URL with token, starting with https://
}

/**
 * One model's entry in the catalog served by /api/config (the same catalog
 * the backend validator enforces, so the dropdowns cannot drift from it).
 */
export interface ModelCatalogEntry {
  family: string;
  actions: string[];
  locations: string[];
  capabilities?: Record<string, unknown>;
}

export interface ModelCatalog {
  defaults: Record<string, string>;
  actions: Record<string, {location_param: string | null; default_key: string}>;
  models: Record<string, ModelCatalogEntry>;
}

interface GlobalConfig {
  // GCP
  gcpLocation: string;
  gcpProject: string;
  gcsBucket: string;

  // Gemini
  geminiModel: string;
  geminiLocation: string;

  // Image (outpainting and image generation)
  imageModel: string;
  imageLocation: string;

  // Veo
  veoLocation: string;
  veoModel: string;
  generateAudio: boolean;
  resolution: Resolution;
  numberOfCandidates: number;
  aspectRatio: AspectRatio;
  duration: number;

  // Cloud Tasks
  tasksQueuePrefix: string;

  // FFmpeg
  encodingSpeed: number;
  qualityLevel: number;

  // Model catalog (merged into the response by the backend; 'firestore' when
  // the live config/models doc was served, 'shipped' on fallback).
  modelCatalog?: ModelCatalog;
  modelCatalogSource?: 'firestore' | 'shipped';
}

/**
 * Represents an audio track.
 */
export interface AudioTrack {
  name: string;
  file: GcsFile;
  startSeconds: number;
  durationSeconds: number;
}

/**
 * Represents a visual overlay.
 * Currently, only images are supported.
 */
export interface VisualOverlay {
  name: string;
  file: GcsFile;
  startSeconds: number;
  durationSeconds: number;
  widthPixels: number;
  heightPixels: number;
  pixelsFromTop: number;
  pixelsFromLeft: number;
}

/**
 * Represents a product image.
 */
export interface ProductImage extends GcsFile {
  widthPixels?: number;
  heightPixels?: number;
  aspectRatioDeviation?: number;
}

/**
 * Represents a product.
 */
export interface Product {
  id: number;
  name: string;
  images: ProductImage[];
  description?: string;
}

/**
 * Represents the configuration for a user's input before generation.
 */
export interface InputConfig {
  products: Product[];
  composition?: string;
  style?: string;
  audience?: string;
  templateId?: string;
}

/**
 * Represents a render run.
 */
export interface RenderRun {
  createdAt: Date;
  outputVideo?: GcsFile;
  errorMessage?: string;
  wasPlayed?: boolean;
  isArchived?: boolean;
}

/**
 * Persisted marker for an in-flight render (combine-scenes) run (mediated data
 * plane only). The project-level analogue of PendingGeneration: written to the
 * project document immediately when the render workflow starts so that leaving
 * and re-opening the project resumes polling and records the finished video,
 * instead of abandoning it and leaving the Render button stuck. Cleared when
 * the render run is recorded, or on a definitive workflow error.
 */
export interface PendingRender {
  executionId: string;
  /**
   * ISO-8601 string — deliberately not a Date, for the same round-trip reason
   * as PendingGeneration.startedAt.
   */
  startedAt: string;
}

/**
 * Configuration for a project.
 */
export interface ProjectConfig {
  id: string;
  name: string;
  createdBy?: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  candidateDurationSeconds: number;
  generateAudio: boolean;
  numberOfCandidates: number;
  model: string;
  lastEdited?: Date;
  inputConfig: InputConfig;
  storyboard: Array<GeneratedScene | ProvidedVideoScene>;
  audioTracks: AudioTrack[];
  visualOverlays: VisualOverlay[];
  renderRuns?: RenderRun[];
  pendingRender?: PendingRender;
}

interface ProjectSave {
  source: ProjectConfig;
  payload: ProjectConfig;
}

interface ProjectSaveState {
  latestSource: ProjectConfig | null;
  lastSavedSource: ProjectConfig | null;
  inFlight: ProjectSave | null;
  pending: ProjectSave | null;
}

interface Scene {
  id: string;
  name: string;
  type: 'generated' | 'video';
  transition?: string;
  transitionOverlap?: number;
  lowQualityThumbnail?: string;
  highQualityThumbnail?: GcsFile;
}

/**
 * Represents a candidate scene.
 */
export interface Candidate {
  runNumber: number;
  durationSeconds: number;
  video?: GcsFile;
  trim?: {start?: number; end?: number};
  errorMessage?: string;
  // Generation properties
  model: string;
  prompt: string;
  generateAudio: boolean;
  resolution: Resolution;
  referenceImage?: GcsFile;
  isArchived?: boolean;
  lowQualityThumbnail?: string;
  highQualityThumbnail?: GcsFile;
}

/**
 * Persisted marker for an in-flight candidate generation run (mediated data
 * plane only). Written to the project document immediately when the workflow
 * starts so that leaving and re-opening the project can resume polling and
 * collect the results. Cleared atomically with the candidate attach, or on a
 * definitive workflow error. Documents without this field load exactly as
 * before (the backend stores the payload verbatim).
 */
export interface PendingGeneration {
  executionId: string;
  requestedCount: number;
  /**
   * ISO-8601 string — deliberately not a Date: the backend converts only
   * lastEdited/renderRuns[].createdAt on load, so a Date here would
   * round-trip differently between data-plane modes.
   */
  startedAt: string;
  // Generation parameters captured at start; the completion path builds
  // Candidates from these.
  durationSeconds: number;
  model: string;
  generateAudio: boolean;
  resolution: Resolution;
  prompt: string;
  referenceImage?: GcsFile;
}

/**
 * Represents a generated scene.
 */
export interface GeneratedScene extends Scene {
  prompt: string;
  referenceImage?: GcsFile;
  candidates?: Candidate[];
  selectedCandidateIndex?: number;
  pendingGeneration?: PendingGeneration;
  /**
   * Message from the last definitive generation failure for this scene, shown
   * in the preview area where the video would be (so the user can see WHICH
   * scene failed and WHY, instead of a transient snackbar). Set on a definitive
   * error; cleared when a new generation starts or one succeeds.
   */
  generationError?: string;
  /**
   * Whether the user has seen the above failure: drives the temporary "!" badge
   * on the scene's filmstrip thumbnail. Set true when the failed scene is
   * selected; reset whenever a new generationError is recorded. Persisted so the
   * badge survives a reload until the scene is opened.
   */
  generationErrorAcknowledged?: boolean;
}

/**
 * Represents a provided video scene.
 */
export interface ProvidedVideoScene extends Scene {
  video?: GcsFile;
  durationSeconds?: number;
  trim?: {start?: number; end?: number};
}

export interface SceneRenderClip {
  video: GcsFile;
  start: number;
  duration: number;
}

export type SceneRenderClipResolution =
  | {state: 'not-selected'}
  | {state: 'invalid'}
  | {state: 'ready'; clip: SceneRenderClip};

/**
 * Resolves the video material that a scene contributes to a render.
 *
 * An unselected generated scene contributes nothing. A provided-video scene,
 * or a generated scene with a selected candidate, is invalid unless it has a
 * storage path and at least one frame of effective duration.
 */
export function resolveSceneRenderClip(
  scene: GeneratedScene | ProvidedVideoScene,
): SceneRenderClipResolution {
  let video: GcsFile | undefined;
  let sourceDuration: number | undefined;
  let trim: {start?: number; end?: number} | undefined;

  if (scene.type === 'generated') {
    const generatedScene = scene as GeneratedScene;
    if (generatedScene.selectedCandidateIndex === undefined) {
      return {state: 'not-selected'};
    }
    const candidate =
      generatedScene.candidates?.[generatedScene.selectedCandidateIndex];
    if (!candidate) {
      return {state: 'invalid'};
    }
    video = candidate.video;
    sourceDuration = candidate.durationSeconds;
    trim = candidate.trim;
  } else {
    const providedScene = scene as ProvidedVideoScene;
    video = providedScene.video;
    sourceDuration = providedScene.durationSeconds;
    trim = providedScene.trim;
  }

  const start = trim?.start ?? 0;
  const end = trim?.end ?? sourceDuration;
  const duration = end === undefined ? NaN : end - start;
  const path = video?.path;
  if (
    !video ||
    typeof path !== 'string' ||
    !path.trim() ||
    !Number.isFinite(start) ||
    !Number.isFinite(duration) ||
    duration + DURATION_COMPARISON_EPSILON_SECONDS <
      MIN_RENDER_CLIP_DURATION_SECONDS
  ) {
    return {state: 'invalid'};
  }
  return {state: 'ready', clip: {video, start, duration}};
}

export interface ThumbnailMaterial {
  lowQualityThumbnail?: string;
  highQualityThumbnail?: GcsFile;
  referenceImage?: GcsFile;
  videoUrl?: GcsFile;
}

/**
 * Truncates a number to a specified number of decimals.
 * @param value The number to truncate.
 * @param decimals The number of decimals to truncate to.
 * @return The truncated number.
 */
export function toDecimals(value: number, decimals: number): number {
  return Math.floor(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Converts a loaded date value to a Date: Firestore Timestamps (objects with
 * a toDate() method, e.g. legacy documents) and ISO strings (mediated `/api`
 * JSON) are both handled.
 */
function asDate(value: unknown): Date {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as {toDate?: unknown}).toDate === 'function'
  ) {
    return (value as {toDate: () => Date}).toDate();
  }
  return new Date(value as string | number | Date);
}

/**
 * Service for managing project configuration.
 */
@Injectable({
  providedIn: 'root',
})
export class ConfigService {
  private readonly DEFAULT_PROJECT_CONFIG = computed(
    () =>
      ({
        id: '',
        name: '',
        storyboard: [],
        aspectRatio: this.globalConfig.value()?.aspectRatio,
        resolution: this.globalConfig.value()?.resolution,
        candidateDurationSeconds: this.globalConfig.value()?.duration,
        generateAudio: this.globalConfig.value()?.generateAudio,
        numberOfCandidates: this.globalConfig.value()?.numberOfCandidates,
        model: this.globalConfig.value()?.veoModel,
        inputConfig: {
          products: [{id: 1, name: 'Product 1', images: []}],
          composition: '',
          style: '',
          audience: '',
          templateId: 'custom',
        },
        audioTracks: [],
        visualOverlays: [],
      }) as ProjectConfig,
  );
  private httpClient = inject(HttpClient);
  private matSnackBar = inject(MatSnackBar);
  private router = inject(Router);
  private document = inject(DOCUMENT);
  private projectId = signal<string | null>(null);
  /**
   * Mediated mode only: ids known to exist server-side (loaded via GET or
   * already POSTed). First save of a new project goes through
   * POST /api/projects (server stamps createdBy); later saves PATCH.
   */
  private persistedProjectIds = new Set<string>();

  /**
   * Video models compatible with the configured Veo location.
   * Matches the backend model/location validator. Sorted: Firestore returns
   * map keys sorted, the shipped fallback keeps file order.
   */
  readonly videoModels = computed(() => {
    const config = this.globalConfig.value();
    const catalog = config?.modelCatalog;
    const location = config?.veoLocation;
    if (!catalog || !location) {
      return [];
    }
    return Object.entries(catalog.models)
      .filter(
        ([, model]) =>
          model.actions.includes('generate_video') &&
          model.locations.includes(location),
      )
      .map(([id]) => id)
      .sort();
  });

  /**
   * Only choose replacements from the live catalog.
   * The shipped fallback can be stale and must not change project models.
   */
  private liveCatalogVideoFallback(): string | undefined {
    const config = this.globalConfig.value();
    const catalog = config?.modelCatalog;
    const models = this.videoModels();
    if (
      config?.modelCatalogSource !== 'firestore' ||
      !catalog ||
      models.length === 0
    ) {
      return undefined;
    }
    const veoDefault = catalog.defaults['veo'];
    return veoDefault && models.includes(veoDefault) ? veoDefault : models[0];
  }

  globalConfig = resource({
    loader: () => this.loadGlobalConfig(),
  });

  /**
   * Loads /api/config, degrading a failed fetch (transient 5xx, network blip,
   * IAP session expiry) to undefined instead of letting the resource enter its
   * error state. value() then stays callable and the optional-chaining guards
   * in DEFAULT_PROJECT_CONFIG keep working; an error state would make value()
   * throw, defeating those guards and hard-breaking the home and setup pages.
   * Extracted from the resource loader so this degradation is unit-testable.
   */
  private async loadGlobalConfig(): Promise<GlobalConfig | undefined> {
    try {
      return await firstValueFrom(
        this.httpClient.get<GlobalConfig>('/api/config'),
      );
    } catch (error) {
      console.error('Failed to load global config.', error);
      return undefined;
    }
  }

  projectConfig = resource({
    params: () => ({projectId: this.projectId()}),
    loader: async ({params}) => {
      if (params.projectId === null) {
        return {...this.DEFAULT_PROJECT_CONFIG()};
      }
      const localProjectAtLoad = this.projectWithUnsettledSave(
        params.projectId,
      );
      try {
        const data = await firstValueFrom(
          this.httpClient.get<ProjectConfig>(
            `/api/projects/${params.projectId}`,
          ),
        );
        this.persistedProjectIds.add(params.projectId);
        if (localProjectAtLoad) {
          return (
            this.projectSaveStates.get(params.projectId)?.latestSource ??
            localProjectAtLoad
          );
        }
        return this.normalizeLoadedProject(data);
      } catch (error) {
        if (error instanceof HttpErrorResponse && error.status === 404) {
          if (localProjectAtLoad) {
            return (
              this.projectSaveStates.get(params.projectId)?.latestSource ??
              localProjectAtLoad
            );
          }
          void this.router.navigate(['/']);
          console.error(`Project ${params.projectId} does not exist.`);
          return {...this.DEFAULT_PROJECT_CONFIG()};
        }
        throw error;
      }
    },
    defaultValue: {...this.DEFAULT_PROJECT_CONFIG()},
  });

  private normalizeLoadedProject(data: ProjectConfig): ProjectConfig {
    if (data.renderRuns) {
      data.renderRuns = data.renderRuns.map(run => {
        if (run.createdAt) {
          run.createdAt = asDate(run.createdAt);
        }
        return run;
      });
    }
    // Backwards compatibility for projects created before audioTracks and visualOverlays were introduced.
    if (!data.audioTracks) {
      data.audioTracks = [];
    }
    if (!data.visualOverlays) {
      data.visualOverlays = [];
    }
    return data;
  }

  shouldSave = false;

  theme = signal<string>(
    localStorage.getItem('theme') ??
      (this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)')
        ?.matches
        ? 'dark-mode'
        : 'light-mode'),
  );
  /**
   * Theme primary-color options, in the order shown in the theme picker.
   * Single source of truth for the picker, the theme effect below, and anywhere
   * that cycles through the colors (e.g. the storyboard run slivers).
   */
  static readonly THEME_COLORS: readonly string[] = [
    'theme-azure',
    'theme-magenta',
    'theme-green',
    'theme-orange',
    'theme-violet',
  ];
  primaryColor = signal<string>(
    localStorage.getItem('primaryColor') ?? 'theme-azure',
  );
  /**
   * Save ordering and identity-based dedupe state, isolated per project.
   * Requests carry a cloned payload while source references remain available
   * to dedupe immediate saves against trailing autosave emissions.
   */
  private readonly projectSaveStates = new Map<string, ProjectSaveState>();

  constructor() {
    toObservable(this.projectConfig.value)
      .pipe(skip(1), debounceTime(5000), distinctUntilChanged())
      .subscribe(config => {
        if (!config.id) {
          return;
        }
        if (this.isTrackedConfig(config)) {
          // Already persisted (or a save of this exact object is in flight);
          // avoid a duplicate save.
          return;
        }
        if (this.shouldSave) {
          config.lastEdited = new Date();
          this.persistNow(config);
        }
      });
    effect(() => {
      localStorage.setItem('theme', this.theme());
      this.document.documentElement.classList.remove('light-mode', 'dark-mode');
      this.document.documentElement.classList.add(this.theme());
    });
    effect(() => {
      localStorage.setItem('primaryColor', this.primaryColor());
      this.document.documentElement.classList.remove(
        ...ConfigService.THEME_COLORS,
      );
      this.document.documentElement.classList.add(this.primaryColor());
    });
    // Replace unavailable project models in this service; not every project
    // route creates the setup component.
    effect(() => {
      const project = this.projectConfig.value();
      const config = this.globalConfig.value();
      const models = this.videoModels();
      const fallback = this.liveCatalogVideoFallback();
      if (!project.id || !fallback) {
        return;
      }
      if (project.model && models.includes(project.model)) {
        return;
      }
      const previous = project.model;
      const isPersistedProject = this.persistedProjectIds.has(project.id);
      const isUnsavedDeployDefault =
        previous === config?.veoModel && !isPersistedProject;
      const shouldPersistCorrection =
        isPersistedProject || (!!previous && !isUnsavedDeployDefault);
      if (shouldPersistCorrection) {
        this.updateProjectConfig({model: fallback});
        const unavailableModel = previous
          ? `Video model ${previous}`
          : 'The saved video model';
        this.matSnackBar.open(
          `${unavailableModel} is no longer available; switched to ${fallback}.`,
          'OK',
        );
      } else {
        // A catalog correction alone must not create a new project.
        this.projectConfig.value.update(c => ({...c, model: fallback}));
      }
    });
    this.initFaviconListener();
  }

  private saveState(projectId: string): ProjectSaveState {
    let state = this.projectSaveStates.get(projectId);
    if (!state) {
      state = {
        latestSource: null,
        lastSavedSource: null,
        inFlight: null,
        pending: null,
      };
      this.projectSaveStates.set(projectId, state);
    }
    return state;
  }

  /**
   * Whether `state` is still the tracked save state for `projectId`.
   *
   * A deleted project can be recreated with the same id, which allocates a
   * new ProjectSaveState object under that id. An HTTP callback captured a
   * specific state object when its request started; if the map no longer
   * points at that same object, the callback belongs to a project that no
   * longer exists (or has been replaced) and must not act.
   */
  private isCurrentSaveState(
    projectId: string,
    state: ProjectSaveState,
  ): boolean {
    return this.projectSaveStates.get(projectId) === state;
  }

  /**
   * A GET started before a local save settles can return older project bytes.
   * Keep this load on the newest local object until that save settles.
   */
  private projectWithUnsettledSave(projectId: string): ProjectConfig | null {
    const state = this.projectSaveStates.get(projectId);
    if (
      !state?.latestSource ||
      (!state.inFlight &&
        !state.pending &&
        state.latestSource === state.lastSavedSource)
    ) {
      return null;
    }
    return state.latestSource;
  }

  private isTrackedConfig(config: ProjectConfig): boolean {
    const state = this.projectSaveStates.get(config.id);
    return (
      state !== undefined &&
      (config === state.lastSavedSource ||
        config === state.inFlight?.source ||
        config === state.pending?.source)
    );
  }

  private captureSave(source: ProjectConfig): ProjectSave {
    return {source, payload: structuredClone(source)};
  }

  /** Starts a save or replaces the newest snapshot queued for its project. */
  private persistNow(config: ProjectConfig) {
    const state = this.saveState(config.id);
    if (this.isTrackedConfig(config)) {
      return;
    }
    state.latestSource = config;
    const save = this.captureSave(config);
    if (state.inFlight) {
      state.pending = save;
      return;
    }
    this.startSave(save, state);
  }

  private startSave(save: ProjectSave, state: ProjectSaveState) {
    state.inFlight = save;
    this.saveProjectMediated(save, state);
  }

  private startPendingSave(state: ProjectSaveState): boolean {
    const pending = state.pending;
    state.pending = null;
    if (!pending) {
      return false;
    }
    this.startSave(pending, state);
    return true;
  }

  /**
   * Persists the current project immediately if it has unsaved changes,
   * bypassing the 5s autosave debounce. Used when leaving a project (where
   * the pending debounced emission would otherwise be dropped after the
   * reset/load) and when workflow state must be durable right away (e.g. an
   * in-flight generation marker). A no-op when there is nothing new to save.
   */
  flushPendingSave() {
    const config = this.projectConfig.value();
    if (!this.shouldSave || !config.id || this.isTrackedConfig(config)) {
      return;
    }
    config.lastEdited = new Date();
    this.persistNow(config);
  }

  /**
   * Persists the current project IMMEDIATELY on a meaningful, discrete action
   * (project creation, image upload, title commit) so it appears on the
   * homepage and references uploaded media right away rather than 5s later.
   *
   * Unlike flushPendingSave(), this does not require shouldSave to be set: a
   * brand-new project (setNewProject leaves shouldSave === false) must still
   * be created server-side on demand. It reuses persistNow()'s mechanics and
   * records the confirmed source reference, so the trailing debounced emission
   * for the SAME config object is deduped — no double POST/PATCH.
   */
  saveNow() {
    const config = this.projectConfig.value();
    if (!config.id || this.isTrackedConfig(config)) {
      return;
    }
    config.lastEdited = new Date();
    this.persistNow(config);
  }

  /**
   * Mediated autosave: POST creates the document on the first save of a new
   * project (the server stamps createdBy from the verified identity); PATCH
   * thereafter (full-document overwrite, createdBy immutable server-side).
   * Unlike the legacy silent path, failures surface a persistent snackbar
   * with a Retry affordance.
   */
  private saveProjectMediated(save: ProjectSave, state: ProjectSaveState) {
    const projectId = save.source.id;
    const isPersisted = this.persistedProjectIds.has(projectId);
    const request = isPersisted
      ? this.httpClient.patch(`/api/projects/${projectId}`, save.payload)
      : this.httpClient.post<{id: string}>('/api/projects', save.payload);
    request.subscribe({
      next: () => {
        // The project may have been deleted (and possibly recreated under the
        // same id, with its own new state object) while this request was in
        // flight. A stale response must not touch project state at all.
        if (!this.isCurrentSaveState(projectId, state)) {
          return;
        }
        this.persistedProjectIds.add(projectId);
        // Confirmed saved: now it is safe to dedupe future saves of this exact
        // object, and it is no longer in flight.
        state.lastSavedSource = save.source;
        if (state.inFlight === save) {
          state.inFlight = null;
        }
        this.startPendingSave(state);
      },
      error: error => {
        if (!this.isCurrentSaveState(projectId, state)) {
          return;
        }
        // The save did NOT happen: clear the in-flight marker (without ever
        // setting lastSavedSource) so a later flush/saveNow or the next
        // autosave emission re-attempts this work instead of skipping it.
        if (state.inFlight === save) {
          state.inFlight = null;
        }
        // POST is create-only server-side, so a 409 means the project already
        // exists (e.g. an earlier POST landed but its response was lost, leaving
        // this client thinking the project is still new). Recover by marking it
        // persisted and retrying the newest queued snapshot via PATCH. The
        // persisted-id guard makes this a single switch, not a loop.
        if (
          error instanceof HttpErrorResponse &&
          error.status === 409 &&
          !this.persistedProjectIds.has(projectId)
        ) {
          this.persistedProjectIds.add(projectId);
          if (!this.startPendingSave(state)) {
            const latest = this.projectConfig.value();
            const retrySource =
              latest.id === projectId
                ? latest
                : (state.latestSource ?? save.source);
            state.latestSource = retrySource;
            this.startSave(this.captureSave(retrySource), state);
          }
          return;
        }
        console.error('Error saving project config:', error);
        const snackBarRef = this.matSnackBar.open(
          'Unsaved changes — failed to save the project.',
          'Retry',
          {panelClass: ['error-snackbar']},
        );
        snackBarRef.onAction().subscribe(() => {
          if (!this.isCurrentSaveState(projectId, state)) {
            return;
          }
          // Retry the current state when still on this project, otherwise the
          // newest source this project's queue has observed.
          const latest = this.projectConfig.value();
          this.persistNow(
            latest.id === projectId
              ? latest
              : (state.latestSource ?? save.source),
          );
        });
        this.startPendingSave(state);
      },
    });
  }

  private initFaviconListener() {
    if (this.document.defaultView) {
      const mediaQuery = this.document.defaultView.matchMedia(
        '(prefers-color-scheme: dark)',
      );
      const updateFavicon = (isDark: boolean) => {
        const link =
          this.document.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (link) {
          link.href = isDark ? '/favicon-dark.ico' : '/favicon.ico';
        }
      };
      updateFavicon(mediaQuery.matches);
      // If the user changes the system theme, update the favicon.
      mediaQuery.addEventListener('change', e => {
        updateFavicon(e.matches);
      });
    }
  }

  sceneIdCounter = computed(() => {
    const scenes = this.projectConfig.value().storyboard;
    if (scenes.length === 0) {
      return 1;
    }
    return Math.max(...scenes.map(s => Number(s.id))) + 1;
  });

  isGeneratedScene(
    scene: GeneratedScene | ProvidedVideoScene | null,
  ): scene is GeneratedScene {
    if (!scene) {
      return false;
    }
    return scene.type === 'generated';
  }

  isProvidedVideoScene(
    scene: GeneratedScene | ProvidedVideoScene | null,
  ): scene is ProvidedVideoScene {
    if (!scene) {
      return false;
    }
    return scene.type === 'video';
  }

  resetProjectConfig() {
    // Leaving the project: persist the pending debounced autosave, which
    // would otherwise be silently dropped once the config resets (the
    // post-reset emission has id === '' / shouldSave === false).
    this.flushPendingSave();
    this.projectId.set(null);
    this.projectConfig.set({...this.DEFAULT_PROJECT_CONFIG()});
    this.shouldSave = false;
  }

  updateProjectConfig(partial: Partial<ProjectConfig>) {
    this.shouldSave = true;
    this.projectConfig.update(config => {
      return {
        ...config,
        ...partial,
      };
    });
  }

  setNewProject(uuid: string) {
    // Not persisted yet: the first autosave POSTs /api/projects, where the
    // server stamps createdBy from the verified identity. Left undefined here.
    this.persistedProjectIds.delete(uuid);
    const project = {
      ...this.DEFAULT_PROJECT_CONFIG(),
      id: uuid,
      name: 'Untitled Project',
      createdBy: undefined,
    };
    if (!this.videoModels().includes(project.model)) {
      const fallback = this.liveCatalogVideoFallback();
      if (fallback) {
        project.model = fallback;
      }
    }
    this.projectConfig.set(project);
    this.shouldSave = false;
  }

  addRenderRun(renderRun: RenderRun) {
    this.updateProjectConfig({
      renderRuns: [renderRun, ...(this.projectConfig.value().renderRuns ?? [])],
    });
  }

  /**
   * Sets or clears the persisted in-flight render marker and persists the
   * project immediately (mediated-only call sites), mirroring the per-scene
   * setScenePendingGeneration so a render survives navigation.
   */
  setPendingRender(pendingRender: PendingRender | undefined) {
    this.updateProjectConfig({pendingRender});
    this.flushPendingSave();
  }

  newRenderRunCount = computed(() => {
    return (
      this.projectConfig.value().renderRuns?.filter(run => !run.wasPlayed)
        .length ?? 0
    );
  });

  loadProjectConfig(projectId: string) {
    if (this.projectConfig.value().id === projectId) {
      return;
    }
    // Switching projects: persist the previous project's pending debounced
    // autosave before it is dropped.
    this.flushPendingSave();
    this.projectId.set(projectId);
    this.shouldSave = false;
  }

  async getProjects(mineOnly?: unknown): Promise<ProjectConfig[]> {
    // The server filters on its own verified identity, so the client never
    // sends an email — it only sets the 'createdBy=me' marker when the caller
    // wants its own projects. `mineOnly` is used purely as a truthy flag: any
    // truthy value (the homepage passes the current user's email/uid) means
    // "my projects only", and a falsy value means "all projects".
    const url = mineOnly ? '/api/projects?createdBy=me' : '/api/projects';
    const response = await firstValueFrom(
      this.httpClient.get<{projects: ProjectConfig[]}>(url),
    );
    return response.projects.map(data => {
      if (data.lastEdited) {
        data.lastEdited = asDate(data.lastEdited);
      }
      return data;
    });
  }

  async deleteProject(projectId: string) {
    await firstValueFrom(this.httpClient.delete(`/api/projects/${projectId}`));
    this.persistedProjectIds.delete(projectId);
    this.projectSaveStates.delete(projectId);
  }
}
