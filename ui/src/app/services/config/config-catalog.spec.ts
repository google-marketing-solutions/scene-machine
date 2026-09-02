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
import {ConfigService, ModelCatalog} from './config';

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

    expect(service.videoModels()).toEqual(['veo-central-only', 'veo-default']);
  });

  it('is empty while the catalog or location is missing', async () => {
    await settle();
    (service as any).globalConfig.set(undefined);
    expect(service.videoModels()).toEqual([]);

    (service as any).globalConfig.set(
      liveGlobalConfig({veoLocation: undefined}),
    );
    expect(service.videoModels()).toEqual([]);
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

  it('is empty and non-editable at a location the edit model does not list', async () => {
    await settle();
    (service as any).globalConfig.set(
      liveGlobalConfig({
        veoLocation: 'us-central1',
        modelCatalog: CATALOG_WITH_OMNI,
      }),
    );

    expect(service.videoEditModels()).toEqual([]);
    expect(service.canEditCandidates()).toBe(false);
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
        // At us-central1 the compatible set is veo-central-only and
        // veo-default; point the default at an incompatible model.
        modelCatalog: {
          ...CATALOG,
          defaults: {veo: 'veo-fast'},
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
