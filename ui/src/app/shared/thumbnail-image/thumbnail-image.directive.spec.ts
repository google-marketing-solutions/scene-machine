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

import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ThumbnailCacheService} from '../../services/media/thumbnail-cache';
import {ThumbnailImageDirective} from './thumbnail-image.directive';

@Component({
  template: `
    <div #container>
      <img
        [appThumbnailImage]="media"
        [thumbnailCacheScope]="scope"
        [thumbnailImagePersist]="persist"
        [thumbnailImageContainer]="container"
      />
    </div>
  `,
  imports: [ThumbnailImageDirective],
})
class Host {
  media: {path: string} | undefined = {path: 'thumbnail-a.jpg'};
  scope = {bucket: 'bucket-a', projectId: 'project-a'};
  persist = true;
}

interface ObserverState {
  callback: IntersectionObserverCallback;
  rootMargin: string;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}

describe('ThumbnailImageDirective', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let directive: ThumbnailImageDirective;
  let acquire: ReturnType<typeof vi.fn>;
  let observers: ObserverState[];

  beforeEach(async () => {
    observers = [];
    class FakeIntersectionObserver {
      readonly rootMargin = '200px';
      readonly callback: IntersectionObserverCallback;
      readonly disconnect = vi.fn();
      readonly observe = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    acquire = vi.fn();
    acquire.mockResolvedValue({url: 'blob:default', release: vi.fn()});
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [{provide: ThumbnailCacheService, useValue: {acquire}}],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
    directive = fixture.debugElement
      .query(By.directive(ThumbnailImageDirective))
      .injector.get(ThumbnailImageDirective);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function intersect(index: number): void {
    observers[index].callback(
      [{isIntersecting: true} as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  }

  it('waits for the image to approach the viewport and uses the 200px margin', () => {
    expect(observers).toHaveLength(1);
    expect(observers[0].rootMargin).toBe('200px');
    expect(observers[0].observe).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();

    intersect(0);
    expect(acquire).toHaveBeenCalledWith(host.scope, host.media, true);
  });

  it('recovers a same-identity thumbnail after a transient acquisition failure', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    acquire
      .mockRejectedValueOnce(new Error('signing unavailable'))
      .mockResolvedValueOnce({url: 'blob:recovered', release});

    intersect(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(image.src).toContain('blob:recovered');
  });

  it('treats an empty lease as a recoverable acquisition failure', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    acquire
      .mockResolvedValueOnce({url: '', release})
      .mockResolvedValueOnce({url: 'blob:recovered', release});

    intersect(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(image.src).toContain('blob:recovered');
  });

  it('cancels recovery when the media identity changes', async () => {
    vi.useFakeTimers();
    acquire.mockRejectedValueOnce(new Error('signing unavailable'));

    intersect(0);
    await vi.advanceTimersByTimeAsync(0);
    directive.media = {path: 'thumbnail-b.jpg'};
    directive.ngOnChanges();
    await vi.advanceTimersByTimeAsync(5000);

    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('cancels recovery when the directive is destroyed', async () => {
    vi.useFakeTimers();
    acquire.mockRejectedValueOnce(new Error('signing unavailable'));

    intersect(0);
    await vi.advanceTimersByTimeAsync(0);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(5000);

    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('bounds recovery attempts when acquisition remains unavailable', async () => {
    vi.useFakeTimers();
    acquire.mockRejectedValue(new Error('signing unavailable'));

    intersect(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250 + 1000 + 4000 + 5000);

    expect(acquire).toHaveBeenCalledTimes(4);
  });

  it('does not let an earlier media result replace a newer media result', async () => {
    let resolveA!: (lease: {url: string; release(): void}) => void;
    let resolveB!: (lease: {url: string; release(): void}) => void;
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    acquire
      .mockReturnValueOnce(new Promise(resolve => (resolveA = resolve)))
      .mockReturnValueOnce(new Promise(resolve => (resolveB = resolve)));

    intersect(0);
    directive.media = {path: 'thumbnail-b.jpg'};
    directive.ngOnChanges();
    intersect(1);
    resolveA({url: 'blob:a', release: releaseA});
    await Promise.resolve();
    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    expect(image.src).not.toContain('blob:a');
    expect(releaseA).toHaveBeenCalledTimes(1);

    resolveB({url: 'blob:b', release: releaseB});
    await Promise.resolve();
    expect(image.src).toContain('blob:b');
  });

  it('releases the active lease and clears loaded state on media change and destroy', async () => {
    const release = vi.fn();
    acquire.mockResolvedValue({url: 'blob:a', release});
    intersect(0);
    await Promise.resolve();
    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    image.dispatchEvent(new Event('load'));
    expect(image.classList.contains('loaded')).toBe(true);
    expect(
      fixture.nativeElement
        .querySelector('div')
        .classList.contains('high-res-loaded'),
    ).toBe(true);

    directive.media = {path: 'thumbnail-b.jpg'};
    directive.ngOnChanges();
    expect(release).toHaveBeenCalledTimes(1);
    expect(image.getAttribute('src')).toBeNull();
    expect(image.classList.contains('loaded')).toBe(false);

    fixture.destroy();
    expect(observers[1].disconnect).toHaveBeenCalled();
  });

  it('marks a loaded relative URL without comparing against the raw lease URL', async () => {
    const release = vi.fn();
    acquire.mockReset();
    acquire.mockResolvedValue({url: 'relative-thumbnail.jpg', release});
    intersect(0);
    await Promise.resolve();
    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    Object.defineProperty(image, 'complete', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(image, 'naturalWidth', {
      configurable: true,
      value: 1,
    });
    image.dispatchEvent(new Event('load'));
    expect(image.classList.contains('loaded')).toBe(true);
  });

  it('does not persist archived thumbnails', () => {
    host.persist = false;
    directive.thumbnailImagePersist = false;
    directive.ngOnChanges();
    intersect(1);
    expect(acquire).toHaveBeenCalledWith(host.scope, host.media, false);
  });

  it('keeps an equivalent reference stable and ignores a queued old observer callback', () => {
    const oldObserver = observers[0];
    directive.media = {path: 'thumbnail-a.jpg'};
    directive.ngOnChanges();
    expect(observers).toHaveLength(1);
    expect(oldObserver.disconnect).not.toHaveBeenCalled();

    directive.media = {path: 'thumbnail-b.jpg'};
    directive.ngOnChanges();
    oldObserver.callback(
      [{isIntersecting: true} as IntersectionObserverEntry],
      oldObserver as unknown as IntersectionObserver,
    );
    expect(acquire).not.toHaveBeenCalled();
  });
});
