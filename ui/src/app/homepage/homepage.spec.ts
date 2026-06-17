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
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {provideRouter} from '@angular/router';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {env} from '../../env';
import {ConfigService} from '../services/config/config';
import {Homepage} from './homepage';

describe('Homepage', () => {
  let component: Homepage;
  let fixture: ComponentFixture<Homepage>;
  let mockConfigService = {
    resetProjectConfig: vi.fn(),
    getProjects: vi.fn().mockResolvedValue([]),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    theme: signal('light-mode'),
    primaryColor: signal('theme-azure'),
  };
  let mockMatDialog = {
    open: vi.fn().mockReturnValue({afterClosed: () => of(true)}),
  };
  // Restore controlPlaneMode after tests that mutate it, so the rendered env.ts
  // value (which varies by environment) is not leaked between specs.
  const initialControlPlaneMode = env.controlPlaneMode;

  // Creates the component. The Homepage reads env.controlPlaneMode at
  // construction to choose the default filter, so tests set env first then call
  // this.
  const createComponent = () => {
    fixture = TestBed.createComponent(Homepage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  beforeEach(async () => {
    // Default to deployed (IAP) so the existing tests see a verified identity.
    env.controlPlaneMode = 'iap';
    mockConfigService = {
      resetProjectConfig: vi.fn(),
      getProjects: vi.fn().mockResolvedValue([]),
      deleteProject: vi.fn().mockResolvedValue(undefined),
      theme: signal('light-mode'),
      primaryColor: signal('theme-azure'),
    };
    mockMatDialog = {
      open: vi.fn().mockReturnValue({afterClosed: () => of(true)}),
    };

    await TestBed.configureTestingModule({
      imports: [Homepage],
      providers: [
        provideRouter([]),
        {provide: ConfigService, useValue: mockConfigService},
      ],
    })
      .overrideComponent(Homepage, {
        set: {providers: [{provide: MatDialog, useValue: mockMatDialog}]},
      })
      .compileComponents();

    createComponent();
  });

  afterEach(() => {
    env.controlPlaneMode = initialControlPlaneMode;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('fetches my projects only by default behind IAP (truthy createdBy flag)', () => {
    // Deployed (controlPlaneMode 'iap'): the server filters by the verified IAP
    // identity, so the client passes only a truthy "mine only" flag.
    expect(component.myProjectsOnly()).toBe(true);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(true);
  });

  it('fetches all projects by default in local dev (no verified identity)', () => {
    // Local dev (controlPlaneMode 'none'): there is no verified identity, so
    // createdBy=me would 400. Default the filter off and fetch all projects.
    env.controlPlaneMode = 'none';
    mockConfigService.getProjects.mockClear();
    createComponent();
    expect(component.myProjectsOnly()).toBe(false);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined createdBy when the my-projects filter is off', () => {
    mockConfigService.getProjects.mockClear();
    component.toggleFilter(false);
    expect(mockConfigService.getProjects).toHaveBeenCalledWith(undefined);
  });

  it('does not refetch the project list until the server delete resolves', async () => {
    // Let the constructor's synchronous fetch settle before measuring.
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();

    // Make deleteProject return a promise we control so we can observe the
    // ordering: the list must NOT be refetched while the delete is in flight.
    let resolveDelete!: () => void;
    const pendingDelete = new Promise<void>(resolve => {
      resolveDelete = resolve;
    });
    mockConfigService.deleteProject.mockReturnValue(pendingDelete);

    component.deleteProject('proj-1');

    // Let the afterClosed subscribe + async IIFE start and reach the await.
    await Promise.resolve();
    await Promise.resolve();

    // Delete was issued but, because it is still pending, the list must not
    // have been refetched yet (this is the race the fix closes).
    expect(mockConfigService.deleteProject).toHaveBeenCalledWith('proj-1');
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();

    // Now let the server delete complete.
    resolveDelete();
    await pendingDelete;
    // Flush the microtasks for the awaited refetch.
    await Promise.resolve();
    await Promise.resolve();

    // Only after the delete resolved should the list be re-read.
    expect(mockConfigService.getProjects).toHaveBeenCalledTimes(1);
  });

  it('does not refetch the project list when the server delete fails', async () => {
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();

    mockConfigService.deleteProject.mockRejectedValue(new Error('boom'));

    component.deleteProject('proj-1');

    // Flush the rejected delete + the catch branch.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConfigService.deleteProject).toHaveBeenCalledWith('proj-1');
    // A failed delete must leave the list untouched (no optimistic removal,
    // no refetch) so the project is not falsely shown as deleted.
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();
  });

  it('does not delete when the confirm dialog is dismissed', async () => {
    await Promise.resolve();
    await Promise.resolve();
    mockConfigService.getProjects.mockClear();
    mockMatDialog.open.mockReturnValue({afterClosed: () => of(false)});

    component.deleteProject('proj-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConfigService.deleteProject).not.toHaveBeenCalled();
    expect(mockConfigService.getProjects).not.toHaveBeenCalled();
  });
});
