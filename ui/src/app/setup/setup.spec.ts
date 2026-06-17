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

import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {routes} from '../app.routes';
import {ConfigService, ProjectConfig} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Setup} from './setup';
import '../testing/mocks/match-media.mock';

describe('Setup', () => {
  let component: Setup;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Setup],
      providers: [provideRouter(routes)],
    }).compileComponents();

    const harness = await RouterTestingHarness.create();
    component = await harness.navigateByUrl('/abc123/setup', Setup);
    harness.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('Setup image upload', () => {
  let component: Setup;
  let configMock: {
    projectConfig: {value: ReturnType<typeof signal<Partial<ProjectConfig>>>};
    updateProjectConfig: ReturnType<typeof vi.fn>;
    saveNow: ReturnType<typeof vi.fn>;
    VIDEO_GENERATION_MODELS: string[];
  };
  let remixMock: {uploadMedia: ReturnType<typeof vi.fn>};

  beforeEach(async () => {
    const projectConfig = signal<Partial<ProjectConfig>>({
      id: 'proj-1',
      inputConfig: {
        products: [{id: 1, name: 'Product 1', images: []}],
        composition: '',
        style: '',
        audience: '',
      },
    });
    configMock = {
      projectConfig: {value: projectConfig},
      // Mirror the real updateProjectConfig signal merge so processFiles'
      // reads of the latest value behave like production.
      updateProjectConfig: vi.fn((partial: Partial<ProjectConfig>) =>
        projectConfig.update(c => ({...c, ...partial})),
      ),
      saveNow: vi.fn(),
      // The component's model effect reads this; empty keeps the effect's
      // guard (length > 0) false so it does not fire an extra config update.
      VIDEO_GENERATION_MODELS: [],
    };
    remixMock = {
      uploadMedia: vi
        .fn()
        .mockResolvedValue({path: 'remix-input/x', url: 'https://x'}),
    };

    TestBed.configureTestingModule({
      imports: [Setup],
      providers: [
        provideRouter(routes),
        {provide: ConfigService, useValue: configMock},
        {provide: RemixEngineService, useValue: remixMock},
      ],
    });
    // Swap the template for an empty one: this test exercises the
    // processFiles() class logic only, so the full markup (which reads many
    // ConfigService members not on this focused mock) must not render.
    TestBed.overrideComponent(Setup, {set: {template: ''}});
    await TestBed.compileComponents();

    const fixture = TestBed.createComponent(Setup);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('persists immediately once after an image upload resolves', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.jpeg', {
      type: 'image/jpeg',
    });

    component.processFiles(1, [file] as unknown as FileList);
    // Let the upload Promise.all + .then microtasks settle.
    await new Promise(r => setTimeout(r, 0));

    expect(remixMock.uploadMedia).toHaveBeenCalledTimes(1);
    // The uploaded image was recorded on the product...
    expect(configMock.updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(
      configMock.projectConfig.value().inputConfig?.products[0].images,
    ).toEqual([{path: 'remix-input/x', url: 'https://x', name: 'pic.jpeg'}]);
    // ...and persisted right away exactly once (the discrete upload event).
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);
    // saveNow runs after the config update that recorded the new image.
    expect(configMock.saveNow.mock.invocationCallOrder[0]).toBeGreaterThan(
      configMock.updateProjectConfig.mock.invocationCallOrder[0],
    );
  });
});
