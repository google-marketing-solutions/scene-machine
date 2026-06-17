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

import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {vi} from 'vitest';
import {ConfigService} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {OutputVideo} from './output-video';

describe('OutputVideo', () => {
  let component: OutputVideo;
  let fixture: ComponentFixture<OutputVideo>;

  beforeEach(async () => {
    const configServiceMock = {
      projectConfig: {
        value: () => ({
          title: 'Test Project',
          outputVideoUrl: 'http://test.com/video.mp4',
          aspectRatio: '16:9',
          renderRuns: [
            {
              createdAt: 1,
              wasPlayed: true,
              isArchived: false,
              outputVideo: {path: 'output/video.mp4'},
            },
          ],
          storyboard: [],
        }),
      },
      updateProjectConfig: vi.fn(),
      isGeneratedScene: () => false,
    };

    // The output template binds the video src through the (impure) mediaSrc
    // pipe, which calls MediaService.getCachedUrl(); returning a URL keeps the
    // binding synchronous so the rendered <video> reflects the template
    // attributes in this pass.
    const mediaServiceMock = {
      getCachedUrl: vi.fn().mockReturnValue('http://test.com/video.mp4'),
      resolve: vi.fn().mockResolvedValue('http://test.com/video.mp4'),
    };

    await TestBed.configureTestingModule({
      imports: [OutputVideo],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: ConfigService, useValue: configServiceMock},
        {provide: MediaService, useValue: mediaServiceMock},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OutputVideo);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the output video without autoplay (opening the output tab must not auto-play)', () => {
    const video: HTMLVideoElement | null =
      fixture.nativeElement.querySelector('video');
    // Guard: the assertion below is only meaningful if the <video> actually
    // rendered (i.e. videoFile() resolved truthy).
    expect(video).not.toBeNull();
    expect(video!.hasAttribute('autoplay')).toBe(false);
    expect(video!.autoplay).toBe(false);
    // The deliberate product change removes only autoplay — controls and
    // playsinline must stay.
    expect(video!.hasAttribute('controls')).toBe(true);
    expect(video!.hasAttribute('playsinline')).toBe(true);
  });
});
