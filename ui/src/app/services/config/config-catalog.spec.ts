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
import {DOCUMENT} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService, ModelCatalog, ProjectConfig} from './config';

const CATALOG: ModelCatalog = {
  defaults: {veo: 'veo-default', image: 'image-a'},
  actions: {
    generate_video: {location_param: 'gcp_location', default_key: 'veoModel'},
    generate_image: {
      location_param: 'image_location',
      default_key: 'imageModel',
    },
  },
  models: {
    'veo-default': {
      family: 'veo',
      actions: ['generate_video'],
      locations: ['global', 'us-central1'],
    },
    'veo-fast': {
      family: 'veo',
      actions: ['generate_video'],
      locations: ['global'],
    },
    'veo-central-only': {
      family: 'veo',
      actions: ['generate_video'],
      locations: ['us-central1'],
    },
    'image-a': {
      family: 'image',
      actions: ['generate_image'],
      locations: ['global'],
    },
  },
};

/**
 * CATALOG plus an Omni-like entry that can edit video and always generates
 * audio. Kept separate from CATALOG (rather than adding to it in place) so
 * the existing videoModels()/model-fallback specs above — which assert exact
 * arrays over CATALOG at 'global' and 'us-central1' — are not perturbed by a
 * model that also lists 'generate_video'.
 */
const CATALOG_WITH_OMNI: ModelCatalog = {
  ...CATALOG,
  defaults: {...CATALOG.defaults, omni: 'omni-1'},
  actions: {
    ...CATALOG.actions,
    edit_video: {location_param: 'gcp_location', default_key: 'veoModel'},
  },
  models: {
    ...CATALOG.models,
    'omni-1': {
      family: 'omni',
      actions: ['generate_video', 'edit_video'],
      locations: ['global'],
      capabilities: {audio_always_on: true},
    },
  },
};

/** A served /api/config payload with the live catalog. */
function liveGlobalConfig(overrides: Record<string, unknown> = {}) {
  return {
    veoLocation: 'global',
    veoModel: 'veo-default',
    modelCatalog: CATALOG,
    modelCatalogSource: 'firestore',
    ...overrides,
  };
}

