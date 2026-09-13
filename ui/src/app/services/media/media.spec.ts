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
import {HttpClient, provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MediaService} from './media';

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
    TestBed.configureTestingModule({
      providers: [
        MediaService,
        {provide: HttpClient, useValue: httpClientMock},
      ],
    });
    service = TestBed.inject(MediaService);
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

    it('omits a path the server leaves out without rejecting the whole batch (M1)', async () => {
      // The server returns a URL for a.mp4 but omits b.mp4 from the response.
      httpClientMock.get.mockReturnValueOnce(
        of(signUrlResponse(['videos/a.mp4'])),
      );

      const result = await service.signUrls(['videos/a.mp4', 'videos/b.mp4']);

      // The signed path is returned and the omitted one is simply absent — a
      // single missing path must NOT reject the batch or drop the path that
      // did sign.
      expect(result.get('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );
      expect(result.has('videos/b.mp4')).toBe(false);
    });
  });

  describe('signed-URL expiry caching', () => {
    it('caches against a finite fallback TTL when the server expiresAt is malformed, instead of re-signing on every read (M2)', async () => {
      httpClientMock.get.mockReturnValueOnce(
        of({
          urls: {'videos/a.mp4': 'https://signed.example/videos/a.mp4'},
          expiresAt: 'not-a-date',
        }),
      );

      const first = await service.signUrl('videos/a.mp4');
      expect(first).toBe('https://signed.example/videos/a.mp4');

      // A NaN expiry must NOT make the entry permanently stale (which would
      // re-sign on every change-detection read — an HTTP storm). It is cached
      // against a finite fallback TTL and served synchronously from the cache.
      expect(service.getCachedUrl('videos/a.mp4')).toBe(
        'https://signed.example/videos/a.mp4',
      );

      // A second signUrl is served from the cache: no second HTTP request.
      const second = await service.signUrl('videos/a.mp4');
      expect(second).toBe('https://signed.example/videos/a.mp4');
      expect(httpClientMock.get).toHaveBeenCalledTimes(1);
    });
  });

  // The resolve() contract the composition held-src effect and the mediaSrc
  // pipe delegate to on a cache miss: sign the path via /api/signUrl, or fall
  // back to the stored URL for path-less legacy refs.
  describe('resolve', () => {
    it('mediated: signs the path via /api/signUrl', async () => {
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

describe('MediaService signUrls request-target bounds', () => {
  let service: MediaService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MediaService,
      ],
    });
    service = TestBed.inject(MediaService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('splits long escaped paths before the relative request URL exceeds 3500 chars', async () => {
    const paths = Array.from(
      {length: 4},
      (_, index) =>
        `remix-input/project-${index}/candidate/${'take '.repeat(120)}clip-${index}.mp4`,
    );
    const resultPromise = service.signUrls(paths);
    const requests = http.match(request =>
      request.urlWithParams.startsWith('/api/signUrl?'),
    );

    expect(requests.length).toBe(2);
    for (const request of requests) {
      expect(request.request.urlWithParams.length).toBeLessThanOrEqual(3500);
      const requestPaths = new URL(
        request.request.urlWithParams,
        'https://test.invalid',
      ).searchParams.getAll('path');
      request.flush({
        urls: Object.fromEntries(
          requestPaths.map((path, index) => [
            path,
            `https://signed.test/${index}`,
          ]),
        ),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }

    const result = await resultPromise;
    expect(result.size).toBe(paths.length);
  });

  it('limits each multi-path request to 100 paths', async () => {
    const paths = Array.from(
      {length: 101},
      (_, index) => `videos/${index}.mp4`,
    );
    const resultPromise = service.signUrls(paths);
    const requests = http.match(request =>
      request.urlWithParams.startsWith('/api/signUrl?'),
    );

    expect(requests.length).toBe(2);
    for (const request of requests) {
      const requestPaths = new URL(
        request.request.urlWithParams,
        'https://test.invalid',
      ).searchParams.getAll('path');
      expect(requestPaths.length).toBeLessThanOrEqual(100);
      request.flush({
        urls: Object.fromEntries(
          requestPaths.map(path => [path, `https://signed.test/${path}`]),
        ),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }

    const result = await resultPromise;
    expect(result.size).toBe(paths.length);
  });

  it('keeps one oversized path as a single request', async () => {
    const path = `remix-input/project/candidate/${'take '.repeat(600)}clip.mp4`;
    const resultPromise = service.signUrls([path]);
    const request = http.expectOne(
      '/api/signUrl?' + `path=${encodeURIComponent(path)}`,
    );

    expect(request.request.urlWithParams.length).toBeGreaterThan(3500);
    request.flush({
      urls: {[path]: 'https://signed.test/oversized'},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await expect(resultPromise).resolves.toEqual(
      new Map([[path, 'https://signed.test/oversized']]),
    );
  });

  it('round-trips Unicode object paths while enforcing the encoded URL bound', async () => {
    const paths = Array.from(
      {length: 3},
      (_, index) =>
        `remix-input/projekt-${index}/🎬/${'über café '.repeat(80)}clip-${index}.mp4`,
    );
    const resultPromise = service.signUrls(paths);
    const requests = http.match(request =>
      request.urlWithParams.startsWith('/api/signUrl?'),
    );

    expect(requests.length).toBe(3);
    for (const path of paths) {
      expect(new TextEncoder().encode(path).length).toBeLessThanOrEqual(1024);
    }
    const requestedPaths: string[] = [];
    for (const request of requests) {
      expect(request.request.urlWithParams.length).toBeLessThanOrEqual(3500);
      const decodedPaths = new URL(
        request.request.urlWithParams,
        'https://test.invalid',
      ).searchParams.getAll('path');
      requestedPaths.push(...decodedPaths);
      request.flush({
        urls: Object.fromEntries(
          decodedPaths.map(path => [path, `https://signed.test/${path}`]),
        ),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }

    expect(requestedPaths).toEqual(paths);
    const result = await resultPromise;
    expect(result.size).toBe(paths.length);
  });

  it('joins signUrl to a later chunk and preserves omission as a per-path rejection', async () => {
    const paths = Array.from(
      {length: 101},
      (_, index) => `videos/${index}.mp4`,
    );
    const batchPromise = service.signUrls(paths);
    const requests = http.match(request =>
      request.urlWithParams.startsWith('/api/signUrl?'),
    );
    expect(requests.length).toBe(2);
    const laterPath = paths[100];
    const joinedPromise = service.signUrl(laterPath);
    const joinedRejection = expect(joinedPromise).rejects.toThrow(
      `No signed URL returned for ${laterPath}`,
    );

    const firstPaths = new URL(
      requests[0].request.urlWithParams,
      'https://test.invalid',
    ).searchParams.getAll('path');
    requests[0].flush({
      urls: Object.fromEntries(
        firstPaths.map(path => [path, `https://signed.test/${path}`]),
      ),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const laterRequestPaths = new URL(
      requests[1].request.urlWithParams,
      'https://test.invalid',
    ).searchParams.getAll('path');
    requests[1].flush({
      urls: {},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    const batchResult = await batchPromise;
    expect(batchResult.size).toBe(100);
    await joinedRejection;
    expect(laterRequestPaths).toEqual([laterPath]);
    expect(http.match(() => true)).toHaveLength(0);
  });

  it('cleans up a failed chunk so it can retry while a successful chunk stays cached', async () => {
    const paths = Array.from(
      {length: 101},
      (_, index) => `videos/${index}.mp4`,
    );
    const batchPromise = service.signUrls(paths);
    const requests = http.match(request =>
      request.urlWithParams.startsWith('/api/signUrl?'),
    );
    expect(requests.length).toBe(2);
    const firstPaths = new URL(
      requests[0].request.urlWithParams,
      'https://test.invalid',
    ).searchParams.getAll('path');
    requests[0].flush({
      urls: Object.fromEntries(
        firstPaths.map(path => [path, `https://signed.test/${path}`]),
      ),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    requests[1].flush('temporarily unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });

    await expect(batchPromise).rejects.toThrow();
    await expect(service.signUrl(paths[0])).resolves.toBe(
      `https://signed.test/${paths[0]}`,
    );

    const retryPromise = service.signUrl(paths[100]);
    const retryRequest = http.expectOne(
      '/api/signUrl?' + `path=${encodeURIComponent(paths[100])}`,
    );
    retryRequest.flush({
      urls: {[paths[100]]: `https://signed.test/${paths[100]}`},
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await expect(retryPromise).resolves.toBe(
      `https://signed.test/${paths[100]}`,
    );
  });
});
