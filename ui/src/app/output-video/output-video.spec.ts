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
import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {vi} from 'vitest';
import {ConfigService, RenderRun} from '../services/config/config';
import {MediaService} from '../services/media/media';
import {OutputVideo} from './output-video';

describe('OutputVideo', () => {
  let component: OutputVideo;
  let fixture: ComponentFixture<OutputVideo>;
  let projectConfig: WritableSignal<TestProject>;
  let updateProjectConfig: ReturnType<typeof vi.fn>;

  interface TestProject {
    id: string;
    name: string;
    aspectRatio: string;
    resolution: string;
    renderRuns: RenderRun[];
    storyboard: never[];
  }

  const run = (minute: number, isArchived = false): RenderRun => ({
    createdAt: new Date(2026, 0, 1, 12, minute),
    wasPlayed: true,
    isArchived,
    outputVideo: {path: `output/video-${minute}.mp4`, url: ''},
  });

  const project = (id: string, renderRuns: RenderRun[]): TestProject => ({
    id,
    name: 'Test Project',
    aspectRatio: '16:9',
    resolution: '1080p',
    renderRuns,
    storyboard: [],
  });

  beforeEach(async () => {
    projectConfig = signal(project('project-1', [run(0)]));
    updateProjectConfig = vi.fn((updates: Partial<TestProject>) => {
      projectConfig.update(current => ({...current, ...updates}));
    });
    const configServiceMock = {
      projectConfig: {
        value: projectConfig,
      },
      updateProjectConfig,
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

  it('selects the first active render when project data arrives later', () => {
    projectConfig.set(project('project-2', []));
    const directRouteFixture = TestBed.createComponent(OutputVideo);
    const directRouteComponent = directRouteFixture.componentInstance;
    directRouteFixture.detectChanges();
    expect(directRouteComponent.selectedRenderRun()).toBeUndefined();

    const loaded = run(1);
    projectConfig.set(project('project-2', [loaded]));
    directRouteFixture.detectChanges();

    expect(directRouteComponent.selectedRenderRun()).toBe(loaded);
  });

  it('preserves an explicit selection across same-project updates', () => {
    const first = run(1);
    const selected = run(2);
    projectConfig.set(project('project-2', [first, selected]));
    fixture.detectChanges();
    component.selectedRenderRun.set(selected);

    const refreshedFirst = {...first};
    const refreshedSelected = {...selected};
    projectConfig.set(
      project('project-2', [refreshedFirst, refreshedSelected, run(3)]),
    );
    fixture.detectChanges();

    expect(component.selectedRenderRun()).toBe(refreshedSelected);
  });

  it('falls back to the first active run when the selected run is archived', () => {
    const selected = run(1);
    const fallback = run(2);
    projectConfig.set(project('project-2', [selected, fallback]));
    fixture.detectChanges();
    component.selectedRenderRun.set(selected);

    component.setRenderRunArchiveStatus(selected, true);
    fixture.detectChanges();

    expect(component.selectedRenderRun()?.createdAt).toEqual(
      fallback.createdAt,
    );
  });

  it('selects nothing when every render is archived', () => {
    const selected = run(1);
    projectConfig.set(project('project-2', [selected]));
    fixture.detectChanges();
    component.selectedRenderRun.set(selected);

    component.setRenderRunArchiveStatus(selected, true);
    fixture.detectChanges();

    expect(component.selectedRenderRun()).toBeUndefined();
  });

  it('falls back when the selected run is removed', () => {
    const fallback = run(1);
    const selected = run(2);
    projectConfig.set(project('project-2', [fallback, selected]));
    fixture.detectChanges();
    component.selectedRenderRun.set(selected);

    projectConfig.set(project('project-2', [fallback]));
    fixture.detectChanges();

    expect(component.selectedRenderRun()).toBe(fallback);
  });

  it('falls back when a project refresh archives the selected run', () => {
    const selected = run(1);
    const fallback = run(2);
    projectConfig.set(project('project-2', [selected, fallback]));
    fixture.detectChanges();
    component.selectedRenderRun.set(selected);

    projectConfig.set(
      project('project-2', [{...selected, isArchived: true}, fallback]),
    );
    fixture.detectChanges();

    expect(component.selectedRenderRun()).toBe(fallback);
  });

  it('does not carry a selection into another project', () => {
    const firstProjectRun = run(1);
    projectConfig.set(project('project-2', [firstProjectRun]));
    fixture.detectChanges();
    component.selectedRenderRun.set(firstProjectRun);

    const secondProjectRun = {...firstProjectRun};
    projectConfig.set(project('project-3', [secondProjectRun]));
    fixture.detectChanges();

    expect(component.selectedRenderRun()).toBe(secondProjectRun);
  });
});
