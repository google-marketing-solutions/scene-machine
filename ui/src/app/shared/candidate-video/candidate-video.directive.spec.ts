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
});
