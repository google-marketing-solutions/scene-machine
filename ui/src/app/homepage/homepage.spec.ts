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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Auth} from '@angular/fire/auth';
import {provideRouter} from '@angular/router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService} from '../services/config/config';
import {Homepage} from './homepage';

describe('Homepage', () => {
  let component: Homepage;
  let fixture: ComponentFixture<Homepage>;
  let mockConfigService = {
    resetProjectConfig: vi.fn(),
    getProjects: vi.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    mockConfigService = {
      resetProjectConfig: vi.fn(),
      getProjects: vi.fn().mockResolvedValue([]),
    };

    await TestBed.configureTestingModule({
      imports: [Homepage],
      providers: [
        provideRouter([]),
        {provide: ConfigService, useValue: mockConfigService},
        {
          provide: Auth,
          useValue: {authStateReady: vi.fn().mockResolvedValue(undefined)},
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Homepage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
