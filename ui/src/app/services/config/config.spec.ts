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
import '@angular/compiler';
import {EnvironmentInjector, signal} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {Auth} from '@angular/fire/auth';
import {Firestore, getDoc, deleteDoc} from '@angular/fire/firestore';
import {Router} from '@angular/router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService, toDecimals} from './config';
import {of} from 'rxjs';

const mockGet = vi.fn();
const mockInjector = {get: mockGet};

// Mock @angular/core to bypass runInInjectionContext and provide inject
vi.mock('@angular/core', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    runInInjectionContext: vi.fn((injector: any, fn: () => any) => fn()),
    inject: vi.fn((token: any) => mockGet(token)),
    resource: vi.fn((options: any) => {
      const s = signal(options?.defaultValue ?? {});
      return {
        value: s,
        set: (val: any) => s.set(val),
        update: (fn: any) => s.update(fn),
      };
    }),
    effect: vi.fn(() => {
      return {
        destroy: vi.fn(),
      };
    }),
  };
});

// Mock @angular/core/rxjs-interop
vi.mock('@angular/core/rxjs-interop', async () => {
  return {
    toObservable: vi.fn((s: any) => of(s())),
  };
});

// Mock Firebase Firestore
vi.mock('@angular/fire/firestore', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    doc: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    deleteDoc: vi.fn(),
    collection: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    getDocs: vi.fn(),
  };
});

describe('ConfigService', () => {
  let service: ConfigService;
  let firestoreMock: any;
  let routerMock: any;
  let authMock: any;
  let documentMock: any;
  let localStorageMock: any;

  beforeEach(() => {
    firestoreMock = {};
    routerMock = {
      navigate: vi.fn(),
    };
    authMock = {
      currentUser: {email: 'test@example.com'},
    };
    documentMock = {
      documentElement: {
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
        },
      },
      defaultView: {
        matchMedia: vi.fn().mockReturnValue({
          matches: false,
          addEventListener: vi.fn(),
        }),
      },
      querySelector: vi.fn(),
    };

    localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };
    (globalThis as any).localStorage = localStorageMock;

    mockGet.mockImplementation((token: any) => {
      if (token === Firestore) return firestoreMock;
      if (token === Router) return routerMock;
      if (token === Auth) return authMock;
      if (token === DOCUMENT) return documentMock;
      if (token === EnvironmentInjector) return mockInjector;
      return null;
    });

    vi.clearAllMocks();

    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => ({aspectRatio: '16:9', resolution: '720p'}),
    } as any);

    service = new ConfigService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('toDecimals', () => {
    it('should truncate decimals', () => {
      expect(toDecimals(1.2345, 2)).toBe(1.23);
      expect(toDecimals(1.2345, 0)).toBe(1);
    });
  });

  describe('sceneIdCounter', () => {
    it('should return 1 when storyboard is empty', () => {
      service.projectConfig.value.set({storyboard: []} as any);
      expect(service.sceneIdCounter()).toBe(1);
    });

    it('should return max + 1 when storyboard has scenes', () => {
      service.projectConfig.value.set({
        storyboard: [{id: '1'}, {id: '3'}, {id: '2'}],
      } as any);
      expect(service.sceneIdCounter()).toBe(4);
    });
  });

  describe('Type Guards', () => {
    it('should identify generated scene', () => {
      expect(service.isGeneratedScene({type: 'generated'} as any)).toBe(true);
      expect(service.isGeneratedScene({type: 'video'} as any)).toBe(false);
      expect(service.isGeneratedScene(null)).toBe(false);
    });

    it('should identify provided video scene', () => {
      expect(service.isProvidedVideoScene({type: 'video'} as any)).toBe(true);
      expect(service.isProvidedVideoScene({type: 'generated'} as any)).toBe(
        false,
      );
      expect(service.isProvidedVideoScene(null)).toBe(false);
    });
  });

  describe('State Mutations', () => {
    it('should reset project config', () => {
      service.loadProjectConfig('some-id');
      service.resetProjectConfig();
      expect(service.projectConfig.value().id).toBe('');
      expect(service.shouldSave).toBe(false);
    });

    it('should update project config', () => {
      service.updateProjectConfig({name: 'New Name'});
      expect(service.projectConfig.value().name).toBe('New Name');
      expect(service.shouldSave).toBe(true);
    });

    it('should set new project', () => {
      service.setNewProject('uuid-123');
      expect(service.projectConfig.value().id).toBe('uuid-123');
      expect(service.projectConfig.value().name).toBe('Untitled Project');
      expect(service.shouldSave).toBe(false);
    });
  });

  describe('Firestore Operations', () => {
    it('should delete project', async () => {
      vi.mocked(deleteDoc).mockResolvedValue(undefined);
      await service.deleteProject('proj-id');
      expect(deleteDoc).toHaveBeenCalled();
    });
  });
});
