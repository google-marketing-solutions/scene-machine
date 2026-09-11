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

import {inject, Injectable} from '@angular/core';
import {MediaRef, MediaService} from './media';

export interface CandidateCacheScope {
  bucket: string;
  projectId: string;
}

export interface CandidateVideoLease {
  url: string;
  release(): void;
}

const CACHE_NAME = 'scene-machine-candidate-videos-v1';
const CACHE_PATH = '/__scene_machine_candidate_video_cache__/v1/';
const CACHED_AT_HEADER = 'x-scene-machine-cached-at';
const CACHED_SIZE_HEADER = 'x-scene-machine-cached-size';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 64;

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

@Injectable({providedIn: 'root'})
export class CandidateVideoCacheService {
  private readonly mediaService = inject(MediaService);
  private readonly pending = new Map<
    string,
    {version: string; promise: Promise<CacheResult>}
  >();
  private readonly active = new Map<string, ActiveLease>();
  private readonly projectVersions = new Map<string, number>();
  private readonly candidateVersions = new Map<string, number>();
  private cachePromise: Promise<Cache | null> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  async acquire(
    scope: CandidateCacheScope,
    file: MediaRef | null | undefined,
    persist: boolean,
  ): Promise<CandidateVideoLease> {
    if (!persist || !file?.path) {
      return this.directLease(await this.resolve(file));
    }

    const key = this.cacheRequest(scope, file.path).url;
    const version = this.version(scope.projectId, file.path);
    const current = this.active.get(key);
    if (current?.version === version) {
      return this.retain(current);
    }

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
      return this.directLease(result.fallbackUrl || (await this.resolve(file)));
    }
    try {
      return this.createLease(key, version, result.blob);
    } catch {
      return this.directLease(result.fallbackUrl || (await this.resolve(file)));
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
        // Invalidation is best effort; Cache Storage is an optional local
        // optimization and must not block archive/delete flows.
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
        // See invalidateCandidate: local cache failures are non-fatal.
      }
    });
  }

  private async load(
    scope: CandidateCacheScope,
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

      fallbackUrl = await this.resolve(file);
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
      return {fallbackUrl: fallbackUrl || (await this.resolve(file))};
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
    if (Number.isFinite(contentLength) && contentLength > MAX_ENTRY_BYTES) {
      await this.cancelResponse(response);
      throw new Error('Candidate video is too large to cache');
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
        if (size > MAX_ENTRY_BYTES) {
          await reader.cancel();
          throw new Error('Candidate video is too large to cache');
        }
        // Copy into an ArrayBuffer rather than retaining a stream reader's
        // ArrayBufferLike view; this also ensures a producer cannot mutate a
        // chunk after it has been accepted.
        const chunk = new ArrayBuffer(result.value.byteLength);
        new Uint8Array(chunk).set(result.value);
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (size === 0) throw new Error('Candidate video response is empty');
    return new Blob(chunks, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  }

  private async store(
    cache: Cache,
    request: Request,
    blob: Blob,
  ): Promise<void> {
    if (blob.size > MAX_ENTRY_BYTES) {
      throw new Error('Candidate video is too large to cache');
    }
    const entries = await this.validEntries(cache);
    const retained = entries.filter(entry => entry.request.url !== request.url);
    let total = retained.reduce((sum, entry) => sum + entry.metadata.size, 0);
    while (
      retained.length >= MAX_ENTRIES ||
      total + blob.size > MAX_TOTAL_BYTES
    ) {
      const oldest = retained.shift();
      if (!oldest) throw new Error('Unable to make room in video cache');
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
      size > MAX_ENTRY_BYTES
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

  private cacheRequest(scope: CandidateCacheScope, path: string): Request {
    const origin = globalThis.location?.origin || 'http://localhost';
    return new Request(
      new URL(
        `${CACHE_PATH}${encodeURIComponent(scope.bucket)}/${encodeURIComponent(scope.projectId)}/${encodeURIComponent(path)}`,
        origin,
      ),
    );
  }

  private parseCacheKey(urlString: string): ParsedCacheKey | undefined {
    try {
      const origin = globalThis.location?.origin || 'http://localhost';
      const url = new URL(urlString);
      if (url.origin !== origin || !url.pathname.startsWith(CACHE_PATH)) {
        return undefined;
      }
      const parts = url.pathname.slice(CACHE_PATH.length).split('/');
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
  ): CandidateVideoLease {
    const current = this.active.get(key);
    if (current?.version === version) return this.retain(current);
    const url = URL.createObjectURL(blob);
    const entry: ActiveLease = {key, refs: 1, url, version};
    this.active.set(key, entry);
    return this.lease(entry);
  }

  private retain(entry: ActiveLease): CandidateVideoLease {
    entry.refs++;
    return this.lease(entry);
  }

  private lease(entry: ActiveLease): CandidateVideoLease {
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

  private directLease(url: string): CandidateVideoLease {
    return {
      url,
      release: () => {},
    };
  }

  private async resolve(file: MediaRef | null | undefined): Promise<string> {
    try {
      return await this.mediaService.resolve(file);
    } catch {
      return '';
    }
  }

  private async openCache(): Promise<Cache | null> {
    if (!this.cachePromise) {
      const storage = globalThis.caches;
      this.cachePromise = storage
        ? storage.open(CACHE_NAME).catch(() => null)
        : Promise.resolve(null);
    }
    return this.cachePromise;
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(task, task);
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
