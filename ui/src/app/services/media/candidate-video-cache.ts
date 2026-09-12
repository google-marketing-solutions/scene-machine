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

export type CandidateCacheScope = MediaCacheScope;
export type CandidateVideoLease = MediaCacheLease;

const CACHE_NAME = 'scene-machine-candidate-videos-v1';
const CACHE_PATH = '/__scene_machine_candidate_video_cache__/v1/';
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 64;

@Injectable({providedIn: 'root'})
export class CandidateVideoCacheService {
  private readonly mediaService = inject(MediaService);
  private readonly engine = new MediaCacheEngine(
    file => this.mediaService.resolve(file),
    {
      cacheName: CACHE_NAME,
      cachePath: CACHE_PATH,
      entryLabel: 'Candidate video',
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxEntries: MAX_ENTRIES,
    },
  );

  acquire(
    scope: CandidateCacheScope,
    file: MediaRef | null | undefined,
    persist: boolean,
  ): Promise<CandidateVideoLease> {
    return this.engine.acquire(scope, file, persist);
  }

  invalidateCandidate(projectId: string, path: string): Promise<void> {
    return this.engine.invalidateCandidate(projectId, path);
  }

  invalidateProject(projectId: string): Promise<void> {
    return this.engine.invalidateProject(projectId);
  }
}