describe('ConfigService model catalog', () => {
  let service: ConfigService;
  let httpClientMock: any;
  let matSnackBarMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    httpClientMock = {
      get: vi.fn().mockReturnValue(of({})),
      post: vi.fn().mockReturnValue(of({id: 'created'})),
      patch: vi.fn().mockReturnValue(of({})),
      delete: vi.fn().mockReturnValue(of({})),
    };
    matSnackBarMock = {
      open: vi.fn().mockReturnValue({onAction: () => of()}),
    };
    const documentMock = {
      documentElement: {classList: {add: vi.fn(), remove: vi.fn()}},
      defaultView: {
        matchMedia: vi
          .fn()
          .mockReturnValue({matches: false, addEventListener: vi.fn()}),
      },
      querySelector: vi.fn(),
    };
    (globalThis as any).localStorage = {getItem: vi.fn(), setItem: vi.fn()};

    TestBed.configureTestingModule({
      providers: [
        ConfigService,
        {provide: HttpClient, useValue: httpClientMock},
        {provide: MatSnackBar, useValue: matSnackBarMock},
        {provide: Router, useValue: {navigate: vi.fn()}},
        {provide: DOCUMENT, useValue: documentMock},
      ],
    });
    service = TestBed.inject(ConfigService);
  });

  /** Lets the resource loaders resolve once and flushes pending effects. */
  async function settle() {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
  }

  it('lists only generate_video models available at the Veo location', async () => {
    await settle();
    (service as any).globalConfig.set(liveGlobalConfig());

    // 'veo-central-only' is a video model but not at veoLocation 'global';
    // 'image-a' is at 'global' but not a video model.
    expect(service.videoModels()).toEqual(['veo-default', 'veo-fast']);
  });

  it('follows the configured Veo location', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({veoLocation: 'us-central1'}),
    );

    // 'veo-fast' is global-only in this catalog but the resolver's global
    // fallback applies to every model uniformly, so it stays visible even at
    // a location it does not itself list.
    expect(service.videoModels()).toEqual([
      'veo-central-only',
      'veo-default',
      'veo-fast',
    ]);
  });

  it('is empty while the catalog is missing', async () => {
    await settle();
    (service as any).globalConfig.set(undefined);
    expect(service.videoModels()).toEqual([]);
  });

  it('lists global-capable models when veoLocation is missing but the catalog is present', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({veoLocation: undefined}),
    );
    expect(service.videoModels()).toEqual(['veo-default', 'veo-fast']);
  });

  it('switches an out-of-catalog project model to the veo default and says so', async () => {
    await settle();
    (service as any).globalConfig.set(liveGlobalConfig());
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-removed-by-operator',
    });

    TestBed.tick(); // flush the catalog effect

    expect(service.projectConfig.value().model).toBe('veo-default');
    expect(matSnackBarMock.open).toHaveBeenCalledWith(
      expect.stringContaining('veo-removed-by-operator'),
      'OK',
    );
  });

  it('corrects an untouched seeded default quietly, without dirtying the project', async () => {
    // A fresh project starts with model = config/global.veoModel, which the
    // user never picked. If the catalog no longer offers it, fix it without
    // a snackbar and without triggering the autosave that would POST an
    // orphan project.
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({veoModel: 'veo-retired-default'}),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-new',
      model: 'veo-retired-default',
    });
    (service as any).shouldSave = false;

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-default');
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
    expect((service as any).shouldSave).toBe(false);
  });

  it('posts a compatible model when creating from a removed deploy default', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({veoModel: 'veo-retired-default'}),
    );

    service.setNewProject('proj-new');
    service.saveNow();

    expect(httpClientMock.post).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({id: 'proj-new', model: 'veo-default'}),
    );
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
  });

  it('keeps a compatible deploy default when creating a project', async () => {
    await settle();
    (service as any).globalConfig.set(liveGlobalConfig({veoModel: 'veo-fast'}));

    service.setNewProject('proj-new');
    service.saveNow();

    expect(httpClientMock.post).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({id: 'proj-new', model: 'veo-fast'}),
    );
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
  });

  it('gives a saved project on the deploy default the visible, persisted rewrite', async () => {
    // Same model value as the untouched default, but the project is known
    // server-side: the correction must persist and be announced, or a reload
    // would bring the removed model back.
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({veoModel: 'veo-retired-default'}),
    );
    (service as any).persistedProjectIds.add('proj-1');
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-retired-default',
    });
    (service as any).shouldSave = false;

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-default');
    expect(matSnackBarMock.open).toHaveBeenCalledWith(
      expect.stringContaining('veo-retired-default'),
      'OK',
    );
    service.flushPendingSave();
    expect(httpClientMock.patch).toHaveBeenCalledWith(
      '/api/projects/proj-1',
      expect.objectContaining({id: 'proj-1', model: 'veo-default'}),
    );
  });

  it('persists the fallback for a saved project with no model', async () => {
    await settle();
    (service as any).globalConfig.set(liveGlobalConfig());
    (service as any).persistedProjectIds.add('proj-1');
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: '',
    });
    (service as any).shouldSave = false;

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-default');
    expect(matSnackBarMock.open).toHaveBeenCalledWith(
      expect.stringContaining('saved video model'),
      'OK',
    );
    service.flushPendingSave();
    expect(httpClientMock.patch).toHaveBeenCalledWith(
      '/api/projects/proj-1',
      expect.objectContaining({id: 'proj-1', model: 'veo-default'}),
    );
  });

  it('leaves a model that is in the catalog untouched', async () => {
    await settle();
    (service as any).globalConfig.set(liveGlobalConfig());
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-fast',
    });

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-fast');
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
  });

  it('never rewrites when the catalog is the shipped fallback', async () => {
    // The shipped file may lack an operator-added model; rewriting from it
    // autosaves and would permanently alter projects during a degradation.
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalogSource: 'shipped'}),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-added-live-only',
    });

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-added-live-only');
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
  });

  it('never rewrites while the catalog is missing', async () => {
    await settle();
    (service as any).globalConfig.set(undefined);
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-removed-by-operator',
    });

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-removed-by-operator');
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
  });

  it('lists edit-capable models at the veo location and reports editability', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_OMNI}),
    );

    expect(service.videoEditModels()).toEqual(['omni-1']);
    expect(service.canEditCandidates()).toBe(true);
  });

  it('includes the edit model via the global fallback at a location it does not list', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        veoLocation: 'us-central1',
        modelCatalog: CATALOG_WITH_OMNI,
      }),
    );

    expect(service.videoEditModels()).toEqual(['omni-1']);
    expect(service.canEditCandidates()).toBe(true);
  });

  it('shows both a regional Veo model and a global-only Omni model at a regional deployment', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        veoLocation: 'us-central1',
        modelCatalog: CATALOG_WITH_OMNI,
      }),
    );

    expect(service.videoModels()).toContain('veo-central-only');
    expect(service.videoModels()).toContain('omni-1');
    expect(service.videoEditModels()).toContain('omni-1');
  });

  it('excludes a model whose locations list neither the configured region nor global', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        veoLocation: 'us-central1',
        modelCatalog: {
          ...CATALOG_WITH_OMNI,
          models: {
            ...CATALOG_WITH_OMNI.models,
            'region-only': {
              family: 'veo',
              actions: ['generate_video', 'edit_video'],
              locations: ['us-east1'],
            },
          },
        },
      }),
    );

    expect(service.videoModels()).not.toContain('region-only');
    expect(service.videoEditModels()).not.toContain('region-only');
  });

  describe('resolveVideoLocation', () => {
    it('returns the configured Veo location when the model supports it', async () => {
      await settle();
      (service as any).globalConfig.set(
        liveGlobalConfig({veoLocation: 'us-central1', modelCatalog: CATALOG}),
      );
      expect(service.resolveVideoLocation('veo-default')).toBe('us-central1');
    });

    it('falls back to global when the model does not support the configured location', async () => {
      await settle();
      (service as any).globalConfig.set(
        liveGlobalConfig({
          veoLocation: 'us-central1',
          modelCatalog: CATALOG_WITH_OMNI,
        }),
      );
      expect(service.resolveVideoLocation('omni-1')).toBe('global');
    });

    it('returns undefined for a model unusable at this deployment', async () => {
      await settle();
      (service as any).globalConfig.set(
        liveGlobalConfig({
          veoLocation: 'us-central1',
          modelCatalog: {
            ...CATALOG,
            models: {
              ...CATALOG.models,
              'region-only': {
                family: 'veo',
                actions: ['generate_video'],
                locations: ['us-east1'],
              },
            },
          },
        }),
      );
      expect(service.resolveVideoLocation('region-only')).toBeUndefined();
    });

    it('returns undefined for an unknown model', async () => {
      await settle();
      (service as any).globalConfig.set(liveGlobalConfig());
      expect(service.resolveVideoLocation('not-in-catalog')).toBeUndefined();
      expect(service.resolveVideoLocation(undefined)).toBeUndefined();
    });
  });

  it('locks audio on when the project model always generates audio', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_OMNI}),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'omni-1',
    });

    expect(service.audioLocked()).toBe(true);
  });

  it('does not lock audio for a model without audio_always_on, or when the catalog is missing', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_OMNI}),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-default',
    });
    expect(service.audioLocked()).toBe(false);

    (service as any).globalConfig.set(undefined);
    expect(service.audioLocked()).toBe(false);
  });

  it('falls back within location-compatible models when the veo default is unusable', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        veoLocation: 'us-central1',
        // At us-central1 the compatible set (direct match or global
        // fallback) is veo-central-only, veo-default and veo-fast; point
        // the default at a model that lists neither, so it stays
        // incompatible even with the global fallback.
        modelCatalog: {
          ...CATALOG,
          defaults: {veo: 'veo-region-only-default'},
          models: {
            ...CATALOG.models,
            'veo-region-only-default': {
              family: 'veo',
              actions: ['generate_video'],
              locations: ['us-east1'],
            },
          },
        },
      }),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      model: 'veo-removed-by-operator',
    });

    TestBed.tick();

    expect(service.projectConfig.value().model).toBe('veo-central-only');
  });
});

