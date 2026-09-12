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
  HostListener,
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

/**
 * Loads a thumbnail only when its image is near the viewport, while allowing
 * the cache service to persist the downloaded bytes and share its lease.
 */
@Directive({
  selector: 'img[appThumbnailImage]',
  standalone: true,
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
  private assignedSrc = '';
  private disposed = false;

  ngOnChanges(): void {
    const key = JSON.stringify([
      this.media?.path || this.media?.url,
      this.thumbnailCacheScope?.bucket,
      this.thumbnailCacheScope?.projectId,
      this.thumbnailImagePersist,
    ]);
    if (key === this.inputKey) return;
    this.inputKey = key;
    this.stopObserving();
    this.release(true);
    if (!this.media) return;
    this.observeOrAcquire();
  }

  ngOnDestroy(): void {
    this.disposed = true;
    this.stopObserving();
    this.release(true);
  }

  @HostListener('load')
  onLoad(): void {
    const image = this.element.nativeElement;
    const currentSrc = image.currentSrc || image.src;
    if (
      !this.lease ||
      !image.getAttribute('src') ||
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
    const lease = await this.cache.acquire(
      this.thumbnailCacheScope ?? {bucket: '', projectId: ''},
      media,
      this.thumbnailImagePersist && !!this.thumbnailCacheScope,
    );
    if (this.disposed || requestId !== this.requestId) {
      lease.release();
      return;
    }
    this.lease = lease;
    this.element.nativeElement.decoding = 'async';
    this.element.nativeElement.src = lease.url;
    this.assignedSrc = this.element.nativeElement.src;
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
