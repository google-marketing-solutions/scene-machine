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
import {TestBed} from '@angular/core/testing';
import {Firestore} from '@angular/fire/firestore';
import {Storage} from '@angular/fire/storage';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService} from '../config/config';
import {RemixEngineService} from './remix-engine';

describe('RemixEngineService', () => {
  let service: RemixEngineService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {provide: Firestore, useValue: {}},
        {provide: Storage, useValue: {}},
        {provide: HttpClient, useValue: {}},
        {
          provide: ConfigService,
          useValue: {
            globalConfig: {value: vi.fn()},
            projectConfig: {value: vi.fn()},
          },
        },
      ],
    });
    service = TestBed.inject(RemixEngineService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
