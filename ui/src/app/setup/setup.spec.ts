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
import {Auth} from '@angular/fire/auth';
import {Firestore} from '@angular/fire/firestore';
import {Storage} from '@angular/fire/storage';
import {provideRouter} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {routes} from '../app.routes';
import {Setup} from './setup';

describe('Setup', () => {
  let component: Setup;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Setup],
      providers: [
        provideRouter(routes),
        {provide: Firestore, useValue: vi.mockObject(Firestore)},
        {provide: Storage, useValue: {}},
        {provide: Auth, useValue: vi.mockObject(Auth)},
      ],
    }).compileComponents();

    const harness = await RouterTestingHarness.create();
    component = await harness.navigateByUrl('/abc123/setup', Setup);
    harness.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
