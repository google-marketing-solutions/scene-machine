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
import {EnvironmentInjector} from '@angular/core';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {env} from '../../../env';
import {MediaService} from './media';

// Pin env so this spec does not depend on the rendered (gitignored)
// src/env.ts. signUrl/signUrls are mode-agnostic; the resolve() specs below
// mutate this plain object per mode and restore it in afterEach.
vi.mock('../../../env', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    env: {...actual.env, mediaMode: 'mediated'},
  };
});

const mockGet = vi.fn();

// Mock @angular/core to provide inject without an injection context.
vi.mock('@angular/core', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    inject: vi.fn((token: any) => mockGet(token)),
    runInInjectionContext: vi.fn((_injector: any, fn: () => any) => fn()),
  };
});

interface SignUrlResponse {
  urls: Record<string, string>;
  expiresAt: string;
}

describe('MediaService', () => {
  let service: MediaService;
  let httpClientMock: any;

  function signUrlResponse(
    paths: string[],
    ttlMs = 60 * 60 * 1000,
  ): SignUrlResponse {
    const urls: Record<string, string> = {};
    for (const path of paths) {
      urls[path] = `https://signed.example/${path}`;
    }
    return {urls, expiresAt: new Date(Date.now() + ttlMs).toISOString()};
  }

  beforeEach(() => {
    httpClientMock = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    };
    mockGet.mockImplementation((token: any) => {
      if (token === HttpClient) return httpClientMock;
      if (token === EnvironmentInjector) return {get: vi.fn()};
      return null;
    });
    service = new MediaService();
  });

  afterEach(() => {
    // The resolve() specs mutate the mocked (plain-object) env per mode.
    (env as {mediaMode: string}).mediaMode = 'mediated';
  });

  describe('signUrls', () => {
    it('issues a single GET with all uncached paths as repeated params', async () => {
      httpClientMock.get.mockReturnValue(
        of(signUrlResponse(['videos/a.mp4', 'videos/b c.mp4'])),
      );

      const result = await service.signUrls(['videos/a.mp4', 'videos/b c.mp4']);

      expect(httpClientMock.get).toHaveBeenCalledTimes(1);
      expect(httpClientMock.get).toHaveBeenCalledWith(
        `/api/signUrl?path=${encodeURIComponent('videos/a.mp4')}` +
          `&path=${encodeURIComponent('videos/b c.mp4')}`,
      );
      expect(result.get('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(result.get('videos/b c.mp4')).toBe(
        'https://signed.example/videos/b c.mp4',
      );
    });

    it('excludes cache-fresh paths from the request and serves them from the cache', async () => {
      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/a.mp4'])),
      );
      await service.signUrl('videos/a.mp4');
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);

      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/b.mp4'])),
      );
      const result = await service.signUrls(['videos/a.mp4', 'videos/b.mp4']);

      expect(httpClientMock.get).toHaveBeenCalledTimes(2);
      expect(httpClientMock.get).toHaveBeenLastCalledWith(
        `/api/signUrl?path=${encodeURIComponent('videos/b.mp4')}`,
      );
      expect(result.get('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(result.get('videos/b.mp4')).toBe(
        'https://signed.example/videos/b.mp4',
      );
    });

    it('issues no request when every path is cache-fresh', async () => {
      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/a.mp4', 'videos/b.mp4'])),
      );
      await service.signUrls(['videos/a.mp4', 'videos/b.mp4']);
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);

      const result = await service.signUrls(['videos/a.mp4', 'videos/b.mp4']);

      expect(httpClientMock.get).toHaveBeenCalledTimes(1);
      expect(result.get('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(result.get('videos/b.mp4')).toBe(
        'https://signed.example/videos/b.mp4',
      );
    });

    it('populates the cache with the response expiresAt', async () => {
      httpClientMock.get.mockReturnValue(
        of(signUrlResponse(['videos/a.mp4'], /* ttlMs= */ 60 * 60 * 1000)),
      );

      await service.signUrls(['videos/a.mp4']);

      // Fresh (1h TTL, well beyond the 5-minute margin): served from cache.
      expect(service.getCachedUrl('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      await expect(service.signUrl('videos/a.mp4')).resolves.toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);
    });

    it('does not cache entries already inside the expiry margin', async () => {
      // TTL below the 5-minute re-sign margin: cached but never served.
      httpClientMock.get.mockReturnValue(
        of(signUrlResponse(['videos/a.mp4'], /* ttlMs= */ 60 * 1000)),
      );

      await service.signUrls(['videos/a.mp4']);

      expect(service.getCachedUrl('videos/a.mp4')).toBeUndefined();
    });

    it('dedupes a concurrent signUrl() against the in-flight batch', async () => {
      const subject = new Subject<SignUrlResponse>();
      httpClientMock.get.mockReturnValue(subject);

      const batchPromise = service.signUrls(['videos/a.mp4', 'videos/b.mp4']);
      const singlePromise = service.signUrl('videos/a.mp4');
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);

      subject.next(signUrlResponse(['videos/a.mp4', 'videos/b.mp4']));
      subject.complete();

      const [batch, single] = await Promise.all([batchPromise, singlePromise]);
      expect(single).toBe('https://signed.example/videos/a.mp4');
      expect(batch.get('videos/b.mp4')).toBe(
        'https://signed.example/videos/b.mp4',
      );
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);
    });

    it('joins an in-flight signUrl() resolution instead of re-requesting it', async () => {
      const subject = new Subject<SignUrlResponse>();
      httpClientMock.get.mockReturnValueOnce(subject);

      const singlePromise = service.signUrl('videos/a.mp4');
      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/b.mp4'])),
      );
      const batchPromise = service.signUrls(['videos/a.mp4', 'videos/b.mp4']);

      // The batch request must only carry the path not already in flight.
      expect(httpClientMock.get).toHaveBeenCalledTimes(2);
      expect(httpClientMock.get).toHaveBeenLastCalledWith(
        `/api/signUrl?path=${encodeURIComponent('videos/b.mp4')}`,
      );

      subject.next(signUrlResponse(['videos/a.mp4']));
      subject.complete();

      const [single, batch] = await Promise.all([singlePromise, batchPromise]);
      expect(single).toBe('https://signed.example/videos/a.mp4');
      expect(batch.get('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(batch.get('videos/b.mp4')).toBe(
        'https://signed.example/videos/b.mp4',
      );
    });

    it('rejects on batch failure without poisoning the cache', async () => {
      httpClientMock.get.mockReturnValueOnce(
        throwError(() => new Error('boom')),
      );

      await expect(
        service.signUrls(['videos/a.mp4', 'videos/b.mp4']),
      ).rejects.toThrow('boom');
      expect(service.getCachedUrl('videos/a.mp4')).toBeUndefined();
      expect(service.getCachedUrl('videos/b.mp4')).toBeUndefined();

      // A later signUrl is not stuck on the dead batch: it issues a fresh
      // request and succeeds.
      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/a.mp4'])),
      );
      await expect(service.signUrl('videos/a.mp4')).resolves.toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(httpClientMock.get).toHaveBeenCalledTimes(2);
    });
  });

  // The resolve() contract the composition held-src effect and the mediaSrc
  // pipe delegate to on a cache miss: sign the path via /api/signUrl, or fall
  // back to the stored URL for path-less legacy refs.
  describe('resolve', () => {
    it('mediated: signs the path via /api/signUrl', async () => {
      (env as {mediaMode: string}).mediaMode = 'mediated';
      httpClientMock.get.mockReturnValue(of(signUrlResponse(['videos/a.mp4'])));

      const url = await service.resolve({
        path: 'videos/a.mp4',
        url: 'http://stored/a',
      });

      expect(url).toBe('https://signed.example/videos/a.mp4');
      expect(httpClientMock.get).toHaveBeenCalledWith(
        `/api/signUrl?path=${encodeURIComponent('videos/a.mp4')}`,
      );
    });

    it('mediated: falls back to the stored URL for path-less legacy refs without any fetch', async () => {
      (env as {mediaMode: string}).mediaMode = 'mediated';

      const url = await service.resolve({url: 'http://stored/legacy'});

      expect(url).toBe('http://stored/legacy');
      expect(httpClientMock.get).not.toHaveBeenCalled();
    });

    it('resolves empty refs to the empty string without any fetch', async () => {
      await expect(service.resolve(null)).resolves.toBe('');
      await expect(service.resolve(undefined)).resolves.toBe('');
      await expect(service.resolve({})).resolves.toBe('');
      expect(httpClientMock.get).not.toHaveBeenCalled();
    });
  });
});
