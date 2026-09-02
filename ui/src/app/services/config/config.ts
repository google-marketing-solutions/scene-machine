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
export type Resolution = '360p' | '720p' | '1080p' | '4k';

/** Every known Resolution value, in ascending order. */
const KNOWN_RESOLUTIONS: Resolution[] = ['360p', '720p', '1080p', '4k'];

/** Every known AspectRatio value. */
const KNOWN_ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16'];

/** Resolutions offered when a model's catalog entry has no allowed_resolutions (today's behaviour). */
const FALLBACK_RESOLUTIONS: Resolution[] = ['720p', '1080p'];

/** Aspect ratios offered when a model's catalog entry has no allowed_aspect_ratios (today's behaviour). */
const FALLBACK_ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16'];

/** Candidate durations offered when a model/resolution has no duration_by_resolution entry (today's behaviour). */
const FALLBACK_DURATIONS: number[] = [4, 6, 8];

/**
 * Greatest common divisor, used to derive the slider step from a list of
 * allowed durations. gcd(0, x) === x, so seeding a reduction with 0 yields
 * the single gap unchanged, and 1 for a durations list with no gaps.
 */
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** The nearest value in `allowed` to `value`; ties go to the shorter (smaller) one. */
function nearestAllowed(allowed: number[], value: number): number {
  return allowed.reduce((best, candidate) => {
    const bestDiff = Math.abs(best - value);
    const candidateDiff = Math.abs(candidate - value);
    if (candidateDiff < bestDiff) {
      return candidate;
    }
    if (candidateDiff === bestDiff) {
      return Math.min(best, candidate);
    }
    return best;
  });
}

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
  /** The instruction that produced this candidate via the Edit button, if any. */
  editPrompt?: string;
  /** The runNumber of the source candidate this one was edited from, if any. */
  editedFromRun?: number;
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
  /** Carried through from the source candidate for an edit run. */
  trim?: {start?: number; end?: number};
  /** The instruction being applied, for an edit run. */
  editPrompt?: string;
  /** The runNumber of the source candidate, for an edit run. */
  editedFromRun?: number;
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
  // A clip must not only be long enough, it must lie inside the source. A
  // trim starting at or past the source end still satisfies the minimum
  // duration, but there is no video left to read and ffmpeg emits an
  // audio-only output instead of failing.
  const withinSource =
    Number.isFinite(sourceDuration) &&
    (sourceDuration as number) > 0 &&
    start >= 0 &&
    start < (sourceDuration as number) &&
    end !== undefined &&
    end <= (sourceDuration as number) + DURATION_COMPARISON_EPSILON_SECONDS;
  if (
    !video ||
    typeof path !== 'string' ||
    !path.trim() ||
    !Number.isFinite(start) ||
    !Number.isFinite(duration) ||
    !withinSource ||
    duration + DURATION_COMPARISON_EPSILON_SECONDS <
      MIN_RENDER_CLIP_DURATION_SECONDS
  ) {
    return {state: 'invalid'};
  }
  return {state: 'ready', clip: {video, start, duration}};
}

/**
 * The message shown when a scene's transition cannot be applied, or null when
 * every transition in the storyboard is applicable.
 *
 * Per-clip validity is not enough: a transition consumes time from BOTH the
 * clip it is on and the one before it (ffmpeg offsets the crossfade by
 * `overlap` into the accumulated timeline). An overlap at least as long as
 * either neighbour swallows that clip entirely, so a storyboard of
 * individually valid clips can still render as a single wash of colour.
 *
 * Shared by render eligibility and arrangement construction so the button and
 * the submitted workflow cannot disagree.
 */
