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

import {
  computed,
  DOCUMENT,
  effect,
  EnvironmentInjector,
  inject,
  Injectable,
  resource,
  runInInjectionContext,
  signal,
} from '@angular/core';
import {toObservable} from '@angular/core/rxjs-interop';
import {Auth} from '@angular/fire/auth';
import {
  collection,
  deleteDoc,
  doc,
  Firestore,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from '@angular/fire/firestore';
import {Router} from '@angular/router';
import {debounceTime, distinctUntilChanged, skip} from 'rxjs';

/**
 * Default transition overlap duration in seconds.
 */
export const DEFAULT_TRANSITION_OVERLAP = 0.5;

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
  url: string; // Firebase Storage path with token, starting with https://
}

/**
 * List of available video generation models.
 */
export const VIDEO_GENERATION_MODELS = [
  'veo-3.1-generate-001',
  'veo-3.1-fast-generate-001',
  'veo-3.1-lite-generate-001',
];

interface GlobalConfig {
  // Backend API
  gatewayApiKey: string;
  gatewayBaseUrl: string;

  // GCP
  gcpLocation: string;
  gcpProject: string;
  gcsBucket: string;

  // Gemini
  geminiModel: string;
  geminiLocation: string;

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
 * Represents a generated scene.
 */
export interface GeneratedScene extends Scene {
  prompt: string;
  referenceImage?: GcsFile;
  candidates?: Candidate[];
  selectedCandidateIndex?: number;
}

/**
 * Represents a provided video scene.
 */
export interface ProvidedVideoScene extends Scene {
  video?: GcsFile;
  durationSeconds?: number;
  trim?: {start?: number; end?: number};
}

export interface ThumbnailMaterial {
  lowQualityThumbnail?: string;
  highQualityThumbnail?: string;
  referenceImage?: string;
  videoUrl?: string;
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
  private firestore = inject(Firestore);
  private router = inject(Router);
  private injector = inject(EnvironmentInjector);
  private document = inject(DOCUMENT);
  private auth = inject(Auth);
  private projectId = signal<string | null>(null);

  readonly VIDEO_GENERATION_MODELS = VIDEO_GENERATION_MODELS;

  globalConfig = resource({
    loader: async () => {
      const documentSnapshot = await runInInjectionContext(this.injector, () =>
        getDoc(doc(this.firestore, 'config/global')),
      );
      if (!documentSnapshot.exists()) {
        console.error('Global config object not found');
        return;
      }
      return documentSnapshot.data() as GlobalConfig;
    },
  });

  projectConfig = resource({
    params: () => ({projectId: this.projectId()}),
    loader: async ({params}) => {
      if (params.projectId === null) {
        return {...this.DEFAULT_PROJECT_CONFIG()};
      }
      const documentSnapshot = await runInInjectionContext(this.injector, () =>
        getDoc(doc(this.firestore, `projects/${params.projectId}`)),
      );
      if (!documentSnapshot.exists()) {
        void this.router.navigate(['/']);
        console.error(`Project ${params.projectId} does not exist.`);
        return {...this.DEFAULT_PROJECT_CONFIG()};
      }
      const data = documentSnapshot.data() as ProjectConfig;
      if (data.renderRuns) {
        data.renderRuns = data.renderRuns.map(run => {
          if (run.createdAt) {
            run.createdAt = (
              run.createdAt as unknown as {toDate: () => Date}
            ).toDate();
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
    },
    defaultValue: {...this.DEFAULT_PROJECT_CONFIG()},
  });

  shouldSave = false;

  theme = signal<string>(
    localStorage.getItem('theme') ??
      (this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)')
        ?.matches
        ? 'dark-mode'
        : 'light-mode'),
  );
  primaryColor = signal<string>(
    localStorage.getItem('primaryColor') ?? 'theme-azure',
  );
  constructor() {
    toObservable(this.projectConfig.value)
      .pipe(skip(1), debounceTime(5000), distinctUntilChanged())
      .subscribe(config => {
        if (!config.id) {
          return;
        }
        if (this.shouldSave) {
          config.lastEdited = new Date();
          runInInjectionContext(this.injector, () => {
            setDoc(doc(this.firestore, `projects/${config.id}`), config).catch(
              error => {
                console.error('Error saving project config:', error);
              },
            );
          });
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
        'theme-azure',
        'theme-magenta',
        'theme-green',
        'theme-orange',
        'theme-violet',
      );
      this.document.documentElement.classList.add(this.primaryColor());
    });
    this.initFaviconListener();
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
    this.projectConfig.set({
      ...this.DEFAULT_PROJECT_CONFIG(),
      id: uuid,
      name: 'Untitled Project',
      createdBy: this.auth.currentUser?.email ?? undefined,
    });
    this.shouldSave = false;
  }

  addRenderRun(renderRun: RenderRun) {
    this.updateProjectConfig({
      renderRuns: [renderRun, ...(this.projectConfig.value().renderRuns ?? [])],
    });
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
    this.projectId.set(projectId);
    this.shouldSave = false;
  }

  async getProjects(createdBy?: string): Promise<ProjectConfig[]> {
    return runInInjectionContext(this.injector, async () => {
      const projectsCollection = collection(this.firestore, 'projects');
      const projectsQuery = createdBy
        ? query(projectsCollection, where('createdBy', '==', createdBy))
        : projectsCollection;
      const querySnapshot = await getDocs(projectsQuery);

      return querySnapshot.docs.map(doc => {
        const data = doc.data() as ProjectConfig;
        // firestore converts Date objects automatically so we need to convert
        // them back.
        if (data.lastEdited) {
          data.lastEdited = (
            data.lastEdited as unknown as {toDate: () => Date}
          ).toDate();
        }
        return data;
      });
    });
  }

  async deleteProject(projectId: string) {
    return runInInjectionContext(this.injector, async () => {
      await deleteDoc(doc(this.firestore, `projects/${projectId}`));
    });
  }
}
