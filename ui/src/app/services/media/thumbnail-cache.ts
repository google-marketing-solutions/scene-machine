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
import {
  MediaCacheEngine,
  MediaCacheLease,
  MediaCacheScope,
} from './media-cache-engine';
import {MediaRef, MediaService} from './media';

export type ThumbnailCacheScope = MediaCacheScope;
export type ThumbnailLease = MediaCacheLease;

const CACHE_NAME = 'scene-machine-thumbnails-v1';
const CACHE_PATH = '/__scene_machine_thumbnail_cache__/v1/';
const MAX_ENTRY_BYTES = 1 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const MAX_SIGN_URLS_BATCH_SIZE = 100;

@Injectable({providedIn: 'root'})
export class ThumbnailCacheService {
  private readonly mediaService = inject(MediaService);
  private pendingResolutions: Array<{
    file: MediaRef;
    resolve: (url: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  private resolutionFlushScheduled = false;
  private readonly engine = new MediaCacheEngine(
    file => this.resolveAfterCacheMiss(file),
    {
      cacheName: CACHE_NAME,
      cachePath: CACHE_PATH,
      entryLabel: 'Thumbnail',
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxEntries: MAX_ENTRIES,
    },
  );

  acquire(
    scope: ThumbnailCacheScope,
    file: MediaRef | null | undefined,
    persist = true,
  ): Promise<ThumbnailLease> {
    return this.engine.acquire(scope, file, persist);
  }

  invalidateCandidate(projectId: string, path: string): Promise<void> {
    return this.engine.invalidateCandidate(projectId, path);
  }

  invalidateProject(projectId: string): Promise<void> {
    return this.engine.invalidateProject(projectId);
  }

  /**
   * Resolve only cache misses, batching concurrent thumbnail paths into the
   * existing signUrls request. Pathless legacy references still use resolve.
   */
  private resolveAfterCacheMiss(
    file: MediaRef | null | undefined,
  ): Promise<string> {
    if (!file?.path) return this.mediaService.resolve(file);

    return new Promise<string>((resolve, reject) => {
      this.pendingResolutions.push({file, resolve, reject});
      if (this.resolutionFlushScheduled) return;
      this.resolutionFlushScheduled = true;
      setTimeout(() => {
        void this.flushResolutions();
      }, 10);
    });
  }

  private async flushResolutions(): Promise<void> {
    this.resolutionFlushScheduled = false;
    const requests = this.pendingResolutions.splice(0);
    if (requests.length === 0) return;

    const paths = [...new Set(requests.map(request => request.file.path!))];
    const requestsByPath = new Map<string, typeof requests>();
    for (const request of requests) {
      const path = request.file.path!;
      const pathRequests = requestsByPath.get(path) || [];
      pathRequests.push(request);
      requestsByPath.set(path, pathRequests);
    }

    for (
      let offset = 0;
      offset < paths.length;
      offset += MAX_SIGN_URLS_BATCH_SIZE
    ) {
      const batchPaths = paths.slice(offset, offset + MAX_SIGN_URLS_BATCH_SIZE);
      let urls: Map<string, string>;
      try {
        urls = await this.mediaService.signUrls(batchPaths);
      } catch (error) {
        for (const path of batchPaths) {
          for (const request of requestsByPath.get(path) || []) {
            request.reject(error);
          }
        }
        continue;
      }
      for (const path of batchPaths) {
        const pathRequests = requestsByPath.get(path) || [];
        const url = urls.get(path);
        if (url) {
          pathRequests.forEach(request => request.resolve(url));
        } else {
          pathRequests.forEach(request =>
            request.reject(new Error(`No signed URL returned for ${path}`)),
          );
        }
      }
    }
  }
}