export function findTransitionContractViolation(
  scenes: Array<GeneratedScene | ProvidedVideoScene>,
): string | null {
  const renderable: Array<{
    scene: GeneratedScene | ProvidedVideoScene;
    duration: number;
  }> = [];
  for (const scene of scenes) {
    const resolution = resolveSceneRenderClip(scene);
    if (resolution.state === 'ready') {
      renderable.push({scene, duration: resolution.clip.duration});
    }
  }
  // The first clip has nothing to transition from, so ffmpeg ignores its
  // transition; start at the second.
  for (let index = 1; index < renderable.length; index++) {
    const {scene, duration} = renderable[index];
    if (!scene.transition) {
      continue;
    }
    const overlap = scene.transitionOverlap ?? DEFAULT_TRANSITION_OVERLAP;
    if (!Number.isFinite(overlap) || overlap <= 0) {
      continue; // an explicit zero (or absent) overlap is a hard cut
    }
    const previousDuration = renderable[index - 1].duration;
    if (
      overlap + DURATION_COMPARISON_EPSILON_SECONDS >= duration ||
      overlap + DURATION_COMPARISON_EPSILON_SECONDS >= previousDuration
    ) {
      return (
        `The transition on "${scene.name}" is longer than the clips it joins. ` +
        'Shorten the transition or lengthen the scenes.'
      );
    }
  }
  return null;
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
   * Video models usable at this deployment: those for which
   * resolveVideoLocation finds a location (the configured Veo location, or
   * global as the fallback).
   * Matches the backend model/location validator. Sorted: Firestore returns
   * map keys sorted, the shipped fallback keeps file order.
   */
  readonly videoModels = computed(() => {
    const catalog = this.globalConfig.value()?.modelCatalog;
    if (!catalog) {
      return [];
    }
    return Object.entries(catalog.models)
      .filter(
        ([id, model]) =>
          model.actions.includes('generate_video') &&
          this.resolveVideoLocation(id) !== undefined,
      )
      .map(([id]) => id)
      .sort();
  });

  /**
   * Video models that can run edit_video at a location resolveVideoLocation
   * finds (the configured Veo location, or global as the fallback).
   * Same shape as videoModels, filtered on the edit_video action instead.
   */
  readonly videoEditModels = computed(() => {
    const catalog = this.globalConfig.value()?.modelCatalog;
    if (!catalog) {
      return [];
    }
    return Object.entries(catalog.models)
      .filter(
        ([id, model]) =>
          model.actions.includes('edit_video') &&
          this.resolveVideoLocation(id) !== undefined,
      )
      .map(([id]) => id)
      .sort();
  });

  /** Whether the Edit button should be offered: some model can edit at this location. */
  readonly canEditCandidates = computed(
    () => this.videoEditModels().length > 0,
  );

  /**
   * The gcp_location to use for `model`'s video actions: the configured Veo
   * location when the model supports it, else 'global' when the model
   * supports that, else undefined (model unusable at this deployment). One
   * generic resolver for every model family.
   */
  resolveVideoLocation(model: string | undefined): string | undefined {
    const catalog = this.globalConfig.value()?.modelCatalog;
    const entry = model ? catalog?.models[model] : undefined;
    if (!entry) {
      return undefined;
    }
    const veoLocation = this.globalConfig.value()?.veoLocation;
    if (veoLocation && entry.locations.includes(veoLocation)) {
      return veoLocation;
    }
    return entry.locations.includes('global') ? 'global' : undefined;
  }

  /**
   * True when the project's current model always generates audio (per the
   * catalog's capabilities.audio_always_on), so the audio toggle should show
   * on and disabled instead of following projectConfig.generateAudio.
   */
  readonly audioLocked = computed(() => {
    const catalog = this.globalConfig.value()?.modelCatalog;
    const model = this.projectConfig.value().model;
    return catalog?.models[model]?.capabilities?.['audio_always_on'] === true;
  });

  /** The selected model's catalog entry, or undefined off-catalog/pre-load. */
  private catalogEntry(
    model: string | undefined,
  ): ModelCatalogEntry | undefined {
    if (!model) {
      return undefined;
    }
    return this.globalConfig.value()?.modelCatalog?.models[model];
  }

  /**
   * `model`'s capabilities.allowed_resolutions, filtered to known Resolution
   * values and kept in catalog order; FALLBACK_RESOLUTIONS when missing.
   * Does not inject the persisted project value — callers that must always
   * include it (the public signal, the setters) add it themselves.
   */
  private catalogAllowedResolutions(model: string | undefined): Resolution[] {
    const raw = this.catalogEntry(model)?.capabilities?.['allowed_resolutions'];
    if (Array.isArray(raw)) {
      return raw.filter((r): r is Resolution =>
        KNOWN_RESOLUTIONS.includes(r as Resolution),
      );
    }
    return [...FALLBACK_RESOLUTIONS];
  }

  /** Same pattern as {@link catalogAllowedResolutions}, for allowed_aspect_ratios. */
  private catalogAllowedAspectRatios(model: string | undefined): AspectRatio[] {
    const raw =
      this.catalogEntry(model)?.capabilities?.['allowed_aspect_ratios'];
    if (Array.isArray(raw)) {
      return raw.filter((a): a is AspectRatio =>
        KNOWN_ASPECT_RATIOS.includes(a as AspectRatio),
      );
    }
    return [...FALLBACK_ASPECT_RATIOS];
  }

  /**
   * `model`'s capabilities.duration_by_resolution[resolution] as a sorted
   * list of integers; FALLBACK_DURATIONS when the field or the resolution
   * key is missing. Does not inject the persisted project value.
   */
  private catalogAllowedDurations(
    model: string | undefined,
    resolution: Resolution | undefined,
  ): number[] {
    const byResolution = this.catalogEntry(model)?.capabilities?.[
      'duration_by_resolution'
    ] as Record<string, unknown> | undefined;
    const raw = resolution ? byResolution?.[resolution] : undefined;
    if (Array.isArray(raw)) {
      return raw
        .filter((n): n is number => typeof n === 'number')
        .sort((a, b) => a - b);
    }
    return [...FALLBACK_DURATIONS];
  }

  /**
   * Resolutions the current project's model offers, per its catalog entry
   * (see {@link catalogAllowedResolutions}). A persisted value the model no
   * longer offers is not appended here; it is snapped to an allowed value by
   * {@link computeModelSwitch} on model switch, fallback and project load.
   */
  readonly allowedResolutions = computed(() =>
    this.catalogAllowedResolutions(this.projectConfig.value().model),
  );

  /** Same pattern as {@link allowedResolutions}, for aspect ratios. */
  readonly allowedAspectRatios = computed(() =>
    this.catalogAllowedAspectRatios(this.projectConfig.value().model),
  );

  /**
   * Candidate durations the current project's model/resolution offers (see
   * {@link catalogAllowedDurations}). A persisted value the model no longer
   * offers is not appended here; it is snapped to the nearest allowed value
   * by {@link computeModelSwitch} on model switch, fallback and project load.
   */
  readonly allowedDurations = computed(() => {
    const project = this.projectConfig.value();
    return this.catalogAllowedDurations(project.model, project.resolution);
  });

  /**
   * The candidate-duration slider's bounds, derived from allowedDurations():
   * min/max are its first/last values; step is the greatest common divisor
   * of the gaps between consecutive values (1 when there is only one value).
   */
  readonly durationSlider = computed(() => {
    const durations = this.allowedDurations();
    const min = durations[0];
    const max = durations[durations.length - 1];
    const gaps: number[] = [];
    for (let i = 1; i < durations.length; i++) {
      gaps.push(durations[i] - durations[i - 1]);
    }
    const step = gaps.length > 0 ? gaps.reduce((g, d) => gcd(g, d), 0) : 1;
    return {min, max, step};
  });

  /**
   * Partial ProjectConfig changes to switch to `model`: the model itself, plus
   * resolution, duration and aspect ratio snapped to values model's catalog
   * entry allows (left untouched if already allowed).
   */
  private computeModelSwitch(
    model: string,
    project: ProjectConfig,
  ): Partial<ProjectConfig> {
    const partial: Partial<ProjectConfig> = {model};

    const resolutions = this.catalogAllowedResolutions(model);
    let resolution = project.resolution;
    if (resolutions.length > 0 && !resolutions.includes(resolution)) {
      resolution = resolutions[0];
      partial.resolution = resolution;
    }

    const durations = this.catalogAllowedDurations(model, resolution);
    if (!durations.includes(project.candidateDurationSeconds)) {
      partial.candidateDurationSeconds = nearestAllowed(
        durations,
        project.candidateDurationSeconds,
      );
    }

    const aspectRatios = this.catalogAllowedAspectRatios(model);
    if (
      aspectRatios.length > 0 &&
      !aspectRatios.includes(project.aspectRatio)
    ) {
      partial.aspectRatio = aspectRatios[0];
    }

    return partial;
  }

  /**
   * Switches the project's video model and snaps resolution, duration and
   * aspect ratio to values the new model's catalog entry allows, in one
   * updateProjectConfig call. A value already allowed is left untouched.
   */
  selectVideoModel(model: string) {
    const partial = this.computeModelSwitch(model, this.projectConfig.value());
    this.updateProjectConfig(partial);
  }

  /**
   * Switches the project's resolution and snaps the candidate duration to
   * the nearest value the new resolution allows (ties go to the shorter one).
   */
  selectResolution(resolution: Resolution) {
    const project = this.projectConfig.value();
    const partial: Partial<ProjectConfig> = {resolution};

    const durations = this.catalogAllowedDurations(project.model, resolution);
    if (!durations.includes(project.candidateDurationSeconds)) {
      partial.candidateDurationSeconds = nearestAllowed(
        durations,
        project.candidateDurationSeconds,
      );
    }

    this.updateProjectConfig(partial);
  }

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
    // Snap resolution/duration/aspect ratio a persisted project's own (still
    // valid) model no longer allows, so a stale combination from before a
    // catalog change is never posted verbatim.
    const partial = this.computeModelSwitch(data.model, data);
    return {...data, ...partial};
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
      const partial = this.computeModelSwitch(fallback, project);
      if (shouldPersistCorrection) {
        this.updateProjectConfig(partial);
        const unavailableModel = previous
          ? `Video model ${previous}`
          : 'The saved video model';
        this.matSnackBar.open(
          `${unavailableModel} is no longer available; switched to ${fallback}.`,
          'OK',
        );
      } else {
        // A catalog correction alone must not create a new project.
        this.projectConfig.value.update(c => ({...c, ...partial}));
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
    // Fence the project BEFORE the request, not after it resolves: while a
    // DELETE is in flight the save state would otherwise still be current, so
    // an in-flight save completing mid-deletion would dispatch its queued
    // successor against the project being deleted. Dropping the state first
    // makes every outstanding callback fail its isCurrentSaveState check.
    //
    // This orders the client's own writes. A PATCH already dispatched to the
    // server can still be processed after the DELETE arrives; that ordering
    // is the server's to guarantee.
    this.persistedProjectIds.delete(projectId);
    this.projectSaveStates.delete(projectId);
    await firstValueFrom(this.httpClient.delete(`/api/projects/${projectId}`));
  }
}
