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

import {ChangeDetectorRef} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {MediaService} from './media';
import {MediaSrcPipe} from './media-src.pipe';

describe('MediaSrcPipe', () => {
  let mockMediaService: {
    getCachedUrl: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
  };
  let pipe: MediaSrcPipe;

  function makePipe(): MediaSrcPipe {
    // ChangeDetectorRef has no real view here; markForCheck must be a no-op.
    return TestBed.runInInjectionContext(() => {
      const created = new MediaSrcPipe();
      // The pipe injected the test ChangeDetectorRef provider; nothing to do.
      return created;
    });
  }

  beforeEach(() => {
    mockMediaService = {
      getCachedUrl: vi.fn().mockReturnValue(undefined),
      resolve: vi.fn().mockResolvedValue(''),
    };
    TestBed.configureTestingModule({
      providers: [
        {provide: MediaService, useValue: mockMediaService},
        {provide: ChangeDetectorRef, useValue: {markForCheck: vi.fn()}},
      ],
    });
    pipe = makePipe();
  });

  it('passes a string value through verbatim', () => {
    expect(pipe.transform('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(mockMediaService.resolve).not.toHaveBeenCalled();
  });

  it('returns null for an empty/path-less ref', () => {
    expect(pipe.transform(null)).toBeNull();
    expect(pipe.transform({})).toBeNull();
  });

  it('serves a warm cached signed URL synchronously without resolving', () => {
    mockMediaService.getCachedUrl.mockReturnValue('https://signed/now');
    expect(pipe.transform({path: 'media/a.mp4'})).toBe('https://signed/now');
    expect(mockMediaService.resolve).not.toHaveBeenCalled();
  });

  it('resolves once for a stable ref and reuses the result while it stays fresh', async () => {
    // Cold cache first, so the pipe falls back to resolve().
    mockMediaService.getCachedUrl.mockReturnValue(undefined);
    mockMediaService.resolve.mockResolvedValue('https://signed/v1');

    const ref = {path: 'media/a.mp4'};
    expect(pipe.transform(ref)).toBeNull(); // async resolve in flight
    await vi.waitFor(() =>
      expect(pipe.transform(ref)).toBe('https://signed/v1'),
    );

    // Once resolved, the service reports the URL as warm in cache; further
    // passes must not re-resolve.
    mockMediaService.getCachedUrl.mockReturnValue('https://signed/v1');
    mockMediaService.resolve.mockClear();
    expect(pipe.transform(ref)).toBe('https://signed/v1');
    expect(pipe.transform(ref)).toBe('https://signed/v1');
    expect(mockMediaService.resolve).not.toHaveBeenCalled();
  });

  it('re-resolves the same ref once its signed URL ages out of the cache', async () => {
    // First pass: warm cache, no resolve needed.
    mockMediaService.getCachedUrl.mockReturnValue('https://signed/v1');
    const ref = {path: 'media/a.mp4'};
    expect(pipe.transform(ref)).toBe('https://signed/v1');
    expect(mockMediaService.resolve).not.toHaveBeenCalled();

    // The signed URL expires: MediaService.getCachedUrl now reports it stale.
    mockMediaService.getCachedUrl.mockReturnValue(undefined);
    mockMediaService.resolve.mockResolvedValue('https://signed/v2');

    // The next CD pass must re-resolve. Stale-while-revalidate: the previous
    // URL is held until the fresh one lands (never blanks to null).
    expect(pipe.transform(ref)).toBe('https://signed/v1');
    expect(mockMediaService.resolve).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(pipe.transform(ref)).toBe('https://signed/v2'),
    );
  });

  it('does not re-resolve a stable ref while its URL is still fresh', () => {
    mockMediaService.getCachedUrl.mockReturnValue('https://signed/v1');
    const ref = {path: 'media/a.mp4'};
    pipe.transform(ref);
    pipe.transform(ref);
    pipe.transform(ref);
    expect(mockMediaService.resolve).not.toHaveBeenCalled();
  });
});
