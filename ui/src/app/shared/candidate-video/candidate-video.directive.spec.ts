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

import {Component, Input} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CandidateVideoDirective} from './candidate-video.directive';
import {CandidateVideoCacheService} from '../../services/media/candidate-video-cache';

@Component({
  standalone: true,
  imports: [CandidateVideoDirective],
  template: `<video
    [appCandidateVideo]="media"
    [candidateVideoCacheScope]="scope"
    [candidateVideoPersist]="persist"
    [candidateVideoHover]="hover"
  ></video>`,
})
class Host {
  @Input() media = {path: 'candidate.mp4'};
  @Input() scope = {bucket: 'bucket', projectId: 'project'};
  @Input() persist = true;
  @Input() hover = false;
}

describe('CandidateVideoDirective', () => {
  let fixture: ComponentFixture<Host>;
  let acquire: ReturnType<typeof vi.fn>;
  let releases: Array<ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    releases = [];
    acquire = vi.fn(async () => {
      const release = vi.fn();
      releases.push(release);
      return {url: 'blob:candidate', release};
    });
    TestBed.configureTestingModule({
      providers: [{provide: CandidateVideoCacheService, useValue: {acquire}}],
    });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('assigns the acquired URL and releases on media ref change', async () => {
    await fixture.whenStable();
    await Promise.resolve();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    expect(video.src).toContain('blob:candidate');
    expect(acquire).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('media', {path: 'other.mp4'});
    fixture.detectChanges();
    await fixture.whenStable();

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('does not attach a stale acquisition after destroy', async () => {
    let resolve!: (lease: {url: string; release(): void}) => void;
    acquire.mockClear();
    acquire.mockImplementation(
      () =>
        new Promise<{url: string; release(): void}>(next => (resolve = next)),
    );
    fixture.componentRef.setInput('media', {path: 'stale.mp4'});
    fixture.detectChanges();
    await Promise.resolve();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    const pause = vi.spyOn(video, 'pause');
    fixture.destroy();
    const release = vi.fn();
    resolve({url: 'blob:stale', release});
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalled();
  });

  it('does not reacquire when an equivalent scope object is recreated', async () => {
    await fixture.whenStable();
    const calls = acquire.mock.calls.length;
    fixture.componentRef.setInput('scope', {
      bucket: 'bucket',
      projectId: 'project',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(acquire).toHaveBeenCalledTimes(calls);
  });

  it('does not reload when a signed URL changes for the same path', async () => {
    await fixture.whenStable();
    const calls = acquire.mock.calls.length;
    fixture.componentRef.setInput('media', {
      path: 'candidate.mp4',
      url: 'https://signed.example/refreshed',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(acquire).toHaveBeenCalledTimes(calls);
  });

  it('passes non-persistent mode through for archived candidates', async () => {
    fixture.componentRef.setInput('persist', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(acquire).toHaveBeenLastCalledWith(
      {bucket: 'bucket', projectId: 'project'},
      {path: 'candidate.mp4'},
      false,
    );
  });

  it('acquires hover previews only on enter and resets on leave', async () => {
    fixture.componentRef.setInput('hover', true);
    acquire.mockClear();
    releases = [];
    fixture.detectChanges();
    expect(acquire).not.toHaveBeenCalled();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    video.dispatchEvent(new MouseEvent('mouseenter'));
    await fixture.whenStable();
    expect(acquire).toHaveBeenCalledOnce();
    video.dispatchEvent(new MouseEvent('mouseleave'));
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it('clears loading when acquisition rejects', async () => {
    acquire.mockRejectedValueOnce(new Error('malformed media URL'));
    fixture.componentRef.setInput('media', {path: 'broken.mp4'});
    fixture.detectChanges();

    await fixture.whenStable();

    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    const directive = fixture.debugElement.children[0].injector.get(
      CandidateVideoDirective,
    );
    expect(directive.loading()).toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('releases an existing lease when a hover preview is reacquired', async () => {
    fixture.componentRef.setInput('hover', true);
    acquire.mockClear();
    releases = [];
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;

    video.dispatchEvent(new MouseEvent('mouseenter'));
    await fixture.whenStable();
    video.dispatchEvent(new MouseEvent('mouseenter'));
    await fixture.whenStable();

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it('removes the video source when an acquired lease has no URL', async () => {
    await fixture.whenStable();
    const release = vi.fn();
    acquire.mockResolvedValueOnce({url: '', release});
    fixture.componentRef.setInput('media', {path: 'empty.mp4'});
    fixture.detectChanges();
    await fixture.whenStable();

    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('detaches the source before releasing a replaced lease', async () => {
    fixture.componentRef.setInput('hover', true);
    acquire.mockClear();
    releases = [];
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    video.dispatchEvent(new MouseEvent('mouseenter'));
    await fixture.whenStable();
    const removeSource = vi.spyOn(video, 'removeAttribute');

    video.dispatchEvent(new MouseEvent('mouseenter'));
    await fixture.whenStable();

    expect(removeSource.mock.invocationCallOrder[0]).toBeLessThan(
      releases[0].mock.invocationCallOrder[0],
    );
  });

  it('detaches the source before releasing its lease on teardown', async () => {
    await fixture.whenStable();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    const removeSource = vi.spyOn(video, 'removeAttribute');
    const release = releases[0];

    fixture.destroy();

    expect(removeSource.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
  });

  it('keeps loading for a newer request when an older request rejects', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (lease: {url: string; release(): void}) => void;
    acquire.mockImplementationOnce(
      () => new Promise<never>((_, reject) => (rejectFirst = reject)),
    );
    acquire.mockImplementationOnce(
      () =>
        new Promise<{url: string; release(): void}>(
          resolve => (resolveSecond = resolve),
        ),
    );
    fixture.componentRef.setInput('media', {path: 'first.mp4'});
    fixture.detectChanges();
    fixture.componentRef.setInput('media', {path: 'second.mp4'});
    fixture.detectChanges();
    const directive = fixture.debugElement.children[0].injector.get(
      CandidateVideoDirective,
    );
    expect(directive.loading()).toBe(true);

    rejectFirst(new Error('stale acquisition failed'));
    await Promise.resolve();
    expect(directive.loading()).toBe(true);

    resolveSecond({url: 'blob:second', release: vi.fn()});
    await fixture.whenStable();
    expect(directive.loading()).toBe(false);
  });
});

describe('CandidateVideoDirective with real media/cache services', () => {
  let fixture: ComponentFixture<Host>;
  let cacheEntries: Map<string, Response>;
  let createObjectUrl: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cacheEntries = new Map();
    const cache = {
      match: vi.fn(async (request: Request) => {
        const response =
          cacheEntries.get(request.url) || cacheEntries.values().next().value;
        return response?.clone();
      }),
      keys: vi.fn(async () =>
        [...cacheEntries.keys()].map(key => new Request(key)),
      ),
      delete: vi.fn(async (request: Request) =>
        cacheEntries.delete(request.url),
      ),
      put: vi.fn(async (request: Request, response: Response) => {
        cacheEntries.set(request.url, response);
      }),
    };
    vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
    createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementationOnce(() => 'blob:real-1')
      .mockImplementationOnce(() => 'blob:real-2');
    revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        CandidateVideoCacheService,
      ],
    });
    fixture = TestBed.createComponent(Host);
  });

  afterEach(() => {
    fixture.destroy();
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
    vi.unstubAllGlobals();
  });

  it('clears loading when real cache URL encoding rejects', async () => {
    fixture.componentRef.setInput('media', {path: '\ud800.mp4'});
    fixture.detectChanges();
    await fixture.whenStable();

    const directive = fixture.debugElement.children[0].injector.get(
      CandidateVideoDirective,
    );
    expect(directive.loading()).toBe(false);
  });

  it('revokes real blob leases only after source detachment on replacement and teardown', async () => {
    const makeCachedResponse = () => {
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          'content-length': '5',
          'content-type': 'video/mp4',
          'x-scene-machine-cached-at': String(Date.now()),
          'x-scene-machine-cached-size': '5',
        },
      });
    };
    const origin = globalThis.location.origin;
    cacheEntries.set(
      `${origin}/__scene_machine_candidate_video_cache__/v1/bucket/project/candidate.mp4`,
      makeCachedResponse(),
    );
    cacheEntries.set(
      `${origin}/__scene_machine_candidate_video_cache__/v1/bucket/project/other.mp4`,
      makeCachedResponse(),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('video').src).toContain(
        'blob:real-1',
      ),
    );

    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    const removeSource = vi.spyOn(video, 'removeAttribute');
    const load = vi.spyOn(video, 'load');
    fixture.componentRef.setInput('media', {path: 'other.mp4'});
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(video.getAttribute('src')).toBe('blob:real-2'),
    );
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(removeSource.mock.invocationCallOrder[0]).toBeLessThan(
      revokeObjectUrl.mock.invocationCallOrder[0],
    );
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(
      revokeObjectUrl.mock.invocationCallOrder[0],
    );

    fixture.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    expect(removeSource.mock.invocationCallOrder[1]).toBeLessThan(
      revokeObjectUrl.mock.invocationCallOrder[1],
    );
  });
});
