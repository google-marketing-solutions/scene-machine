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

import {MediaRef} from './media';

export interface MediaCacheScope {
  bucket: string;
  projectId: string;
}

export interface MediaCacheLease {
  url: string;
  release(): void;
}

export interface MediaCacheEngineOptions {
  cacheName: string;
  cachePath: string;
  entryLabel: string;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

interface ActiveLease {
  key: string;
  version: string;
  url: string;
  refs: number;
}

interface CacheResult {
  blob?: Blob;
  fallbackUrl: string;
}

interface CacheMetadata {
  downloadedAt: number;
  size: number;
}

interface CacheEntry {
  request: Request;
  metadata: CacheMetadata;
}

interface ParsedCacheKey {
  bucket: string;
  projectId: string;
  path: string;
}

const CACHED_AT_HEADER = 'x-scene-machine-cached-at';
const CACHED_SIZE_HEADER = 'x-scene-machine-cached-size';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache Storage plus object-URL leases, parameterized for one media kind. */
export class MediaCacheEngine {
  private readonly pending = new Map<
    string,
    {version: string; promise: Promise<CacheResult>}
  >();
  private readonly active = new Map<string, ActiveLease>();
  private readonly projectVersions = new Map<string, number>();
  private readonly candidateVersions = new Map<string, number>();
  private cachePromise: Promise<Cache | null> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly resolve: (
      file: MediaRef | null | undefined,
    ) => Promise<string>,
    private readonly options: MediaCacheEngineOptions,
  ) {}

  async acquire(
    scope: MediaCacheScope,
    file: MediaRef | null | undefined,
    persist = true,
  ): Promise<MediaCacheLease> {
    if (!persist || !file?.path) {
      return this.directLease(await this.resolve(file));
    }

    const key = this.cacheRequest(scope, file.path).url;
    const version = this.version(scope.projectId, file.path);
    const current = this.active.get(key);
    if (current?.version === version) return this.retain(current);

    let pending = this.pending.get(key);
    if (!pending || pending.version !== version) {
      const promise = this.load(scope, file, key, version);
      pending = {version, promise};
      this.pending.set(key, pending);
      void promise.then(
        () => this.clearPending(key, promise),
        () => this.clearPending(key, promise),
      );
    }

    const result = await pending.promise;
    if (!result.blob || this.version(scope.projectId, file.path) !== version) {
      return this.directLease(
        result.fallbackUrl || (await this.safeResolve(file)),
      );
    }
    try {
      return this.createLease(key, version, result.blob);
    } catch {
      return this.directLease(
        result.fallbackUrl || (await this.safeResolve(file)),
      );
    }
  }

  async invalidateCandidate(projectId: string, path: string): Promise<void> {
    this.bump(this.candidateVersions, this.candidateKey(projectId, path));
    await this.enqueueMutation(async () => {
      try {
        const cache = await this.openCache();
        if (!cache) return;
        await this.deleteMatching(
          cache,
          key => key.projectId === projectId && key.path === path,
        );
      } catch {
        // Cache Storage is an optional local optimization.
      }
    });
  }

  async invalidateProject(projectId: string): Promise<void> {
    this.bump(this.projectVersions, projectId);
    await this.enqueueMutation(async () => {
      try {
        const cache = await this.openCache();
        if (!cache) return;
        await this.deleteMatching(cache, key => key.projectId === projectId);
      } catch {
        // Cache Storage is an optional local optimization.
      }
    });
  }

  private async load(
    scope: MediaCacheScope,
    file: MediaRef,
    key: string,
    version: string,
  ): Promise<CacheResult> {
    let fallbackUrl = '';
    try {
      const cache = await this.openCache();
      const request = new Request(key);
      if (cache) {
        const cached = await cache.match(request);
        if (cached) {
          const metadata = this.metadata(cached);
          if (metadata && this.isFresh(metadata.downloadedAt)) {
            try {
              const blob = await this.readResponse(cached);
              if (this.version(scope.projectId, file.path!) === version) {
                return {blob, fallbackUrl: ''};
              }
            } catch {
              // A corrupt or unexpectedly large entry is discarded below.
            }
          }
          await cache.delete(request);
        }
      }

      fallbackUrl = await this.safeResolve(file);
      if (!cache || !fallbackUrl) return {fallbackUrl};

      const response = await fetch(fallbackUrl, {
        credentials: 'omit',
        mode: 'cors',
      });
      const blob = await this.readResponse(response);
      if (this.version(scope.projectId, file.path!) !== version) {
        return {fallbackUrl};
      }

      await this.enqueueMutation(async () => {
        if (this.version(scope.projectId, file.path!) !== version) return;
        await this.store(cache, request, blob);
      });
      return {blob, fallbackUrl};
    } catch {
      return {fallbackUrl: fallbackUrl || (await this.safeResolve(file))};
    }
  }

