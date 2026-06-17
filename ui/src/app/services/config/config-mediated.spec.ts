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
import {HttpClient} from '@angular/common/http';
import {DOCUMENT} from '@angular/common';
import {EnvironmentInjector, signal} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService} from './config';

// Pin the env to the mediated data plane: these tests cover the
// flush-on-leave behavior, which must be active only in this mode.
vi.mock('../../../env', async importOriginal => {
  const actual = (await importOriginal()) as {env: Record<string, unknown>};
  return {
    env: {
      ...actual.env,
      dataPlaneMode: 'mediated',
    },
  };
});

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

// toObservable feeds the debounced autosave subscription; a per-test Subject
// lets the tests drive the (skip(1) → debounceTime(5000)) pipeline directly.
const toObservableSubject: {current: Subject<any> | null} = {current: null};
vi.mock('@angular/core/rxjs-interop', async () => {
  return {
    toObservable: vi.fn(() => toObservableSubject.current!),
  };
});

describe('ConfigService (mediated data plane)', () => {
  let service: ConfigService;
  let httpClientMock: any;
  let matSnackBarMock: any;

  function saveRequestCount() {
    return (
      httpClientMock.patch.mock.calls.length +
      httpClientMock.post.mock.calls.length
    );
  }

  /** Marks a project id as already persisted server-side (PATCH path). */
  function markPersisted(id: string) {
    (service as any).persistedProjectIds.add(id);
  }

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
    const routerMock = {navigate: vi.fn()};
    const documentMock = {
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
    (globalThis as any).localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };

    mockGet.mockImplementation((token: any) => {
      if (token === HttpClient) return httpClientMock;
      if (token === Router) return routerMock;
      if (token === DOCUMENT) return documentMock;
      if (token === MatSnackBar) return matSnackBarMock;
      if (token === EnvironmentInjector) return mockInjector;
      return null;
    });

    toObservableSubject.current = new Subject();
    service = new ConfigService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('flushPendingSave', () => {
    it('should PATCH immediately for a dirty, already-persisted project', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.flushPendingSave();

      // Immediate: no debounce timer was advanced.
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/proj-1',
        expect.objectContaining({id: 'proj-1', name: 'dirty'}),
      );
      expect(httpClientMock.post).not.toHaveBeenCalled();
      // lastEdited is stamped like the debounced autosave does.
      expect(httpClientMock.patch.mock.calls[0][1].lastEdited).toBeInstanceOf(
        Date,
      );
    });

    it('should POST immediately for a dirty, not-yet-persisted project', () => {
      service.updateProjectConfig({id: 'new-proj', name: 'dirty'});

      service.flushPendingSave();

      expect(httpClientMock.post).toHaveBeenCalledTimes(1);
      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({id: 'new-proj'}),
      );
      expect(httpClientMock.patch).not.toHaveBeenCalled();
    });

    it('should do nothing when there are no unsaved changes', () => {
      // Loaded-but-clean state: id present, shouldSave false.
      service.projectConfig.value.set({
        ...service.projectConfig.value(),
        id: 'proj-1',
      });
      expect(service.shouldSave).toBe(false);

      service.flushPendingSave();

      expect(saveRequestCount()).toBe(0);
    });

    it('should do nothing for the default (id-less) project', () => {
      service.updateProjectConfig({name: 'dirty but no id'});

      service.flushPendingSave();

      expect(saveRequestCount()).toBe(0);
    });

    it('persists via the mediated HTTP path, not Firestore', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      service.flushPendingSave();
      // The save must go through the mediated /api PATCH. (setDoc is no longer
      // imported by the service, so asserting it is unused proves nothing —
      // assert the HTTP path was actually taken instead.)
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/proj-1',
        expect.objectContaining({id: 'proj-1', name: 'dirty'}),
      );
    });
  });

  describe('saveNow (meaningful-action immediate persist)', () => {
    it('should PATCH immediately for a dirty, already-persisted project', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/proj-1',
        expect.objectContaining({id: 'proj-1', name: 'dirty'}),
      );
      expect(httpClientMock.post).not.toHaveBeenCalled();
      expect(httpClientMock.patch.mock.calls[0][1].lastEdited).toBeInstanceOf(
        Date,
      );
    });

    it('should POST immediately for a brand-new project even when shouldSave is false', () => {
      // setNewProject leaves shouldSave === false; flushPendingSave would
      // no-op, but saveNow must still create the project server-side so it
      // appears on the homepage right away.
      service.setNewProject('new-proj');
      expect(service.shouldSave).toBe(false);

      service.saveNow();

      expect(httpClientMock.post).toHaveBeenCalledTimes(1);
      expect(httpClientMock.post).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({id: 'new-proj', name: 'Untitled Project'}),
      );
      expect(httpClientMock.patch).not.toHaveBeenCalled();
    });

    it('should dedupe the trailing debounced emission (no double save)', () => {
      vi.useFakeTimers();
      markPersisted('proj-1');
      const initial = service.projectConfig.value();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      const dirty = service.projectConfig.value();

      service.saveNow();
      expect(saveRequestCount()).toBe(1);

      // The 5s autosave fires later carrying the exact object already saved.
      toObservableSubject.current!.next(initial); // consumed by skip(1)
      toObservableSubject.current!.next(dirty);
      vi.advanceTimersByTime(5000);

      expect(saveRequestCount()).toBe(1);
    });

    it('should dedupe the trailing debounce after a brand-new create', () => {
      vi.useFakeTimers();
      service.setNewProject('new-proj');
      const created = service.projectConfig.value();

      service.saveNow();
      expect(saveRequestCount()).toBe(1);
      expect(httpClientMock.post).toHaveBeenCalledTimes(1);

      // No edit since create: the same object re-emits via the debounce.
      toObservableSubject.current!.next({...created, id: ''}); // skip(1)
      toObservableSubject.current!.next(created);
      vi.advanceTimersByTime(5000);

      expect(saveRequestCount()).toBe(1);
    });

    it('should do nothing for the default (id-less) project', () => {
      service.updateProjectConfig({name: 'dirty but no id'});

      service.saveNow();

      expect(saveRequestCount()).toBe(0);
    });

    it('repeated saveNow of the same config should save once', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.saveNow();
      service.saveNow();

      expect(saveRequestCount()).toBe(1);
    });

    it('should still save a title committed after an immediate save', () => {
      // Mirrors the title-on-blur flow: a save, then more keystrokes, then a
      // later commit must persist the newer name.
      vi.useFakeTimers();
      markPersisted('proj-1');
      const initial = service.projectConfig.value();
      service.updateProjectConfig({id: 'proj-1', name: 'My Proj'});

      service.saveNow();
      expect(saveRequestCount()).toBe(1);

      service.updateProjectConfig({name: 'My Project'});
      const renamed = service.projectConfig.value();
      service.saveNow();
      expect(saveRequestCount()).toBe(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'My Project'}),
      );

      // And the trailing debounce on the latest object is still deduped.
      toObservableSubject.current!.next(initial); // skip(1)
      toObservableSubject.current!.next(renamed);
      vi.advanceTimersByTime(5000);
      expect(saveRequestCount()).toBe(2);
    });

    it('persists via the mediated HTTP path, not Firestore', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      service.saveNow();
      // The save must go through the mediated /api PATCH. (setDoc is no longer
      // imported by the service, so asserting it is unused proves nothing —
      // assert the HTTP path was actually taken instead.)
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/proj-1',
        expect.objectContaining({id: 'proj-1', name: 'dirty'}),
      );
    });

    it('title keystrokes (updateProjectConfig) must NOT persist per character', () => {
      // The title input binds (ngModelChange) -> updateProjectConfig per
      // keystroke; only the (blur) -> saveNow commit persists. Typing must
      // not POST/PATCH on every character.
      markPersisted('proj-1');
      service.projectConfig.value.set({
        ...service.projectConfig.value(),
        id: 'proj-1',
      });

      for (const name of ['M', 'My', 'My ', 'My P', 'My Pr', 'My Proj']) {
        service.updateProjectConfig({name});
      }

      expect(saveRequestCount()).toBe(0);

      // The commit (blur) is the single persist for the whole edit.
      service.saveNow();
      expect(saveRequestCount()).toBe(1);
      expect(httpClientMock.patch.mock.calls[0][1]).toEqual(
        expect.objectContaining({name: 'My Proj'}),
      );
    });
  });

  describe('flush on leaving a project', () => {
    it('resetProjectConfig should flush the dirty project before clearing', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.resetProjectConfig();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch.mock.calls[0][0]).toBe(
        '/api/projects/proj-1',
      );
      // ...and still resets as before.
      expect(service.projectConfig.value().id).toBe('');
      expect(service.shouldSave).toBe(false);
    });

    it('loadProjectConfig should flush the dirty project before switching', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.loadProjectConfig('proj-2');

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch.mock.calls[0][0]).toBe(
        '/api/projects/proj-1',
      );
      expect(service.shouldSave).toBe(false);
    });

    it('loadProjectConfig should not flush when the id is unchanged', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.loadProjectConfig('proj-1');

      expect(saveRequestCount()).toBe(0);
    });

    it('reset with a clean project should not save', () => {
      service.resetProjectConfig();
      expect(saveRequestCount()).toBe(0);
    });
  });

  describe('debounced autosave interplay', () => {
    it('should save a dirty config via the debounce when not flushed', () => {
      vi.useFakeTimers();
      markPersisted('proj-1');
      const initial = service.projectConfig.value();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      const dirty = service.projectConfig.value();

      toObservableSubject.current!.next(initial); // consumed by skip(1)
      toObservableSubject.current!.next(dirty);
      expect(saveRequestCount()).toBe(0); // debounce pending

      vi.advanceTimersByTime(5000);

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
    });

    it('should not duplicate the save when the debounce fires after a flush of the same config', () => {
      vi.useFakeTimers();
      markPersisted('proj-1');
      const initial = service.projectConfig.value();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      const dirty = service.projectConfig.value();

      toObservableSubject.current!.next(initial); // consumed by skip(1)
      toObservableSubject.current!.next(dirty);

      service.flushPendingSave();
      expect(saveRequestCount()).toBe(1);

      vi.advanceTimersByTime(5000);

      // The debounced emission carried the exact object already flushed.
      expect(saveRequestCount()).toBe(1);
    });

    it('should still save changes made after a flush', () => {
      vi.useFakeTimers();
      markPersisted('proj-1');
      const initial = service.projectConfig.value();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.flushPendingSave();
      expect(saveRequestCount()).toBe(1);

      service.updateProjectConfig({name: 'dirtier'});
      const dirtier = service.projectConfig.value();
      toObservableSubject.current!.next(initial); // consumed by skip(1)
      toObservableSubject.current!.next(dirtier);
      vi.advanceTimersByTime(5000);

      expect(saveRequestCount()).toBe(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'dirtier'}),
      );
    });

    it('repeated flushes of the same config should save once', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.flushPendingSave();
      service.flushPendingSave();

      expect(saveRequestCount()).toBe(1);
    });
  });

  describe('global config fetch failure (degrades, does not crash)', () => {
    it('loads the config when /api/config succeeds', async () => {
      httpClientMock.get.mockReturnValue(
        of({gcsBucket: 'b', aspectRatio: '16:9'}),
      );

      const result = await (service as any).loadGlobalConfig();

      expect(result).toEqual({gcsBucket: 'b', aspectRatio: '16:9'});
      expect(httpClientMock.get).toHaveBeenCalledWith('/api/config');
    });

    it('resolves to undefined (does not reject) when /api/config fails', async () => {
      // A failed fetch must NOT put the resource into an error state: value()
      // throws there, and the optional-chaining config guards would then crash
      // the home/setup pages. The loader swallows the error and degrades to
      // undefined so value() stays callable. Covers a 500 and a 401.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      for (const status of [500, 401]) {
        httpClientMock.get.mockReturnValue(throwError(() => ({status})));
        await expect(
          (service as any).loadGlobalConfig(),
        ).resolves.toBeUndefined();
      }

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('builds a default project config without throwing when global config is unavailable', () => {
      // Simulate the resource resolved to undefined (a failed /api/config).
      // DEFAULT_PROJECT_CONFIG reads globalConfig.value()?.x with optional
      // chaining, so it must still produce a usable object instead of crashing
      // the setup flow. (E1)
      (service as any).globalConfig.set(undefined);

      const defaultConfig = (service as any).DEFAULT_PROJECT_CONFIG();

      expect(defaultConfig).toBeDefined();
      expect(defaultConfig.storyboard).toEqual([]);
      expect(defaultConfig.aspectRatio).toBeUndefined();
    });
  });
});
