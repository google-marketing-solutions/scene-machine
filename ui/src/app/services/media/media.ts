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

import {HttpClient, HttpHeaders} from '@angular/common/http';
import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';

/**
 * A reference to a media object: a GCS path and/or a previously persisted
 * download URL. Structurally compatible with `GcsFile` (config.ts) but with
 * both fields optional so partially populated legacy objects are accepted.
 */
export interface MediaRef {
  path?: string;
  url?: string;
}

interface UploadUrlResponse {
  exists: boolean;
  path: string;
  url: string;
  uploadUrl: string | null;
  expiresAt: string;
}

interface SignUrlResponse {
  urls: Record<string, string>;
  expiresAt: string;
}

/** Re-sign this long before a cached signed URL actually expires. */
const SIGNED_URL_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Cache TTL used only when the server's expiresAt is missing or unparseable.
 * Longer than the re-sign margin (so getCachedUrl can still serve the entry) but
 * short enough to re-sign well before any real signed-URL lifetime, instead of
 * caching NaN — which would make getCachedUrl treat the entry as permanently
 * stale and re-sign on every change-detection pass (an HTTP storm). (M2)
 */
const SIGNED_URL_FALLBACK_TTL_MS = 10 * 60 * 1000;

/**
 * Mediated media access: uploads via server-issued signed PUT URLs and reads
 * via server-signed GET URLs, both minted by the app backend
 * (`/api/uploadUrl`, `/api/signUrl`).
 */
@Injectable({
  providedIn: 'root',
})
export class MediaService {
  private readonly httpClient = inject(HttpClient);

  /** path -> signed/download URL with its expiry (epoch ms). */
  private readonly urlCache = new Map<
    string,
    {url: string; expiresAt: number}
  >();
  /** path -> in-flight signUrl request, to dedupe concurrent resolutions. */
  private readonly pendingSignRequests = new Map<string, Promise<string>>();

  /**
   * Returns the cached URL for a path if present and not within the expiry
   * margin, otherwise undefined. Synchronous fast path for the mediaSrc pipe.
   */
  getCachedUrl(path: string): string | undefined {
    const cached = this.urlCache.get(path);
    if (cached && cached.expiresAt - SIGNED_URL_EXPIRY_MARGIN_MS > Date.now()) {
      return cached.url;
    }
    return undefined;
  }

  /**
   * Parses the server's ISO `expiresAt` to epoch ms, guarding a missing or
   * malformed value: `new Date(bad).getTime()` is NaN, and a NaN expiry makes
   * getCachedUrl treat the entry as permanently stale, re-signing on every
   * change-detection pass. Fall back to a short, finite TTL instead. (M2)
   */
  private parseExpiresAt(expiresAt: string | undefined): number {
    const ms = expiresAt ? new Date(expiresAt).getTime() : NaN;
    return Number.isNaN(ms) ? Date.now() + SIGNED_URL_FALLBACK_TTL_MS : ms;
  }

  /**
   * Uploads media (a File) or text content (a string) through the mediated
   * front door. The caller keeps computing the content-hash object name
   * (`<base>-<sha256>.<ext>`) so workflow payloads are stable and
   * content-addressed; the server only validates and signs.
   *
   * @param content The bytes (File) or text (string) to upload.
   * @param prefix The object prefix; must be 'remix-input' or 'thumbnail'.
   * @param fileName The final hashed file name (no slashes).
   * @return The full object path and a signed GET URL (24h).
   */
  async upload(
    content: File | string,
    prefix: string,
    fileName: string,
  ): Promise<{path: string; url: string}> {
    const contentType =
      typeof content === 'string'
        ? 'text/plain'
        : content.type || 'application/octet-stream';
    const response = await firstValueFrom(
      this.httpClient.post<UploadUrlResponse>('/api/uploadUrl', {
        path: prefix,
        fileName,
        contentType,
      }),
    );
    if (!response.exists && response.uploadUrl) {
      // Raw PUT of the bytes to the absolute signed URL. The Content-Type
      // must match the type the URL was signed for. The /api auth
      // interceptor ignores absolute URLs, so no stray headers are added.
      await firstValueFrom(
        this.httpClient.put(response.uploadUrl, content, {
          headers: new HttpHeaders({'Content-Type': contentType}),
          responseType: 'text',
        }),
      );
    }
    // ARCH2: the server returns expiresAt on /api/uploadUrl (as it does on
    // /api/signUrl), so the client no longer hard-codes the 24h TTL — the
    // signing policy stays server-side, with one source of truth.
    this.urlCache.set(response.path, {
      url: response.url,
      expiresAt: this.parseExpiresAt(response.expiresAt),
    });
    return {path: response.path, url: response.url};
  }

