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

import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../client-media/client-media';
import {ConfigService} from '../config/config';
import {MediaService} from '../media/media';
import {RemixEngineService} from './remix-engine';

describe('RemixEngineService polling scheduler', () => {
  let service: RemixEngineService;
  let httpClientMock: {get: ReturnType<typeof vi.fn>};
  let projectConfig: ReturnType<typeof signal>;

  beforeEach(() => {
    projectConfig = signal({id: 'project-1', storyboard: []});
    const globalConfig = signal({gcsBucket: 'mock-bucket'});
    httpClientMock = {get: vi.fn()};
    TestBed.configureTestingModule({
      providers: [
        RemixEngineService,
        {
          provide: ConfigService,
          useValue: {
            globalConfig: {value: globalConfig},
            projectConfig: {value: projectConfig},
            isGeneratedScene: vi.fn(),
            isProvidedVideoScene: vi.fn(),
            updateProjectConfig: vi.fn(),
            addRenderRun: vi.fn(),
            setPendingRender: vi.fn(),
            flushPendingSave: vi.fn(),
            videoEditModels: vi.fn().mockReturnValue([]),
            canEditCandidates: vi.fn().mockReturnValue(false),
            audioLocked: vi.fn().mockReturnValue(false),
            resolveVideoLocation: vi.fn().mockReturnValue('mock-location'),
          },
        },
        {provide: HttpClient, useValue: httpClientMock},
        {provide: ClientMediaService, useValue: {}},
        {provide: MediaService, useValue: {}},
        {provide: MatSnackBar, useValue: {open: vi.fn()}},
      ],
    });
    service = TestBed.inject(RemixEngineService);
    TestBed.tick();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('limits status starts to four per second after the initial three-second check', async () => {
    vi.useFakeTimers();
    const startedAt: number[] = [];
    httpClientMock.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/getStatus')) startedAt.push(Date.now());
      return of({sink: {output: {}}});
    });

    const promises = Array.from({length: 5}, (_, i) =>
      service.pollWorkflow(`execution-${i}`, 'project-1'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2999);
    expect(startedAt).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toHaveLength(4);
    expect(new Set(startedAt.slice(0, 3)).size).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toHaveLength(5);
    await Promise.all(promises);
  });

  it('keeps a small active set on the three-second cadence', async () => {
    vi.useFakeTimers();
    const startedAt: number[] = [];
    let callCount = 0;
    httpClientMock.get.mockImplementation(() => {
      startedAt.push(Date.now());
      callCount++;
      return of(callCount < 3 ? {sink: {}} : {sink: {output: {done: true}}});
    });

    const poll = service.pollWorkflow('small-execution', 'project-1');
    await vi.advanceTimersByTimeAsync(2999);
    expect(startedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(startedAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(startedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await poll;
    expect(startedAt).toHaveLength(3);
    expect(startedAt[1] - startedAt[0]).toBe(3000);
    expect(startedAt[2] - startedAt[1]).toBe(3000);
  });

  it('prioritizes the selected scene without starving 122 background executions', async () => {
    vi.useFakeTimers();
    const started: Array<{executionId: string; at: number}> = [];
    httpClientMock.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/getStatus')) {
        const executionId = new URL(url, 'http://test').searchParams.get(
          'executionId',
        )!;
        started.push({executionId, at: Date.now()});
      }
      return of({sink: {output: {}}});
    });
    service.setForegroundScene('project-1', 'selected-scene');
    const background = Array.from({length: 122}, (_, i) =>
      service.pollWorkflow(`background-${i}`, 'project-1', `scene-${i}`),
    );
    const selected = service.pollWorkflow(
      'selected-execution',
      'project-1',
      'selected-scene',
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(started.slice(0, 4).map(item => item.executionId)).toContain(
      'selected-execution',
    );
    await vi.advanceTimersByTimeAsync(30000);
    await Promise.all([...background, selected]);

    expect(started).toHaveLength(123);
    for (const item of started) {
      expect(
        started.filter(
          other => other.at > item.at - 1000 && other.at <= item.at,
        ).length,
      ).toBeLessThanOrEqual(4);
    }
    expect(started[started.length - 1].at - started[0].at).toBe(30000);
  });

  it('drains a 122-job backlog before restoring three-second cadence', async () => {
    vi.useFakeTimers();
    const started: Array<{executionId: string; at: number}> = [];
    const heldExecutions = new Set(['workflow-119', 'workflow-120', 'workflow-121']);
    let allowTerminalResponses = false;
    const origin = Date.now();
    httpClientMock.get.mockImplementation((url: string) => {
      const executionId = new URL(url, 'http://test').searchParams.get(
        'executionId',
      )!;
      started.push({executionId, at: Date.now()});
      const terminal = allowTerminalResponses && !heldExecutions.has(executionId);
      return of(terminal ? {sink: {output: {done: true}}} : {sink: {}});
    });

    const polls = Array.from({length: 122}, (_, index) =>
      service.pollWorkflow(`workflow-${index}`, 'project-1'),
    );
    await vi.advanceTimersByTimeAsync(180_000);
    expect(started).toHaveLength(712);
    expect(started[0].at - origin).toBe(3000);
    expect(started[started.length - 1].at - origin).toBe(180_000);

    let settled = 0;
    for (const poll of polls) {
      void poll.then(() => settled++);
    }
    allowTerminalResponses = true;
    for (let seconds = 0; seconds < 180 && settled < 119; seconds++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(settled).toBe(119);

    const drainAt = Date.now();
    await vi.advanceTimersByTimeAsync(9000);
    for (const executionId of heldExecutions) {
      const times = started
        .filter(item => item.executionId === executionId && item.at >= drainAt)
        .map(item => item.at);
      expect(times.length).toBeGreaterThanOrEqual(3);
      expect(times[1] - times[0]).toBe(3000);
      expect(times[2] - times[1]).toBe(3000);
    }

    allowTerminalResponses = true;
    for (const executionId of heldExecutions) {
      // The held executions are made terminal on their next request so all
      // promises settle without extending the synthetic run.
      heldExecutions.delete(executionId);
    }
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(polls);
  });

  it('does not cancel and replace a slow status request', async () => {
    vi.useFakeTimers();
    const status = new Subject<{sink: {output: object}}>();
    httpClientMock.get.mockReturnValue(status.asObservable());
    const poll = service.pollWorkflow('slow-execution', 'project-1');

    await vi.advanceTimersByTimeAsync(3000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(1);

    status.next({sink: {output: {}}});
    status.complete();
    await poll;
  });

  it('honors a valid Retry-After without bypassing the scheduler', async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const retryAfter = new HttpErrorResponse({
      status: 503,
      headers: new HttpHeaders({'Retry-After': '10'}),
    });
    httpClientMock.get.mockImplementation(() => {
      statusCalls++;
      return statusCalls === 1
        ? throwError(() => retryAfter)
        : of({sink: {output: {}}});
    });
    const poll = service.pollWorkflow('retry-execution', 'project-1');

    await vi.advanceTimersByTimeAsync(3000);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await poll;
    expect(statusCalls).toBe(2);
  });

  it('cancels an error backoff when the project changes', async () => {
    vi.useFakeTimers();
    const failure = new HttpErrorResponse({status: 503});
    httpClientMock.get.mockReturnValue(throwError(() => failure));
    const poll = service.pollWorkflow('retrying-execution', 'project-1');

    await vi.advanceTimersByTimeAsync(3000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(1);
    projectConfig.set({id: 'project-2', storyboard: []});
    TestBed.tick();

    await expect(poll).rejects.toThrow('Project changed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(1);
  });

  it('cancels queued or active work when the project changes', async () => {
    vi.useFakeTimers();
    const status = new Subject<{sink: {output: object}}>();
    httpClientMock.get.mockReturnValue(status.asObservable());
    const poll = service.pollWorkflow('stale-execution', 'project-1');

    await vi.advanceTimersByTimeAsync(3000);
    projectConfig.set({id: 'project-2', storyboard: []});
    status.next({sink: {output: {}}});

    await expect(poll).rejects.toThrow('Project changed');
    expect(httpClientMock.get).toHaveBeenCalledTimes(1);
  });

  it('releases old active slots when the project changes', async () => {
    vi.useFakeTimers();
    const statusSubjects: Array<Subject<{sink: {output: object}}>> = [];
    httpClientMock.get.mockImplementation(() => {
      const status = new Subject<{sink: {output: object}}>();
      statusSubjects.push(status);
      return status.asObservable();
    });

    const oldPolls = Array.from({length: 5}, (_, i) =>
      service.pollWorkflow(`old-${i}`, 'project-1'),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(4);

    projectConfig.set({id: 'project-2', storyboard: []});
    TestBed.tick();
    await expect(Promise.all(oldPolls)).rejects.toThrow('Project changed');

    const newPoll = service.pollWorkflow('new', 'project-2');
    await vi.advanceTimersByTimeAsync(3000);
    expect(httpClientMock.get).toHaveBeenCalledTimes(5);
    statusSubjects[4].next({sink: {output: {}}});
    statusSubjects[4].complete();
    await newPoll;
  });
});
