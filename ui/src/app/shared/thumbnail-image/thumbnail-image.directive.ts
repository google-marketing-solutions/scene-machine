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

import {
  Directive,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  inject,
} from '@angular/core';
import {
  CandidateCacheScope,
  CandidateVideoLease,
} from '../../services/media/candidate-video-cache';
import {ThumbnailCacheService} from '../../services/media/thumbnail-cache';
import {MediaRef} from '../../services/media/media';

const THUMBNAIL_RECOVERY_DELAYS_MS = [250, 1000, 4000] as const;

/**
 * Loads a thumbnail only when its image is near the viewport, while allowing
 * the cache service to persist the downloaded bytes and share its lease.
 */
@Directive({
  selector: 'img[appThumbnailImage]',
  host: {'(load)': 'onLoad()'},
})
export class ThumbnailImageDirective implements OnChanges, OnDestroy {
  @Input('appThumbnailImage') media: MediaRef | null | undefined;
  @Input() thumbnailCacheScope: CandidateCacheScope | null | undefined;
  @Input() thumbnailImagePersist = true;
  @Input() thumbnailImageContainer: HTMLElement | null | undefined;

  private readonly element = inject(ElementRef<HTMLImageElement>);
  private readonly cache = inject(ThumbnailCacheService);
  private lease: CandidateVideoLease | undefined;
  private observer: IntersectionObserver | undefined;
  private requestId = 0;
  private inputKey = '';
  private mediaKey = '';
  private scopeKey = '';
  private assignedSrc = '';
  private disposed = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryAttempt = 0;

  ngOnChanges(): void {
    const key = JSON.stringify([
      this.media?.path || this.media?.url,
      this.thumbnailCacheScope?.bucket,
      this.thumbnailCacheScope?.projectId,
      this.thumbnailImagePersist,
    ]);
    if (key === this.inputKey) return;
    const mediaKey = JSON.stringify(this.media?.path || this.media?.url);
    const scopeOnlyChange =
      mediaKey === this.mediaKey &&
      this.scopeKey === '' &&
      !!this.thumbnailCacheScope &&
      !!this.lease;
    this.inputKey = key;
    this.mediaKey = mediaKey;
    this.scopeKey = this.thumbnailCacheScope
      ? JSON.stringify([
          this.thumbnailCacheScope.bucket,
          this.thumbnailCacheScope.projectId,
        ])
      : '';
    this.stopObserving();
    this.cancelRecovery();
    this.recoveryAttempt = 0;
    if (scopeOnlyChange) {
      const requestId = ++this.requestId;
      void this.acquire(requestId);
      return;
    }
    this.release(true);
    if (!this.media) return;
    this.observeOrAcquire();
  }

  ngOnDestroy(): void {
    this.disposed = true;
    this.stopObserving();
    this.cancelRecovery();
    this.release(true);
  }

  onLoad(): void {
    const image = this.element.nativeElement;
    const currentSrc = image.currentSrc || image.src;
    if (
      !this.lease ||
      !image.getAttribute('src') ||
      image.naturalWidth <= 0 ||
      currentSrc !== this.assignedSrc
    ) {
      return;
    }
    image.classList.add('loaded');
    this.thumbnailImageContainer?.classList.add('high-res-loaded');
  }

  private observeOrAcquire(): void {
    const requestId = this.requestId;
    if (typeof IntersectionObserver === 'undefined') {
      void this.acquire(requestId);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (
          this.disposed ||
          this.observer !== observer ||
          requestId !== this.requestId
        ) {
          return;
        }
        if (!entries.some(entry => entry.isIntersecting)) return;
        this.stopObserving();
        void this.acquire(requestId);
      },
      {rootMargin: '200px'},
    );
    this.observer = observer;
    observer.observe(this.element.nativeElement);
  }

  private async acquire(requestId: number): Promise<void> {
    const media = this.media;
    if (!media || this.disposed) return;
    let lease: CandidateVideoLease | undefined;
    try {
      lease = await this.cache.acquire(
        this.thumbnailCacheScope ?? {bucket: '', projectId: ''},
        media,
        this.thumbnailImagePersist && !!this.thumbnailCacheScope,
      );
      if (this.disposed || requestId !== this.requestId) {
        lease?.release();
        return;
      }
      if (!lease?.url) {
        lease?.release();
        this.scheduleRecovery(requestId);
        return;
      }
      const image = this.element.nativeElement;
      image.decoding = 'async';
      image.src = lease.url;
      const assignedSrc = image.src;
      const previousLease = this.lease;
      this.lease = lease;
      this.assignedSrc = assignedSrc;
      this.recoveryAttempt = 0;
      previousLease?.release();
    } catch {
      if (lease) {
        if (!this.disposed && requestId === this.requestId) {
          // Restore the still-owned image before releasing a failed assignment.
          const image = this.element.nativeElement;
          if (this.assignedSrc) image.setAttribute('src', this.assignedSrc);
          else image.removeAttribute('src');
        }
        lease.release();
      }
      if (this.disposed || requestId !== this.requestId) return;
      this.scheduleRecovery(requestId);
    }
  }

  private scheduleRecovery(requestId: number): void {
    if (
      this.disposed ||
      requestId !== this.requestId ||
      this.recoveryTimer !== undefined ||
      this.recoveryAttempt >= THUMBNAIL_RECOVERY_DELAYS_MS.length
    ) {
      return;
    }
    const delay = THUMBNAIL_RECOVERY_DELAYS_MS[this.recoveryAttempt++];
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.disposed || requestId !== this.requestId) return;
      void this.acquire(requestId);
    }, delay);
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer === undefined) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private release(clearElement: boolean): void {
    this.requestId++;
    this.lease?.release();
    this.lease = undefined;
    if (!clearElement) return;
    const image = this.element.nativeElement;
    image.removeAttribute('src');
    this.assignedSrc = '';
    image.classList.remove('loaded');
    this.thumbnailImageContainer?.classList.remove('high-res-loaded');
  }

  private stopObserving(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
