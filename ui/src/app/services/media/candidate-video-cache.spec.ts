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

import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MediaService} from './media';
import {CandidateVideoCacheService} from './candidate-video-cache';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

describe('CandidateVideoCacheService', () => {
  let service: CandidateVideoCacheService;
  let mediaServiceMock: {resolve: ReturnType<typeof vi.fn>};
  let cache: MemoryCache;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cache = new MemoryCache();
    mediaServiceMock = {resolve: vi.fn()};
    fetchMock = vi.fn();
    vi.stubGlobal('caches', {open: vi.fn().mockResolvedValue(cache)});
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:lease');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    TestBed.configureTestingModule({
      providers: [
        CandidateVideoCacheService,
        {provide: MediaService, useValue: mediaServiceMock},
      ],
    });
    service = TestBed.inject(CandidateVideoCacheService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shares one persistent download and revokes its object URL after the last release', async () => {
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {'content-type': 'video/mp4'},
      }),
    );

    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const file = {path: 'videos/a.mp4'};
    const [first, second] = await Promise.all([
      service.acquire(scope, file, true),
      service.acquire(scope, file, true),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.url).toBe('blob:lease');
    expect(second.url).toBe(first.url);
    first.release();
    first.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:lease');
    second.release();
  });

  it('bypasses persistent storage for legacy references and non-persistent consumers', async () => {
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');

    const legacy = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {url: 'https://legacy.example/a.mp4'},
      true,
    );
    const transient = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/a.mp4'},
      false,
    );

    expect(legacy.url).toBe('https://signed.example/a.mp4');
    expect(transient.url).toBe('https://signed.example/a.mp4');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.values.size).toBe(0);
    legacy.release();
    transient.release();
  });

  it('reuses complete local bytes with a stable key despite a new signed URL', async () => {
    mediaServiceMock.resolve
      .mockResolvedValueOnce('https://signed.example/v1')
      .mockResolvedValueOnce('https://signed.example/v2');
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), {status: 200}),
    );

    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const file = {path: 'videos/a.mp4'};
    const first = await service.acquire(scope, file, true);
    first.release();
    const second = await service.acquire(scope, file, true);

    expect(second.url).toBe('blob:lease');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mediaServiceMock.resolve).toHaveBeenCalledTimes(1);
    expect([...cache.values.keys()][0]).not.toContain('signed.example');
    second.release();
  });

  it('discards cache entries with invalid metadata before fetching fresh bytes', async () => {
    cache.values.set(
      'http://localhost:3000/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/videos/a.mp4',
      new Response(new Uint8Array([9]), {
        status: 200,
        headers: {
          'content-length': '1',
          'x-scene-machine-cached-at': 'not-a-timestamp',
          'x-scene-machine-cached-size': '1',
        },
      }),
    );
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/a.mp4'},
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lease.url).toBe('blob:lease');
    lease.release();
  });

  it('does not serve a cache entry dated in the future', async () => {
    cache.values.set(
      'http://localhost:3000/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/videos/a.mp4',
      new Response(new Uint8Array([9]), {
        status: 200,
        headers: {
          'content-length': '1',
          'x-scene-machine-cached-at': String(Date.now() + 60_000),
          'x-scene-machine-cached-size': '1',
        },
      }),
    );
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/a.mp4'},
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('keeps bucket, project, and object path namespaces separate', async () => {
    let leaseNumber = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(
      () => `blob:lease-${++leaseNumber}`,
    );
    mediaServiceMock.resolve.mockImplementation((file: {path?: string}) =>
      Promise.resolve(`https://signed.example/${file.path}`),
    );
    fetchMock.mockImplementation(
      async (url: string) =>
        new Response(new Uint8Array([url.length]), {status: 200}),
    );

    const references = [
      [{bucket: 'bucket-a', projectId: 'project-a'}, {path: 'same.mp4'}],
      [{bucket: 'bucket-b', projectId: 'project-a'}, {path: 'same.mp4'}],
      [{bucket: 'bucket-a', projectId: 'project-b'}, {path: 'same.mp4'}],
      [{bucket: 'bucket-a', projectId: 'project-a'}, {path: 'other.mp4'}],
    ] as const;
    const leases = await Promise.all(
      references.map(([scope, file]) => service.acquire(scope, file, true)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cache.values.size).toBe(4);
    expect(new Set(leases.map(lease => lease.url)).size).toBe(4);
    leases.forEach(lease => lease.release());
  });

  it('expires entries at seven days and refetches them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), {status: 200}),
    );
    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const file = {path: 'videos/a.mp4'};

    const first = await service.acquire(scope, file, true);
    first.release();
    vi.setSystemTime(new Date(Date.now() + CACHE_TTL_MS));
    const second = await service.acquire(scope, file, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.release();
    vi.useRealTimers();
  });

  it('rejects non-200, opaque, and oversized responses to the cache but returns the signed URL', async () => {
    const cases = [
      new Response(new Uint8Array([1]), {status: 206}),
      {status: 0, type: 'opaque', headers: new Headers(), body: null},
      {status: 200, type: 'error', headers: new Headers(), body: null},
      {
        status: 200,
        type: 'cors',
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => ({
              done: false,
              value: {byteLength: MAX_ENTRY_BYTES + 1},
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn(),
          }),
        },
      },
    ];
    mediaServiceMock.resolve.mockImplementation((file: {path?: string}) =>
      Promise.resolve(`https://signed.example/${file.path}`),
    );
    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const leases: Array<{url: string; release(): void}> = [];
    for (const [index, response] of cases.entries()) {
      fetchMock.mockResolvedValueOnce(response);
      const lease = await service.acquire(
        scope,
        {path: `videos/${index}.mp4`},
        true,
      );
      leases.push(lease);
      expect(lease.url).toBe(`https://signed.example/videos/${index}.mp4`);
    }
    expect(cache.values.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
    leases.forEach(lease => lease.release());
  });

  it('cancels response bodies rejected before stream reading', async () => {
    const cancellations: Array<ReturnType<typeof vi.fn>> = [];
    const rejectedResponse = (headers: Headers): Response => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      cancellations.push(cancel);
      return {
        status: 200,
        type: 'cors',
        headers,
        body: {cancel},
      } as unknown as Response;
    };
    mediaServiceMock.resolve.mockImplementation((file: {path?: string}) =>
      Promise.resolve(`https://signed.example/${file.path}`),
    );
    fetchMock
      .mockResolvedValueOnce({
        status: 206,
        type: 'cors',
        headers: new Headers(),
        body: {
          cancel: (() => {
            const cancel = vi.fn().mockResolvedValue(undefined);
            cancellations.push(cancel);
            return cancel;
          })(),
        },
      } as unknown as Response)
      .mockResolvedValueOnce(
        rejectedResponse(
          new Headers({'content-length': String(MAX_ENTRY_BYTES + 1)}),
        ),
      );

    const first = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/partial.mp4'},
      true,
    );
    const second = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/large.mp4'},
      true,
    );

    expect(cancellations).toHaveLength(2);
    cancellations.forEach(cancel => expect(cancel).toHaveBeenCalledTimes(1));
    expect(first.url).toBe('https://signed.example/videos/partial.mp4');
    expect(second.url).toBe('https://signed.example/videos/large.mp4');
    first.release();
    second.release();
  });

  it('evicts the oldest entry when the entry-count bound is reached', async () => {
    vi.useFakeTimers();
    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const now = Date.now();
    for (let index = 0; index < 64; index++) {
      cache.values.set(
        `http://localhost/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/${index}.mp4`,
        new Response(new Uint8Array([index]), {
          status: 200,
          headers: {
            'content-length': '1',
            'x-scene-machine-cached-at': String(now - (64 - index)),
            'x-scene-machine-cached-size': '1',
          },
        }),
      );
    }
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/new');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(scope, {path: 'new.mp4'}, true);

    expect(cache.values.size).toBe(64);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.mp4'))).toBe(
      false,
    );
    expect([...cache.values.keys()].some(key => key.endsWith('/new.mp4'))).toBe(
      true,
    );
    lease.release();
    vi.useRealTimers();
  });

  it('enforces the total-byte bound using stored metadata', async () => {
    const now = Date.now();
    for (let index = 0; index < 8; index++) {
      cache.values.set(
        `http://localhost:3000/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/${index}.mp4`,
        new Response(new Uint8Array([index]), {
          status: 200,
          headers: {
            'content-length': String(MAX_ENTRY_BYTES),
            'x-scene-machine-cached-at': String(now - (8 - index)),
            'x-scene-machine-cached-size': String(MAX_ENTRY_BYTES),
          },
        }),
      );
    }
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/new');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'new.mp4'},
      true,
    );

    expect(cache.values.size).toBe(8);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.mp4'))).toBe(
      false,
    );
    expect([...cache.values.keys()].some(key => key.endsWith('/new.mp4'))).toBe(
      true,
    );
    lease.release();
  });

  it('does not evict above 256 MiB while the 512 MiB video budget has room', async () => {
    const now = Date.now();
    for (let index = 0; index < 4; index++) {
      cache.values.set(
        `http://localhost:3000/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/${index}.mp4`,
        new Response(new Uint8Array([index]), {
          status: 200,
          headers: {
            'content-length': String(MAX_ENTRY_BYTES),
            'x-scene-machine-cached-at': String(now - (4 - index)),
            'x-scene-machine-cached-size': String(MAX_ENTRY_BYTES),
          },
        }),
      );
    }
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/new');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'new.mp4'},
      true,
    );

    expect(cache.values.size).toBe(5);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.mp4'))).toBe(
      true,
    );
    lease.release();
  });

  it('retains an entry that brings stored metadata exactly to 512 MiB', async () => {
    const now = Date.now();
    for (let index = 0; index < 8; index++) {
      const size = index === 0 ? MAX_ENTRY_BYTES - 1 : MAX_ENTRY_BYTES;
      cache.values.set(
        `http://localhost:3000/__scene_machine_candidate_video_cache__/v1/bucket-a/project-a/${index}.mp4`,
        new Response(new Uint8Array([index]), {
          status: 200,
          headers: {
            'content-length': String(size),
            'x-scene-machine-cached-at': String(now - (8 - index)),
            'x-scene-machine-cached-size': String(size),
          },
        }),
      );
    }
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/new');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'new.mp4'},
      true,
    );

    expect(cache.values.size).toBe(9);
    expect([...cache.values.keys()].some(key => key.endsWith('/0.mp4'))).toBe(
      true,
    );
    lease.release();
  });

  it('falls back to the signed URL when Cache Storage rejects a write', async () => {
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );
    vi.spyOn(cache, 'put').mockRejectedValue(new Error('quota exceeded'));

    const lease = await service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/a.mp4'},
      true,
    );

    expect(lease.url).toBe('https://signed.example/a.mp4');
    expect(cache.values.size).toBe(0);
    lease.release();
  });

  it('does not repopulate a candidate after invalidation races its download', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>(resolve => (resolveFetch = resolve)),
    );
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    const scope = {bucket: 'bucket-a', projectId: 'project-a'};
    const file = {path: 'videos/a.mp4'};
    const acquisition = service.acquire(scope, file, true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const invalidation = service.invalidateCandidate(
      scope.projectId,
      file.path,
    );
    resolveFetch(new Response(new Uint8Array([1]), {status: 200}));

    const lease = await acquisition;
    await invalidation;
    expect(lease.url).toBe('https://signed.example/a.mp4');
    expect(cache.values.size).toBe(0);
    lease.release();
  });

  it('removes a candidate path across buckets without removing other paths', async () => {
    mediaServiceMock.resolve.mockImplementation((file: {path?: string}) =>
      Promise.resolve(`https://signed.example/${file.path}`),
    );
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), {status: 200}),
    );
    const leases = await Promise.all([
      service.acquire(
        {bucket: 'bucket-a', projectId: 'project-a'},
        {path: 'same.mp4'},
        true,
      ),
      service.acquire(
        {bucket: 'bucket-b', projectId: 'project-a'},
        {path: 'same.mp4'},
        true,
      ),
      service.acquire(
        {bucket: 'bucket-a', projectId: 'project-a'},
        {path: 'other.mp4'},
        true,
      ),
    ]);
    leases.forEach(lease => lease.release());

    await service.invalidateCandidate('project-a', 'same.mp4');

    expect(cache.values.size).toBe(1);
    expect([...cache.values.keys()][0]).toContain('/other.mp4');
  });

  it('deletes a write that was already in progress when a candidate is invalidated', async () => {
    let releasePut!: () => void;
    const putGate = new Promise<void>(resolve => (releasePut = resolve));
    const originalPut = cache.put.bind(cache);
    const putStarted = new Promise<void>(resolve => {
      vi.spyOn(cache, 'put').mockImplementation(async (request, response) => {
        resolve();
        await putGate;
        await originalPut(request, response);
      });
    });
    mediaServiceMock.resolve.mockResolvedValue('https://signed.example/a.mp4');
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {status: 200}),
    );

    const acquisition = service.acquire(
      {bucket: 'bucket-a', projectId: 'project-a'},
      {path: 'videos/a.mp4'},
      true,
    );
    await putStarted;
    const invalidation = service.invalidateCandidate(
      'project-a',
      'videos/a.mp4',
    );
    releasePut();
    const lease = await acquisition;
    await invalidation;

    expect(cache.values.size).toBe(0);
    lease.release();
  });

  it('invalidates every bucket entry for a deleted project', async () => {
    mediaServiceMock.resolve.mockImplementation((file: {path?: string}) =>
      Promise.resolve(`https://signed.example/${file.path}`),
    );
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([1]), {status: 200}),
    );
    const leases = await Promise.all([
      service.acquire(
        {bucket: 'bucket-a', projectId: 'project-a'},
        {path: 'a.mp4'},
        true,
      ),
      service.acquire(
        {bucket: 'bucket-b', projectId: 'project-a'},
        {path: 'b.mp4'},
        true,
      ),
      service.acquire(
        {bucket: 'bucket-a', projectId: 'project-b'},
        {path: 'c.mp4'},
        true,
      ),
    ]);

    await service.invalidateProject('project-a');

    expect(cache.values.size).toBe(1);
    expect([...cache.values.keys()][0]).toContain('/project-b/');
    leases.forEach(lease => lease.release());
  });
});
