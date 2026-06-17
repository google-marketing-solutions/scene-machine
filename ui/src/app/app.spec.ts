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

import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {env} from '../env';
import {App} from './app';
import {RemixEngineService} from './services/remix-engine/remix-engine';
import './testing/mocks/match-media.mock';

// Pin the data plane so these specs do not depend on the rendered
// (gitignored) src/env.ts.
vi.mock('../env', async importOriginal => {
  const actual = await importOriginal<typeof import('../env')>();
  return {
    env: {...actual.env, dataPlaneMode: 'mediated'},
  };
});

describe('App', () => {
  let remixEngineInstantiations: number;
  // Restore controlPlaneMode after the 'none' test mutates it, so the rendered
  // env.ts value (which varies by environment) is not leaked between specs.
  const initialControlPlaneMode = env.controlPlaneMode;

  beforeEach(async () => {
    vi.clearAllMocks();
    remixEngineInstantiations = 0;
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: RemixEngineService,
          useFactory: () => {
            remixEngineInstantiations++;
            return {};
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    env.dataPlaneMode = 'mediated';
    env.controlPlaneMode = initialControlPlaneMode;
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should eagerly instantiate RemixEngineService in mediated mode (resume on any route)', () => {
    TestBed.createComponent(App);
    expect(remixEngineInstantiations).toBe(1);
  });

  it('controlPlaneMode "none" marks the app signed in', async () => {
    // Local dev: ngOnInit must short-circuit and treat the developer as signed
    // in so the UI renders and calls /api.
    env.controlPlaneMode = 'none';
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      loggedIn: () => boolean;
    };
    await fixture.componentInstance.ngOnInit();
    expect(app.loggedIn()).toBe(true);
  });

  it('login() marks the app signed in', () => {
    // Behind IAP the user is already authenticated, so login() simply flips the
    // logged-in signal; there is no session to acquire.
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      loggedIn: () => boolean;
      login: () => void;
    };
    expect(app.loggedIn()).toBe(false);
    app.login();
    expect(app.loggedIn()).toBe(true);
  });
});