describe('ConfigService video controls', () => {
  let service: ConfigService;
  let httpClientMock: any;
  let matSnackBarMock: any;

  /** Veo capabilities as documented for the catalog (PR spec). */
  const VEO_CAPABILITIES = {
    allowed_resolutions: ['720p', '1080p', '4k'],
    allowed_aspect_ratios: ['16:9', '9:16'],
    duration_by_resolution: {
      '720p': [4, 6, 8],
      '1080p': [4, 6, 8],
      '4k': [8],
    },
  };
  /** Omni capabilities: wider resolutions, 3-10s at every resolution. */
  const OMNI_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10];
  const OMNI_CAPABILITIES = {
    audio_always_on: true,
    allowed_resolutions: ['360p', '720p', '1080p', '4k'],
    allowed_aspect_ratios: ['16:9', '9:16'],
    duration_by_resolution: {
      '360p': OMNI_DURATIONS,
      '720p': OMNI_DURATIONS,
      '1080p': OMNI_DURATIONS,
      '4k': OMNI_DURATIONS,
    },
  };
  const CATALOG_WITH_CAPABILITIES: ModelCatalog = {
    ...CATALOG_WITH_OMNI,
    models: {
      ...CATALOG_WITH_OMNI.models,
      'veo-default': {
        ...CATALOG.models['veo-default'],
        capabilities: VEO_CAPABILITIES,
      },
      'omni-1': {
        ...CATALOG_WITH_OMNI.models['omni-1'],
        capabilities: OMNI_CAPABILITIES,
      },
      // A model with a restricted, single-value allowed_aspect_ratios, used
      // to exercise the persisted-value-append path for aspect ratio.
      'veo-9-16-only': {
        family: 'veo',
        actions: ['generate_video'],
        locations: ['global'],
        capabilities: {allowed_aspect_ratios: ['9:16']},
      },
      // A model whose catalog lists an unknown value alongside known ones,
      // out of KNOWN_RESOLUTIONS/KNOWN_ASPECT_RATIOS order, to pin that the
      // unknown value is dropped and catalog order (not KNOWN order) wins.
      'veo-odd-caps': {
        family: 'veo',
        actions: ['generate_video'],
        locations: ['global'],
        capabilities: {
          allowed_resolutions: ['8k', '1080p', '720p'],
          allowed_aspect_ratios: ['1:1', '9:16', '16:9'],
        },
      },
      // A model whose duration_by_resolution list is not already sorted, to
      // pin that allowedDurations() sorts it rather than passing it through.
      'veo-unsorted-durations': {
        family: 'veo',
        actions: ['generate_video'],
        locations: ['global'],
        capabilities: {
          allowed_resolutions: ['720p'],
          duration_by_resolution: {'720p': [8, 4, 6]},
        },
      },
      // A model whose allowed_resolutions lists only unknown values, so the
      // filtered list is empty; used to pin that selectVideoModel leaves the
      // current resolution untouched rather than writing undefined.
      'veo-unknown-only': {
        family: 'veo',
        actions: ['generate_video'],
        locations: ['global'],
        capabilities: {allowed_resolutions: ['8k']},
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    httpClientMock = {
      get: vi.fn().mockReturnValue(of({})),
      post: vi.fn().mockReturnValue(of({id: 'created'})),
      patch: vi.fn().mockReturnValue(of({})),
      delete: vi.fn().mockReturnValue(of({})),
    };
    matSnackBarMock = {
      open: vi.fn().mockReturnValue({onAction: () => of()}),
    };
    const documentMock = {
      documentElement: {classList: {add: vi.fn(), remove: vi.fn()}},
      defaultView: {
        matchMedia: vi
          .fn()
          .mockReturnValue({matches: false, addEventListener: vi.fn()}),
      },
      querySelector: vi.fn(),
    };
    (globalThis as any).localStorage = {getItem: vi.fn(), setItem: vi.fn()};

    TestBed.configureTestingModule({
      providers: [
        ConfigService,
        {provide: HttpClient, useValue: httpClientMock},
        {provide: MatSnackBar, useValue: matSnackBarMock},
        {provide: Router, useValue: {navigate: vi.fn()}},
        {provide: DOCUMENT, useValue: documentMock},
      ],
    });
    service = TestBed.inject(ConfigService);
  });

  async function settle() {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
  }

  /** Sets globalConfig to the capabilities catalog and the project to the given fields. */
  async function withProject(fields: Partial<ProjectConfig>) {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_CAPABILITIES}),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-1',
      ...fields,
    });
    TestBed.tick(); // flush the catalog-correction effect
  }

  describe('allowedResolutions', () => {
    it("returns the model's allowed_resolutions in catalog order", async () => {
      await withProject({model: 'veo-default', resolution: '1080p'});
      expect(service.allowedResolutions()).toEqual(['720p', '1080p', '4k']);
    });

    it('falls back to 720p/1080p when the model has no allowed_resolutions', async () => {
      await withProject({model: 'veo-fast', resolution: '720p'});
      expect(service.allowedResolutions()).toEqual(['720p', '1080p']);
    });

    it('does not include the persisted resolution when the model no longer offers it', async () => {
      await withProject({model: 'veo-fast', resolution: '4k'});
      expect(service.allowedResolutions()).toEqual(['720p', '1080p']);
    });

    it('drops values that are not a known Resolution and keeps the catalog order', async () => {
      await withProject({model: 'veo-odd-caps', resolution: '720p'});
      expect(service.allowedResolutions()).toEqual(['1080p', '720p']);
    });
  });

  describe('allowedAspectRatios', () => {
    it("returns the model's allowed_aspect_ratios", async () => {
      await withProject({model: 'omni-1', aspectRatio: '16:9'});
      expect(service.allowedAspectRatios()).toEqual(['16:9', '9:16']);
    });

    it('falls back to 16:9/9:16 when the model has no allowed_aspect_ratios', async () => {
      await withProject({model: 'veo-fast', aspectRatio: '16:9'});
      expect(service.allowedAspectRatios()).toEqual(['16:9', '9:16']);
    });

    it('does not include the persisted aspect ratio when the model no longer offers it', async () => {
      await withProject({model: 'veo-9-16-only', aspectRatio: '16:9'});
      expect(service.allowedAspectRatios()).toEqual(['9:16']);
    });

    it('drops values that are not a known AspectRatio and keeps the catalog order', async () => {
      await withProject({model: 'veo-odd-caps', aspectRatio: '9:16'});
      expect(service.allowedAspectRatios()).toEqual(['9:16', '16:9']);
    });
  });

  describe('allowedDurations', () => {
    it('returns duration_by_resolution for the current resolution, sorted', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '720p',
        candidateDurationSeconds: 6,
      });
      expect(service.allowedDurations()).toEqual([4, 6, 8]);
    });

    it('is a single value when the resolution only allows one duration', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '4k',
        candidateDurationSeconds: 8,
      });
      expect(service.allowedDurations()).toEqual([8]);
    });

    it('falls back to 4/6/8 when duration_by_resolution or the resolution key is missing', async () => {
      await withProject({
        model: 'veo-fast',
        resolution: '720p',
        candidateDurationSeconds: 6,
      });
      expect(service.allowedDurations()).toEqual([4, 6, 8]);

      await withProject({
        model: 'veo-default',
        resolution: '360p',
        candidateDurationSeconds: 6,
      });
      expect(service.allowedDurations()).toEqual([4, 6, 8]);
    });

    it('does not include the persisted duration when the resolution no longer offers it', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '4k',
        candidateDurationSeconds: 10,
      });
      expect(service.allowedDurations()).toEqual([8]);
    });

    it('sorts an unsorted duration_by_resolution list ascending', async () => {
      await withProject({
        model: 'veo-unsorted-durations',
        resolution: '720p',
        candidateDurationSeconds: 6,
      });
      expect(service.allowedDurations()).toEqual([4, 6, 8]);
      expect(service.durationSlider()).toEqual({min: 4, max: 8, step: 2});
    });
  });

  describe('durationSlider', () => {
    it('gives Veo at 720p a step of 2 (the gcd of the gaps)', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '720p',
        candidateDurationSeconds: 4,
      });
      expect(service.durationSlider()).toEqual({min: 4, max: 8, step: 2});
    });

    it('gives Veo at 4k a single-value slider', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '4k',
        candidateDurationSeconds: 8,
      });
      expect(service.durationSlider()).toEqual({min: 8, max: 8, step: 1});
    });

    it('gives Omni a 3-10s, 1s-step slider at any resolution', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '1080p',
        candidateDurationSeconds: 6,
      });
      expect(service.durationSlider()).toEqual({min: 3, max: 10, step: 1});
    });

    // The former "uses the gcd of unequal gaps once the persisted value is
    // appended" test is removed: it exercised the stale-value append that
    // allowedDurations() no longer performs. Coverage of the exact
    // catalog-backed slider bounds ({min:4,max:8,step:2} for Veo at 720p,
    // {min:3,max:10,step:1} for Omni) lives in the two tests above.
  });

  describe('selectVideoModel', () => {
    it('keeps resolution and duration when the new model still allows them', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '1080p',
        candidateDurationSeconds: 6,
        aspectRatio: '16:9',
      });

      service.selectVideoModel('omni-1');

      const project = service.projectConfig.value();
      expect(project.model).toBe('omni-1');
      expect(project.resolution).toBe('1080p');
      expect(project.candidateDurationSeconds).toBe(6);
    });

    it('snaps resolution and duration to the nearest allowed value when the new model does not offer them', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '360p',
        candidateDurationSeconds: 9,
        aspectRatio: '16:9',
      });

      service.selectVideoModel('veo-default');

      const project = service.projectConfig.value();
      expect(project.model).toBe('veo-default');
      expect(project.resolution).toBe('720p');
      expect(project.candidateDurationSeconds).toBe(8);
    });

    it('snaps only duration when resolution is still allowed', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '4k',
        candidateDurationSeconds: 10,
        aspectRatio: '16:9',
      });

      service.selectVideoModel('veo-default');

      const project = service.projectConfig.value();
      expect(project.model).toBe('veo-default');
      expect(project.resolution).toBe('4k');
      expect(project.candidateDurationSeconds).toBe(8);
    });

    it('snaps a tied duration to the shorter allowed value', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '720p',
        candidateDurationSeconds: 5,
        aspectRatio: '16:9',
      });

      service.selectVideoModel('veo-default');

      expect(service.projectConfig.value().resolution).toBe('720p');
      expect(service.projectConfig.value().candidateDurationSeconds).toBe(4);
    });

    it('snaps aspect ratio to the first allowed value when the new model does not offer it', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '720p',
        candidateDurationSeconds: 6,
        aspectRatio: '16:9',
      });
      const updateSpy = vi.spyOn(service, 'updateProjectConfig');

      service.selectVideoModel('veo-9-16-only');

      expect(service.projectConfig.value().aspectRatio).toBe('9:16');
      expect(updateSpy).toHaveBeenCalledWith({
        model: 'veo-9-16-only',
        aspectRatio: '9:16',
      });
    });

    it('writes every changed field in a single updateProjectConfig call', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '360p',
        candidateDurationSeconds: 9,
        aspectRatio: '16:9',
      });
      const updateSpy = vi.spyOn(service, 'updateProjectConfig');

      service.selectVideoModel('veo-default');

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith({
        model: 'veo-default',
        resolution: '720p',
        candidateDurationSeconds: 8,
      });
    });

    it('leaves resolution untouched when the new model filters to no known resolutions', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '1080p',
        candidateDurationSeconds: 6,
        aspectRatio: '16:9',
      });
      const updateSpy = vi.spyOn(service, 'updateProjectConfig');

      service.selectVideoModel('veo-unknown-only');

      expect(service.projectConfig.value().resolution).toBe('1080p');
      expect(updateSpy).toHaveBeenCalledWith({model: 'veo-unknown-only'});
    });
  });

  describe('selectResolution', () => {
    it('snaps duration to the nearest allowed value for the new resolution', async () => {
      await withProject({
        model: 'veo-default',
        resolution: '720p',
        candidateDurationSeconds: 6,
      });

      service.selectResolution('4k');

      const project = service.projectConfig.value();
      expect(project.resolution).toBe('4k');
      expect(project.candidateDurationSeconds).toBe(8);
    });

    it('leaves duration untouched when still allowed at the new resolution', async () => {
      await withProject({
        model: 'omni-1',
        resolution: '1080p',
        candidateDurationSeconds: 6,
      });

      service.selectResolution('360p');

      const project = service.projectConfig.value();
      expect(project.resolution).toBe('360p');
      expect(project.candidateDurationSeconds).toBe(6);
    });
  });

  it('automatic fallback posts a valid combination', async () => {
    // A project whose model has left the catalog, seeded with resolution and
    // duration the fallback model does not allow either.
    await withProject({
      model: 'veo-removed-by-operator',
      resolution: '360p',
      candidateDurationSeconds: 3,
      aspectRatio: '16:9',
    });

    const project = service.projectConfig.value();
    expect(project.model).toBe('veo-default');
    expect(service.allowedResolutions()).toContain(project.resolution);
    expect(service.allowedDurations()).toContain(
      project.candidateDurationSeconds,
    );
  });

  it('a loaded saved Omni project at 360p/10s whose model is gone falls back to Veo and posts a valid combination', async () => {
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_CAPABILITIES}),
    );
    httpClientMock.get.mockImplementation((url: string) =>
      url === '/api/projects/proj-omni-gone'
        ? of({
            id: 'proj-omni-gone',
            name: 'Loaded Omni Project',
            storyboard: [],
            aspectRatio: '16:9',
            resolution: '360p',
            candidateDurationSeconds: 10,
            generateAudio: true,
            numberOfCandidates: 1,
            model: 'omni-retired',
            inputConfig: {products: [], composition: ''},
            audioTracks: [],
            visualOverlays: [],
          })
        : of({}),
    );

    (service as any).projectId.set('proj-omni-gone');
    await settle();
    TestBed.tick(); // flush the catalog-correction effect

    const project = service.projectConfig.value();
    expect(project.model).toBe('veo-default');
    expect(service.allowedResolutions()).toContain(project.resolution);
    expect(project.resolution).not.toBe('360p');
    expect(service.allowedDurations()).toContain(
      project.candidateDurationSeconds,
    );
    expect(project.candidateDurationSeconds).not.toBe(10);
  });

  it('a loaded project whose model exists but whose duration is outside the catalog snaps to the nearest allowed value', async () => {
    (service as any).globalConfig.set(
      liveGlobalConfig({modelCatalog: CATALOG_WITH_CAPABILITIES}),
    );
    httpClientMock.get.mockImplementation((url: string) =>
      url === '/api/projects/proj-720'
        ? of({
            id: 'proj-720',
            name: 'Loaded Project',
            storyboard: [],
            aspectRatio: '16:9',
            resolution: '720p',
            candidateDurationSeconds: 7,
            generateAudio: false,
            numberOfCandidates: 1,
            model: 'veo-default',
            inputConfig: {products: [], composition: ''},
            audioTracks: [],
            visualOverlays: [],
          })
        : of({}),
    );

    (service as any).projectId.set('proj-720');
    await settle();

    const project = service.projectConfig.value();
    // duration_by_resolution['720p'] is [4, 6, 8]; 7 is equidistant from 6
    // and 8, and nearestAllowed ties go to the smaller value.
    expect(project.resolution).toBe('720p');
    expect(project.candidateDurationSeconds).toBe(6);
  });

  it('normalizes the quiet (unsaved deploy-default) fallback branch: snaps resolution and duration without dirtying the project', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        modelCatalog: CATALOG_WITH_CAPABILITIES,
        veoModel: 'veo-retired-default',
      }),
    );
    service.projectConfig.value.set({
      ...service.projectConfig.value(),
      id: 'proj-new',
      model: 'veo-retired-default',
      resolution: '360p',
      candidateDurationSeconds: 3,
    });
    (service as any).shouldSave = false;

    TestBed.tick();

    const project = service.projectConfig.value();
    expect(project.model).toBe('veo-default');
    expect(service.allowedResolutions()).toContain(project.resolution);
    expect(service.allowedDurations()).toContain(
      project.candidateDurationSeconds,
    );
    expect(matSnackBarMock.open).not.toHaveBeenCalled();
    expect((service as any).shouldSave).toBe(false);
  });
});