  private async readResponse(response: Response): Promise<Blob> {
    if (
      response.status !== 200 ||
      !['basic', 'cors', 'default'].includes(response.type)
    ) {
      await this.cancelResponse(response);
      throw new Error('Only complete CORS HTTP 200 responses are cacheable');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > this.options.maxEntryBytes
    ) {
      await this.cancelResponse(response);
      throw new Error(`${this.options.entryLabel} is too large to cache`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response has no readable body');
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!result.value) continue;
        size += result.value.byteLength;
        if (size > this.options.maxEntryBytes) {
          await reader.cancel();
          throw new Error(`${this.options.entryLabel} is too large to cache`);
        }
        const chunk = new ArrayBuffer(result.value.byteLength);
        new Uint8Array(chunk).set(result.value);
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (size === 0)
      throw new Error(`${this.options.entryLabel} response is empty`);
    return new Blob(chunks, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  }

  private async store(
    cache: Cache,
    request: Request,
    blob: Blob,
  ): Promise<void> {
    if (blob.size > this.options.maxEntryBytes) {
      throw new Error(`${this.options.entryLabel} is too large to cache`);
    }
    const entries = await this.validEntries(cache);
    const retained = entries.filter(entry => entry.request.url !== request.url);
    let total = retained.reduce((sum, entry) => sum + entry.metadata.size, 0);
    while (
      retained.length >= this.options.maxEntries ||
      total + blob.size > this.options.maxTotalBytes
    ) {
      const oldest = retained.shift();
      if (!oldest) {
        throw new Error(
          `Unable to make room in ${this.options.entryLabel} cache`,
        );
      }
      total -= oldest.metadata.size;
      await cache.delete(oldest.request);
    }
    await cache.put(
      request,
      new Response(blob, {
        status: 200,
        headers: {
          'content-length': String(blob.size),
          'content-type': blob.type || 'application/octet-stream',
          [CACHED_AT_HEADER]: String(Date.now()),
          [CACHED_SIZE_HEADER]: String(blob.size),
        },
      }),
    );
  }

  private async validEntries(cache: Cache): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const metadata = response && this.metadata(response);
      if (!metadata || !this.isFresh(metadata.downloadedAt)) {
        await cache.delete(request);
        continue;
      }
      entries.push({request, metadata});
    }
    entries.sort((a, b) => a.metadata.downloadedAt - b.metadata.downloadedAt);
    return entries;
  }

  private metadata(response: Response): CacheMetadata | undefined {
    const downloadedAt = Number(response.headers.get(CACHED_AT_HEADER));
    const size = Number(
      response.headers.get(CACHED_SIZE_HEADER) ||
        response.headers.get('content-length'),
    );
    if (
      !Number.isFinite(downloadedAt) ||
      !Number.isFinite(size) ||
      downloadedAt <= 0 ||
      size <= 0 ||
      size > this.options.maxEntryBytes
    ) {
      return undefined;
    }
    return {downloadedAt, size};
  }

  private isFresh(downloadedAt: number): boolean {
    const now = Date.now();
    return downloadedAt <= now && now - downloadedAt < CACHE_TTL_MS;
  }

  private async cancelResponse(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already unusable; cancellation is best effort.
    }
  }

  private async deleteMatching(
    cache: Cache,
    predicate: (key: ParsedCacheKey) => boolean,
  ): Promise<void> {
    for (const request of await cache.keys()) {
      const key = this.parseCacheKey(request.url);
      if (key && predicate(key)) await cache.delete(request);
    }
  }

  private cacheRequest(scope: MediaCacheScope, path: string): Request {
    const origin = globalThis.location?.origin || 'http://localhost';
    return new Request(
      new URL(
        `${this.options.cachePath}${encodeURIComponent(scope.bucket)}/${encodeURIComponent(scope.projectId)}/${encodeURIComponent(path)}`,
        origin,
      ),
    );
  }

  private parseCacheKey(urlString: string): ParsedCacheKey | undefined {
    try {
      const origin = globalThis.location?.origin || 'http://localhost';
      const url = new URL(urlString);
      if (
        url.origin !== origin ||
        !url.pathname.startsWith(this.options.cachePath)
      ) {
        return undefined;
      }
      const parts = url.pathname
        .slice(this.options.cachePath.length)
        .split('/');
      if (parts.length !== 3 || parts.some(part => !part)) return undefined;
      return {
        bucket: decodeURIComponent(parts[0]),
        path: decodeURIComponent(parts[2]),
        projectId: decodeURIComponent(parts[1]),
      };
    } catch {
      return undefined;
    }
  }

  private createLease(
    key: string,
    version: string,
    blob: Blob,
  ): MediaCacheLease {
    const current = this.active.get(key);
    if (current?.version === version) return this.retain(current);
    const url = URL.createObjectURL(blob);
    const entry: ActiveLease = {key, refs: 1, url, version};
    this.active.set(key, entry);
    return this.lease(entry);
  }

  private retain(entry: ActiveLease): MediaCacheLease {
    entry.refs++;
    return this.lease(entry);
  }

  private lease(entry: ActiveLease): MediaCacheLease {
    let released = false;
    return {
      url: entry.url,
      release: () => {
        if (released) return;
        released = true;
        this.release(entry);
      },
    };
  }

  private release(entry: ActiveLease): void {
    entry.refs--;
    if (entry.refs > 0) return;
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key);
    URL.revokeObjectURL(entry.url);
  }

  private directLease(url: string): MediaCacheLease {
    return {url, release: () => {}};
  }

  private async safeResolve(
    file: MediaRef | null | undefined,
  ): Promise<string> {
    try {
      return await this.resolve(file);
    } catch {
      return '';
    }
  }

  private async openCache(): Promise<Cache | null> {
    if (!this.cachePromise) {
      const storage = globalThis.caches;
      this.cachePromise = storage
        ? storage.open(this.options.cacheName).catch(() => null)
        : Promise.resolve(null);
    }
    return this.cachePromise;
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const lockedTask = async (): Promise<T> => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return task();
      return locks.request(`${this.options.cacheName}:mutations`, task);
    };
    const result = this.mutationQueue.then(lockedTask, lockedTask);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private clearPending(key: string, promise: Promise<CacheResult>): void {
    if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
  }

  private candidateKey(projectId: string, path: string): string {
    return `${projectId}\0${path}`;
  }

  private version(projectId: string, path: string): string {
    return `${this.projectVersions.get(projectId) || 0}:${this.candidateVersions.get(this.candidateKey(projectId, path)) || 0}`;
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) || 0) + 1);
  }
}