  /**
   * Returns a signed GET URL for a GCS path, re-using the cache until
   * `expiresAt` minus a 5-minute margin. Concurrent requests for the same
   * path share a single HTTP call.
   */
  signUrl(path: string): Promise<string> {
    const cached = this.getCachedUrl(path);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const pending = this.pendingSignRequests.get(path);
    if (pending) {
      return pending;
    }
    const request = firstValueFrom(
      this.httpClient.get<SignUrlResponse>(
        `/api/signUrl?path=${encodeURIComponent(path)}`,
      ),
    )
      .then(response => {
        const url = response.urls[path];
        if (!url) {
          throw new Error(`No signed URL returned for ${path}`);
        }
        this.urlCache.set(path, {
          url,
          expiresAt: this.parseExpiresAt(response.expiresAt),
        });
        return url;
      })
      .finally(() => {
        this.pendingSignRequests.delete(path);
      });
    this.pendingSignRequests.set(path, request);
    return request;
  }

  /**
   * Batch variant of `signUrl`: resolves signed GET URLs for many paths with
   * a single `/api/signUrl` request (the endpoint accepts repeated `path`
   * params). Paths still fresh in the cache are served from it without a
   * request; paths with an in-flight resolution join that resolution. Each
   * fetched path's promise is registered in `pendingSignRequests`, so
   * concurrent `signUrl(path)` calls dedupe against the batch instead of
   * issuing their own HTTP call.
   */
  async signUrls(paths: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const joins: Array<Promise<unknown>> = [];
    const toFetch: string[] = [];
    for (const path of new Set(paths)) {
      const cached = this.getCachedUrl(path);
      if (cached !== undefined) {
        results.set(path, cached);
        continue;
      }
      const pending = this.pendingSignRequests.get(path);
      if (pending) {
        joins.push(pending.then(url => results.set(path, url)).catch(() => {}));
        continue;
      }
      toFetch.push(path);
    }
    if (toFetch.length > 0) {
      const query = toFetch
        .map(path => `path=${encodeURIComponent(path)}`)
        .join('&');
      const batch = firstValueFrom(
        this.httpClient.get<SignUrlResponse>(`/api/signUrl?${query}`),
      ).then(response => {
        const expiresAt = this.parseExpiresAt(response.expiresAt);
        for (const path of toFetch) {
          const url = response.urls[path];
          if (url) {
            this.urlCache.set(path, {url, expiresAt});
          }
        }
        return response;
      });
      for (const path of toFetch) {
        const request = batch
          .then(response => {
            const url = response.urls[path];
            if (!url) {
              throw new Error(`No signed URL returned for ${path}`);
            }
            return url;
          })
          .finally(() => {
            this.pendingSignRequests.delete(path);
          });
        this.pendingSignRequests.set(path, request);
        // M1: tolerate a per-path omission here. A path the server leaves out of
        // the response rejects its own request (still surfaced to a direct
        // signUrl(path) via pendingSignRequests), but it must NOT reject the
        // whole batch via Promise.all and drop every successfully-signed path
        // from the returned Map. Swallow that single-path case in the
        // aggregation only.
        joins.push(request.then(url => results.set(path, url)).catch(() => {}));
      }
      // ...but a whole-batch (HTTP/transport) failure must STILL propagate, so
      // signUrls() rejects on a real request failure instead of silently
      // resolving with an empty Map. `batch` rejects only when the request
      // itself failed (not when a single path is missing), so awaiting it
      // unguarded reraises exactly that case. (M1)
      joins.push(batch.then(() => undefined));
    }
    await Promise.all(joins);
    return results;
  }

  /** Fetches an object's bytes via its signed GET URL. */
  async getBlob(path: string): Promise<Blob> {
    const url = await this.signUrl(path);
    return firstValueFrom(this.httpClient.get(url, {responseType: 'blob'}));
  }

  /**
   * Back-compat shim resolving a persisted media reference to a usable URL:
   * sign the path via /api/signUrl, falling back to the stored URL when no
   * path is present (path-less legacy refs).
   */
  async resolve(file: MediaRef | null | undefined): Promise<string> {
    if (!file) {
      return '';
    }
    if (file.path) {
      return this.signUrl(file.path);
    }
    return file.url ?? '';
  }
}
