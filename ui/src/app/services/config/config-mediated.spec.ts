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
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {DOCUMENT} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService} from './config';

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

    TestBed.configureTestingModule({
      providers: [
        ConfigService,
        {provide: HttpClient, useValue: httpClientMock},
        {provide: MatSnackBar, useValue: matSnackBarMock},
        {provide: Router, useValue: routerMock},
        {provide: DOCUMENT, useValue: documentMock},
      ],
    });
    service = TestBed.inject(ConfigService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The autosave subscription reads projectConfig.value through the REAL
  // toObservable, so a signal write reaches the RxJS pipeline only after Angular
  // effects flush. TestBed.tick() performs that flush, emitting the current
  // value; the 5s debounce is then advanced with fake timers.
  //
  // Call settleAutosave() (under real timers) BEFORE vi.useFakeTimers(). It does
  // two things up front: lets the projectConfig resource loader resolve once
  // (projectId stays null in these tests, so it never re-runs and cannot clobber
  // a later value.set/update), and consumes the toObservable skip(1) priming
  // emission — so the next emitProjectConfig() is the emission that actually
  // flows through skip(1) -> debounceTime.
  async function settleAutosave() {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  function emitProjectConfig() {
    TestBed.tick();
  }

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

    it('retries on a later flush when the save FAILED (does not mark unsaved work as saved)', () => {
      markPersisted('proj-1');
      // First PATCH fails; the Retry snackbar is offered but the user does not
      // click it. A later flush of the SAME unsaved object must re-attempt the
      // save instead of skipping it as already-saved (the regression: advancing
      // lastSavedConfig before the server confirmed).
      httpClientMock.patch
        .mockReturnValueOnce(throwError(() => new Error('save failed')))
        .mockReturnValue(of({}));

      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});
      service.flushPendingSave();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      // No edit in between: the same object is still current and still unsaved.
      service.flushPendingSave();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
    });

    it('does not re-save the same object after a SUCCESSFUL save', () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.flushPendingSave();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      // Same object, already confirmed saved: a second flush is a no-op.
      service.flushPendingSave();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
    });

    it('recovers from a create-only 409 by switching to PATCH', () => {
      // The client thinks the project is new (not persisted) so it POSTs, but
      // the server already has it and POST is create-only, returning 409. The
      // client marks it persisted and retries once via PATCH (updating the
      // existing project) instead of looping on POST.
      httpClientMock.post.mockReturnValue(
        throwError(() => new HttpErrorResponse({status: 409})),
      );
      httpClientMock.patch.mockReturnValue(of({}));

      service.updateProjectConfig({id: 'dupe-proj', name: 'dirty'});
      service.flushPendingSave();

      expect(httpClientMock.post).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/dupe-proj',
        expect.objectContaining({id: 'dupe-proj'}),
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

    it('should dedupe the trailing debounced emission (no double save)', async () => {
      markPersisted('proj-1');
      await settleAutosave();
      vi.useFakeTimers();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.saveNow();
      expect(saveRequestCount()).toBe(1);

      // The 5s autosave fires later carrying the exact object already saved.
      emitProjectConfig();
      vi.advanceTimersByTime(5000);

      expect(saveRequestCount()).toBe(1);
    });

    it('should dedupe the trailing debounce after a brand-new create', async () => {
      await settleAutosave();
      vi.useFakeTimers();
      service.setNewProject('new-proj');

      service.saveNow();
      expect(saveRequestCount()).toBe(1);
      expect(httpClientMock.post).toHaveBeenCalledTimes(1);

      // No edit since create: the same object re-emits via the debounce.
      emitProjectConfig();
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

    it('should still save a title committed after an immediate save', async () => {
      // Mirrors the title-on-blur flow: a save, then more keystrokes, then a
      // later commit must persist the newer name.
      markPersisted('proj-1');
      await settleAutosave();
      vi.useFakeTimers();
      service.updateProjectConfig({id: 'proj-1', name: 'My Proj'});

      service.saveNow();
      expect(saveRequestCount()).toBe(1);

      service.updateProjectConfig({name: 'My Project'});
      service.saveNow();
      expect(saveRequestCount()).toBe(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'My Project'}),
      );

      // And the trailing debounce on the latest object is still deduped.
      emitProjectConfig();
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

  describe('ordered autosave persistence', () => {
    it('preserves newer local data when returning during an in-flight save', async () => {
      const firstSave = new Subject<unknown>();
      const secondSave = new Subject<unknown>();
      const staleReload = new Subject<any>();
      httpClientMock.patch
        .mockReturnValueOnce(firstSave)
        .mockReturnValueOnce(secondSave);
      httpClientMock.get.mockImplementation((url: string) => {
        if (url === '/api/config') {
          return of({});
        }
        if (url === '/api/projects/proj-2') {
          return of({
            ...service.projectConfig.value(),
            id: 'proj-2',
            name: 'project B',
          });
        }
        return staleReload;
      });
      markPersisted('proj-1');
      service.updateProjectConfig({
        id: 'proj-1',
        name: 'new A',
        inputConfig: {
          ...service.projectConfig.value().inputConfig,
          composition: 'new local composition',
        },
      });
      service.saveNow();

      service.loadProjectConfig('proj-2');
      await vi.waitFor(() => {
        expect(service.projectConfig.value().id).toBe('proj-2');
      });
      service.loadProjectConfig('proj-1');
      await vi.waitFor(() => {
        expect(httpClientMock.get).toHaveBeenCalledWith('/api/projects/proj-1');
      });
      staleReload.next({
        ...service.projectConfig.value(),
        id: 'proj-1',
        name: 'old A',
        inputConfig: {
          ...service.projectConfig.value().inputConfig,
          composition: 'old server composition',
        },
      });
      staleReload.complete();
      await vi.waitFor(() => {
        expect(service.projectConfig.value().id).toBe('proj-1');
      });

      firstSave.next({});
      firstSave.complete();
      service.updateProjectConfig({name: 'edited after reload'});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          name: 'edited after reload',
          inputConfig: expect.objectContaining({
            composition: 'new local composition',
          }),
        }),
      );
      secondSave.next({});
    });

    it('preserves a failed new project when its reload returns 404', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpClientMock.post.mockReturnValue(
        throwError(() => new Error('save failed')),
      );
      httpClientMock.get.mockImplementation((url: string) =>
        url === '/api/config'
          ? of({})
          : throwError(() => new HttpErrorResponse({status: 404})),
      );
      service.setNewProject('new-proj');
      service.updateProjectConfig({name: 'unsaved local project'});
      service.saveNow();
      service.setNewProject('other-proj');

      service.loadProjectConfig('new-proj');

      await vi.waitFor(() => {
        expect(service.projectConfig.value()).toEqual(
          expect.objectContaining({
            id: 'new-proj',
            name: 'unsaved local project',
          }),
        );
      });
      errorSpy.mockRestore();
    });

    it('waits for the current save before sending a newer snapshot', () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      const secondResponse = new Subject<unknown>();
      httpClientMock.patch
        .mockReturnValueOnce(firstResponse)
        .mockReturnValueOnce(secondResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch.mock.calls[0][1]).toEqual(
        expect.objectContaining({name: 'A'}),
      );

      firstResponse.next({});

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'B'}),
      );
      secondResponse.next({});
    });

    it('coalesces intermediate snapshots while a save is in flight', () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      const finalResponse = new Subject<unknown>();
      httpClientMock.patch
        .mockReturnValueOnce(firstResponse)
        .mockReturnValueOnce(finalResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();
      service.updateProjectConfig({name: 'C'});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      firstResponse.next({});

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(
        httpClientMock.patch.mock.calls.map(([, body]: any[]) => body.name),
      ).toEqual(['A', 'C']);
      finalResponse.next({});
    });

    it('captures queued nested data without defeating source dedupe', () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      const queuedResponse = new Subject<unknown>();
      httpClientMock.patch
        .mockReturnValueOnce(firstResponse)
        .mockReturnValueOnce(queuedResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({
        name: 'B',
        inputConfig: {
          ...service.projectConfig.value().inputConfig,
          products: [{id: 1, name: 'queued product', images: []}],
        },
      });
      service.saveNow();

      const queuedSource = service.projectConfig.value();
      queuedSource.inputConfig.products[0].name = 'mutated after queueing';
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      firstResponse.next({});

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          inputConfig: expect.objectContaining({
            products: [expect.objectContaining({name: 'queued product'})],
          }),
        }),
      );
      queuedResponse.next({});
    });

    it('keeps ordering and confirmation state independent per project', () => {
      markPersisted('proj-1');
      const firstProjectResponse = new Subject<unknown>();
      const queuedFirstProjectResponse = new Subject<unknown>();
      const secondProjectResponse = new Subject<unknown>();
      httpClientMock.patch.mockImplementation(
        (url: string, body: {name: string}) => {
          if (url.endsWith('/proj-2')) {
            return secondProjectResponse;
          }
          return body.name === 'project A1'
            ? firstProjectResponse
            : queuedFirstProjectResponse;
        },
      );

      service.updateProjectConfig({id: 'proj-1', name: 'project A1'});
      service.saveNow();
      service.updateProjectConfig({name: 'project A2'});
      service.saveNow();

      service.setNewProject('proj-2');
      markPersisted('proj-2');
      service.updateProjectConfig({name: 'project B'});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);

      secondProjectResponse.next({});
      firstProjectResponse.next({});

      expect(httpClientMock.patch).toHaveBeenCalledTimes(3);
      expect(httpClientMock.patch.mock.calls[2][1]).toEqual(
        expect.objectContaining({name: 'project A2'}),
      );
      queuedFirstProjectResponse.next({});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(3);
    });

    it('recovers a queued create conflict with one PATCH of the latest snapshot', () => {
      const createResponse = new Subject<unknown>();
      const updateResponse = new Subject<unknown>();
      httpClientMock.post.mockReturnValue(createResponse);
      httpClientMock.patch.mockReturnValue(updateResponse);

      service.setNewProject('dupe-proj');
      service.updateProjectConfig({name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();

      expect(httpClientMock.post).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).not.toHaveBeenCalled();

      createResponse.error(new HttpErrorResponse({status: 409}));

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch.mock.calls[0][1]).toEqual(
        expect.objectContaining({id: 'dupe-proj', name: 'B'}),
      );
      updateResponse.next({});
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
    });

    it('continues with the latest queued snapshot after a failed save', () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      const queuedResponse = new Subject<unknown>();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpClientMock.patch
        .mockReturnValueOnce(firstResponse)
        .mockReturnValueOnce(queuedResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      firstResponse.error(new Error('save failed'));

      expect(matSnackBarMock.open).toHaveBeenCalledWith(
        'Unsaved changes — failed to save the project.',
        'Retry',
        {panelClass: ['error-snackbar']},
      );
      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'B'}),
      );
      queuedResponse.next({});
      errorSpy.mockRestore();
    });

    it('recovers an off-project create conflict with the captured project', () => {
      const createResponse = new Subject<unknown>();
      const updateResponse = new Subject<unknown>();
      httpClientMock.post.mockReturnValue(createResponse);
      httpClientMock.patch.mockReturnValue(updateResponse);

      service.setNewProject('dupe-proj');
      service.updateProjectConfig({name: 'project A'});
      service.saveNow();
      service.setNewProject('other-proj');

      createResponse.error(new HttpErrorResponse({status: 409}));

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(httpClientMock.patch).toHaveBeenCalledWith(
        '/api/projects/dupe-proj',
        expect.objectContaining({id: 'dupe-proj', name: 'project A'}),
      );
      updateResponse.next({});
    });

    it('does not retry an older failure after a newer snapshot succeeds off-project', () => {
      markPersisted('proj-1');
      const failedResponse = new Subject<unknown>();
      const queuedResponse = new Subject<unknown>();
      const retryAction = new Subject<void>();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpClientMock.patch
        .mockReturnValueOnce(failedResponse)
        .mockReturnValueOnce(queuedResponse)
        .mockReturnValue(of({}));
      matSnackBarMock.open.mockReturnValue({onAction: () => retryAction});

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();
      failedResponse.error(new Error('save failed'));

      service.setNewProject('proj-2');
      queuedResponse.next({});
      retryAction.next();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      errorSpy.mockRestore();
    });

    it('retries the latest unsaved snapshot from the snackbar action', () => {
      markPersisted('proj-1');
      const failedResponse = new Subject<unknown>();
      const retryResponse = new Subject<unknown>();
      const retryAction = new Subject<void>();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpClientMock.patch
        .mockReturnValueOnce(failedResponse)
        .mockReturnValueOnce(retryResponse);
      matSnackBarMock.open.mockReturnValue({onAction: () => retryAction});

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      failedResponse.error(new Error('save failed'));

      service.updateProjectConfig({name: 'B'});
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      retryAction.next();

      expect(httpClientMock.patch).toHaveBeenCalledTimes(2);
      expect(httpClientMock.patch.mock.calls[1][1]).toEqual(
        expect.objectContaining({name: 'B'}),
      );
      retryResponse.next({});
      errorSpy.mockRestore();
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

  describe('deleteProject', () => {
    it('forgets per-project save state after deletion', async () => {
      markPersisted('proj-1');
      service.updateProjectConfig({id: 'proj-1', name: 'saved'});
      service.saveNow();

      await service.deleteProject('proj-1');

      expect((service as any).projectSaveStates.has('proj-1')).toBe(false);
    });
  });

  describe('stale autosave callbacks after deletion', () => {
    it('does not start a queued save after deletion begins', async () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      const deleteResponse = new Subject<unknown>();
      httpClientMock.patch.mockReturnValue(firstResponse);
      httpClientMock.delete.mockReturnValue(deleteResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      service.updateProjectConfig({name: 'B'});
      service.saveNow();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      // Deletion STARTS but its response has not arrived yet.
      const deletion = service.deleteProject('proj-1');

      // The in-flight save now succeeds. Fencing only after DELETE resolves
      // would let this dispatch the queued 'B' save mid-deletion.
      firstResponse.next({});

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      deleteResponse.next({});
      await deletion;
      expect((service as any).projectSaveStates.has('proj-1')).toBe(false);
    });

    it('a late SUCCESS after deletion starts no queued save', async () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      httpClientMock.patch.mockReturnValue(firstResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      // Queues a pending save against the SAME (soon-to-be-orphaned) state
      // object, since a save is already in flight.
      service.updateProjectConfig({name: 'B'});
      service.saveNow();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      await service.deleteProject('proj-1');

      // The in-flight request's response arrives after the project is gone.
      firstResponse.next({});

      // Unguarded, the success handler would start the queued pending save,
      // resurrecting the project with a second PATCH.
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect((service as any).projectSaveStates.has('proj-1')).toBe(false);
    });

    it('a late FAILURE after deletion shows no snackbar and retries nothing', async () => {
      markPersisted('proj-1');
      const firstResponse = new Subject<unknown>();
      httpClientMock.patch.mockReturnValue(firstResponse);

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();

      await service.deleteProject('proj-1');

      firstResponse.error(new Error('late failure'));

      expect(matSnackBarMock.open).not.toHaveBeenCalled();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect((service as any).projectSaveStates.has('proj-1')).toBe(false);
    });

    it('Retry from a snackbar shown before deletion does not recreate the project', async () => {
      markPersisted('proj-1');
      const failedResponse = new Subject<unknown>();
      const retryAction = new Subject<void>();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      httpClientMock.patch.mockReturnValueOnce(failedResponse);
      matSnackBarMock.open.mockReturnValue({onAction: () => retryAction});

      service.updateProjectConfig({id: 'proj-1', name: 'A'});
      service.saveNow();
      failedResponse.error(new Error('save failed'));
      expect(matSnackBarMock.open).toHaveBeenCalledTimes(1);

      await service.deleteProject('proj-1');
      retryAction.next();

      // Unguarded, Retry calls persistNow() for the deleted id, which (since
      // persistedProjectIds was also cleared by delete) issues a fresh POST.
      expect(httpClientMock.post).not.toHaveBeenCalled();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect((service as any).projectSaveStates.has('proj-1')).toBe(false);
      errorSpy.mockRestore();
    });

    it('a stale callback cannot corrupt a same-id project recreated after delete', async () => {
      markPersisted('proj-1');
      const oldResponse = new Subject<unknown>();
      httpClientMock.patch.mockReturnValueOnce(oldResponse);

      // The old project: a save starts (capturing the OLD save-state object),
      // then a second edit queues a pending save against that same object.
      service.updateProjectConfig({id: 'proj-1', name: 'old-A'});
      service.saveNow();
      service.updateProjectConfig({name: 'old-B'});
      service.saveNow();
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);

      await service.deleteProject('proj-1');

      // A new project reuses the same id, getting its OWN save-state object.
      service.setNewProject('proj-1');
      service.updateProjectConfig({name: 'new'});
      service.saveNow();
      expect(httpClientMock.post).toHaveBeenCalledTimes(1);

      // The old in-flight request finally resolves. Unguarded, its success
      // handler would start the OLD queued 'old-B' pending save against the
      // NOW-persisted id, PATCHing the new project with stale deleted data.
      oldResponse.next({});

      // Still just the one PATCH for 'old-A' from before deletion: nothing
      // new was triggered by the stale response.
      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
      expect(
        (service as any).projectSaveStates.get('proj-1').lastSavedSource.name,
      ).toBe('new');
    });
  });

  describe('debounced autosave interplay', () => {
    it('should save a dirty config via the debounce when not flushed', async () => {
      markPersisted('proj-1');
      await settleAutosave();
      vi.useFakeTimers();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      emitProjectConfig();
      expect(saveRequestCount()).toBe(0); // debounce pending

      vi.advanceTimersByTime(5000);

      expect(httpClientMock.patch).toHaveBeenCalledTimes(1);
    });

    it('should not duplicate the save when the debounce fires after a flush of the same config', async () => {
      markPersisted('proj-1');
      await settleAutosave();
      vi.useFakeTimers();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      emitProjectConfig();

      service.flushPendingSave();
      expect(saveRequestCount()).toBe(1);

      vi.advanceTimersByTime(5000);

      // The debounced emission carried the exact object already flushed.
      expect(saveRequestCount()).toBe(1);
    });

    it('should still save changes made after a flush', async () => {
      markPersisted('proj-1');
      await settleAutosave();
      vi.useFakeTimers();
      service.updateProjectConfig({id: 'proj-1', name: 'dirty'});

      service.flushPendingSave();
      expect(saveRequestCount()).toBe(1);

      service.updateProjectConfig({name: 'dirtier'});
      emitProjectConfig();
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
