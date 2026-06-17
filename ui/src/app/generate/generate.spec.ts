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
import {provideRouter} from '@angular/router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {routes} from '../app.routes';
import {ConfigService} from '../services/config/config';
import {Generate} from './generate';
import '../testing/mocks/match-media.mock';

describe('Generate', () => {
  let component: Generate;
  let fixture: ComponentFixture<Generate>;
  let configMock: {
    setNewProject: ReturnType<typeof vi.fn>;
    saveNow: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    configMock = {
      setNewProject: vi.fn(),
      saveNow: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Generate],
      providers: [
        provideRouter(routes),
        {provide: ConfigService, useValue: configMock},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Generate);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('persists the brand-new project immediately on creation', () => {
    // A discrete creation event: the project is set up and then saved right
    // away (saveNow), so it exists server-side and shows on the homepage
    // without waiting for the 5s autosave.
    expect(configMock.setNewProject).toHaveBeenCalledTimes(1);
    expect(configMock.saveNow).toHaveBeenCalledTimes(1);

    // saveNow runs after the project is set up.
    const setNewOrder = configMock.setNewProject.mock.invocationCallOrder[0];
    const saveNowOrder = configMock.saveNow.mock.invocationCallOrder[0];
    expect(saveNowOrder).toBeGreaterThan(setNewOrder);
  });
});
