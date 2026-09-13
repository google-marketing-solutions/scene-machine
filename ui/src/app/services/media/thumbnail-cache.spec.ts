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

import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {MediaRef, MediaService} from './media';
import {ThumbnailCacheService} from './thumbnail-cache';

class MemoryCache {
  readonly values = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.values.delete(request.url);
  }

  async keys(): Promise<Request[]> {
    return [...this.values.keys()].map(key => new Request(key));
  }
}

const scope = {bucket: 'bucket-a', projectId: 'project-a'};
const file = {path: 'thumbnails/a.webp'};
describe.sequential('MediaCacheEngine thumbnail policy', () => {
  let cache: MemoryCache;
  let fetchMock: ReturnType<typeof vi.fn>;
  let resolveMock: ReturnType<
    typeof vi.fn<(file: MediaRef | null | undefined) => Promise<string>>
  >;
  let service: ThumbnailCacheService;

  beforeEach(() => {
    cache = new MemoryCache();
    fetchMock = vi.fn();
    resolveMock = vi
      .fn<(file: MediaRef | null | undefined) => Promise<string>>()
      .mockResolvedValue('https://signed.example/a.webp');
    TestBed.configureTestingModule({
      providers: [
        ThumbnailCacheService,
        {provide: MediaService, useValue: {resolve: resolveMock}},
      ],
    });
    vi.stubGlobal('caches', {open: vi.fn().mockResolvedValue(cache)});
    vi.stubGlobal('fetch', fetchMock);
    service = TestBed.runInInjectionContext(() => new ThumbnailCacheService());
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:thumbnail');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createService(): ThumbnailCacheService {
    return TestBed.runInInjectionContext(() => new ThumbnailCacheService());
  }

  function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
    return new Response(bytes.buffer as ArrayBuffer, {status: 200, headers});
  }

  it('stores under the thumbnail namespace and serves a warm hit without resolving or fetching', async () => {
    fetchMock.mockResolvedValue(response(new Uint8Array([1, 2, 3])));
    const first = await service.acquire(scope, file);
    expect(first.url).toBe('blob:thumbnail');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.release();
    resolveMock.mockClear();
    fetchMock.mockClear();

    const second = await service.acquire(scope, file);

    expect(resolveMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(second.url).toBe('blob:thumbnail');
    second.release();
  });

  it('keeps bucket, project, and path keys isolated', async () => {
    let leaseNumber = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(
      () => `blob:thumbnail-${++leaseNumber}`,
    );
    fetchMock.mockImplementation(async (url: string) =>
      response(new Uint8Array([url.length])),
    );
    const leases = await Promise.all([
      createService().acquire({bucket: 'a', projectId: 'p'}, {path: 'same'}),
      createService().acquire({bucket: 'b', projectId: 'p'}, {path: 'same'}),
      createService().acquire({bucket: 'a', projectId: 'q'}, {path: 'same'}),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cache.values).toHaveProperty('size', 3);
    leases.forEach(lease => lease.release());
  });

  it('accepts exactly one MiB and rejects a streamed byte beyond one MiB', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(new Uint8Array(1024 * 1024), {
          'content-length': String(1024 * 1024),
        }),
      )
      .mockResolvedValueOnce(
        response(new Uint8Array(1024 * 1024 + 1), {
          'content-length': String(1024 * 1024 + 1),
        }),
      );
    const engine = createService();
    const accepted = await engine.acquire(scope, file);
    accepted.release();
    const rejected = await engine.acquire(scope, {
      path: 'thumbnails/large.webp',
    });

    expect(accepted.url).toBe('blob:thumbnail');
    expect(rejected.url).toBe('https://signed.example/a.webp');
    expect(cache.values.size).toBe(1);
    rejected.release();
  });

  it('rejects an oversize stream even when content length lies or is missing', async () => {
    const oversized = (headers: Headers) =>
      ({
        status: 200,
        type: 'cors',
        headers,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new Uint8Array(1024 * 1024),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new Uint8Array(1),
              }),
            cancel: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn(),
          }),
        },
      }) as unknown as Response;
    fetchMock
      .mockResolvedValueOnce(oversized(new Headers({'content-length': '1'})))
      .mockResolvedValueOnce(oversized(new Headers()));

    const first = await createService().acquire(scope, {
      path: 'thumbnails/lying.webp',
    });
    const second = await createService().acquire(scope, {
      path: 'thumbnails/missing-length.webp',
    });

    expect(first.url).toBe('https://signed.example/a.webp');
    expect(second.url).toBe('https://signed.example/a.webp');
    expect(cache.values.size).toBe(0);
    first.release();
    second.release();
  });

  it('falls back to the direct URL when Cache Storage is unavailable or quota rejects a write', async () => {
    fetchMock.mockResolvedValue(response(new Uint8Array([1])));
    vi.stubGlobal('caches', {
      open: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    const unavailable = await createService().acquire(scope, file);
    expect(unavailable.url).toBe('https://signed.example/a.webp');
    unavailable.release();

    vi.stubGlobal('caches', {open: vi.fn().mockResolvedValue(cache)});
    vi.spyOn(cache, 'put').mockRejectedValue(new Error('quota'));
    const quota = await createService().acquire(scope, {
      path: 'thumbnails/quota.webp',
    });
    expect(quota.url).toBe('https://signed.example/a.webp');
    quota.release();
  });

  it('deduplicates concurrent downloads and revokes after all lease releases', async () => {
    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>(resolveFetch => (releaseFetch = resolveFetch)),
    );
    const engine = createService();
    const firstPromise = engine.acquire(scope, file);
    const secondPromise = engine.acquire(scope, file);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch(response(new Uint8Array([1])));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    first.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail');
  });

  it('does not repopulate a path after invalidation races its download', async () => {
    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>(resolveFetch => (releaseFetch = resolveFetch)),
    );
    const engine = createService();
    const acquisition = engine.acquire(scope, file);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const invalidation = engine.invalidateCandidate(scope.projectId, file.path);
    releaseFetch(response(new Uint8Array([1])));
    const lease = await acquisition;
    await invalidation;

    expect(lease.url).toBe('https://signed.example/a.webp');
    expect(cache.values.size).toBe(0);
    lease.release();
  });

  it('expires a download after seven days without refreshing the TTL on reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fetchMock.mockResolvedValue(response(new Uint8Array([1])));
    const engine = createService();
    const first = await engine.acquire(scope, file);
    first.release();
    vi.setSystemTime(new Date('2026-01-08T00:00:00Z'));
    const second = await engine.acquire(scope, file);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.release();
  });

  it('evicts the oldest bytes when the aggregate 64 MiB bound is reached', async () => {
    const now = Date.now();
    for (let index = 0; index < 64; index++) {
      cache.values.set(
        `http://localhost/__scene_machine_thumbnail_cache__/v1/bucket-a/project-a/${index}.webp`,
        response(new Uint8Array([index]), {
          'x-scene-machine-cached-at': String(now - (64 - index)),
          'x-scene-machine-cached-size': String(1024 * 1024),
        }),
      );
    }
    fetchMock.mockResolvedValue(response(new Uint8Array([1])));

    const lease = await service.acquire(scope, {path: 'new.webp'});

    expect(cache.values.size).toBe(64);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.webp'))).toBe(
      false,
    );
    expect(
      [...cache.values.keys()].some(key => key.endsWith('/new.webp')),
    ).toBe(true);
    lease.release();
  });

  it('serializes mutations from independent engines with the namespace lock', async () => {
    let lockQueue = Promise.resolve();
    const locks = {
      request: <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
        const result = lockQueue.then(callback);
        lockQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    } as unknown as LockManager;
    vi.stubGlobal('navigator', {locks});
    const now = Date.now();
    for (let index = 0; index < 63; index++) {
      cache.values.set(
        `http://localhost/__scene_machine_thumbnail_cache__/v1/bucket-a/project-a/${index}.webp`,
        response(new Uint8Array([index]), {
          'x-scene-machine-cached-at': String(now - (63 - index)),
          'x-scene-machine-cached-size': String(1024 * 1024),
        }),
      );
    }
    fetchMock.mockImplementation(async () =>
      response(new Uint8Array(1024 * 1024)),
    );
    const first = createService();
    const second = createService();

    const leases = await Promise.all([
      first.acquire(scope, {path: 'first.webp'}),
      second.acquire(scope, {path: 'second.webp'}),
    ]);

    expect(cache.values.size).toBe(64);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.webp'))).toBe(
      false,
    );
    leases.forEach(lease => lease.release());
  });
});
