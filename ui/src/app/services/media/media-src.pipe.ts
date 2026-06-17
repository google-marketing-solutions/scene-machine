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

import {ChangeDetectorRef, inject, Pipe, PipeTransform} from '@angular/core';
import {MediaRef, MediaService} from './media';

/**
 * Resolves a persisted media reference (`GcsFile`-shaped object) to a `src`
 * URL: a server-signed GET URL for the path, re-signed on read so expired
 * persisted URLs never reach the DOM.
 *
 * Strings (base64 data URIs or already-resolved URLs) pass through verbatim.
 * The pipe is impure so a binding re-evaluates once the async resolution
 * lands; per-instance caching plus the MediaService URL cache keep each
 * change-detection pass cheap (no allocation, no HTTP).
 */
@Pipe({
  name: 'mediaSrc',
  pure: false,
})
export class MediaSrcPipe implements PipeTransform {
  private readonly mediaService = inject(MediaService);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  private lastKey: string | null = null;
  private resolvedUrl: string | null = null;
  // The path the cached resolvedUrl was signed for, if any. Used to notice when
  // that signed URL has aged out of MediaService's cache so a still-mounted
  // binding re-signs it instead of serving an expired URL.
  private resolvedPath: string | null = null;

  transform(value: MediaRef | string | null | undefined): string | null {
    if (!value) {
      this.reset();
      return null;
    }
    if (typeof value === 'string') {
      this.reset();
      return value;
    }
    const key = value.path || value.url || null;
    if (key === null) {
      this.reset();
      return null;
    }

    // Re-resolve when the ref changes, and also when the URL we last served was
    // signed for a path that has since expired (or is within the re-sign margin)
    // in MediaService's cache. The latter keeps a long-lived <img>/<video> bound
    // to a stable ref from holding an expired signed URL: the file's contract is
    // that URLs are re-signed on read so expired URLs never reach the DOM.
    const expired =
      this.resolvedPath !== null &&
      this.mediaService.getCachedUrl(this.resolvedPath) === undefined;
    const keyChanged = key !== this.lastKey;
    if (keyChanged || expired) {
      this.lastKey = key;
      const cached =
        (value.path && this.mediaService.getCachedUrl(value.path)) || null;
      if (cached !== null) {
        this.resolvedUrl = cached;
        this.resolvedPath = value.path || null;
      } else {
        // On a key change with no warm cache, start fresh (null) so a stale
        // URL from a previous ref is never shown for the new one. On expiry of
        // the same ref, hold the previous URL while the re-sign is in flight
        // (stale-while-revalidate) so the element is not torn down mid-resolve.
        if (keyChanged) {
          this.resolvedUrl = null;
          this.resolvedPath = null;
        }
        void this.mediaService
          .resolve(value)
          .then(url => {
            if (this.lastKey === key) {
              this.resolvedUrl = url || null;
              this.resolvedPath = url ? value.path || null : null;
              this.changeDetectorRef.markForCheck();
            }
          })
          .catch(error => {
            console.error(`Failed to resolve media URL for ${key}`, error);
            // Reset the memo so a later change-detection pass retries: a
            // transient failure (e.g. a 401 during auth bootstrap) must not
            // leave this binding permanently broken for the same key.
            if (this.lastKey === key) {
              this.lastKey = null;
              this.resolvedPath = null;
            }
          });
      }
    }
    return this.resolvedUrl;
  }

  private reset(): void {
    this.lastKey = null;
    this.resolvedPath = null;
  }
}
