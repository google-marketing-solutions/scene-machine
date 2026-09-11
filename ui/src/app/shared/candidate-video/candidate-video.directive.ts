/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import {
  Directive,
  ElementRef,
  HostListener,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  signal,
} from '@angular/core';
import {
  CandidateCacheScope,
  CandidateVideoCacheService,
} from '../../services/media/candidate-video-cache';
import {MediaRef} from '../../services/media/media';

@Directive({
  selector: 'video[appCandidateVideo]',
  standalone: true,
  exportAs: 'appCandidateVideo',
})
export class CandidateVideoDirective implements OnChanges, OnDestroy {
  @Input('appCandidateVideo') media: MediaRef | null | undefined;
  @Input() candidateVideoCacheScope: CandidateCacheScope | null | undefined;
  @Input() candidateVideoPersist = true;
  @Input() candidateVideoHover = false;

  readonly loading = signal(false);
  private readonly element = inject(ElementRef<HTMLVideoElement>);
  private readonly cache = inject(CandidateVideoCacheService);
  private lease: {url: string; release(): void} | undefined;
  private requestId = 0;
  private inputKey = '';

  ngOnChanges(): void {
    const key = JSON.stringify([
      this.media?.path,
      this.media?.url,
      this.candidateVideoCacheScope?.bucket,
      this.candidateVideoCacheScope?.projectId,
      this.candidateVideoPersist,
      this.candidateVideoHover,
    ]);
    if (key === this.inputKey) return;
    this.inputKey = key;
    this.release(true);
    if (!this.candidateVideoHover) void this.acquire();
  }

  @HostListener('mouseenter')
  onMouseEnter(): void {
    if (this.candidateVideoHover) void this.acquire();
  }

  @HostListener('mouseleave')
  onMouseLeave(): void {
    if (!this.candidateVideoHover) return;
    const video = this.element.nativeElement;
    video.pause();
    video.currentTime = 0;
    this.release(true);
    video.removeAttribute('src');
    this.loadVideo();
  }

  ngOnDestroy(): void {
    this.release();
  }

  private async acquire(): Promise<void> {
    const media = this.media;
    if (!media) return;
    const requestId = ++this.requestId;
    this.loading.set(true);
    const lease = await this.cache.acquire(
      this.candidateVideoCacheScope ?? {bucket: '', projectId: ''},
      media,
      this.candidateVideoPersist && !!this.candidateVideoCacheScope,
    );
    if (requestId !== this.requestId) {
      lease.release();
      return;
    }
    this.lease = lease;
    this.element.nativeElement.src = lease.url;
    this.loadVideo();
    this.loading.set(false);
    if (this.candidateVideoHover) {
      const video = this.element.nativeElement;
      video.muted = true;
      video.playbackRate = 2;
      try {
        const playback = video.play();
        if (playback) void playback.catch(() => undefined);
      } catch {
        // A preview may be unavailable in a browser without media playback.
      }
    }
  }

  private release(clearElement = false): void {
    this.requestId++;
    this.lease?.release();
    this.lease = undefined;
    this.loading.set(false);
    if (clearElement) {
      const video = this.element.nativeElement;
      video.pause();
      video.removeAttribute('src');
      this.loadVideo();
    }
  }

  private loadVideo(): void {
    try {
      this.element.nativeElement.load();
    } catch {
      // Loading is best-effort; the browser can still use the assigned URL.
    }
  }
}
