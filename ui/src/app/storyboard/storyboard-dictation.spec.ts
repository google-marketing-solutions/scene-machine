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
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {MAT_DIALOG_DATA, MatDialogRef} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Component, EventEmitter, Input, Output, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideRouter} from '@angular/router';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Candidate,
  ConfigService,
  GeneratedScene,
  ProjectConfig,
} from '../services/config/config';
import {ClientMediaService} from '../services/client-media/client-media';
import {ImageImportService} from '../services/image-import/image-import';
import {MediaService} from '../services/media/media';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import type {
  SupplyNodeResponse,
  WorkflowStatusResponse,
} from '../services/remix-engine/remix-engine.interface';
import {DictationControl} from '../shared/dictation/dictation-control';
import {DictationConfig, DictationService} from '../shared/dictation/dictation';
import {Storyboard} from './storyboard';
import {EditCandidateDialog} from './edit-candidate-dialog';

@Component({
  selector: 'app-dictation-control',
  standalone: true,
  template: '',
})
class DictationControlStub {
  @Input() enabled = false;
  @Input() audioConfig: unknown;
  @Input() value = '';
  @Input() textarea: HTMLTextAreaElement | undefined;
  @Input() revision = 0;
  @Input() ownerKey = '';
  @Output() valueChange = new EventEmitter<string>();
}

class RecordingTrack {
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class RecordingMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly stream: unknown,
    readonly options?: {mimeType?: string},
  ) {}

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['spoken prompt'], {type: 'audio/webm'}),
    });
    queueMicrotask(() => this.onstop?.());
  }
}

describe('Storyboard dictation parent binding', () => {
  let fixture: ComponentFixture<Storyboard>;
  let project: ReturnType<typeof signal<ProjectConfig>>;

  beforeEach(async () => {
    const candidate: Candidate = {
      runNumber: 1,
      durationSeconds: 4,
      video: {
        path: 'videos/scene-1.mp4',
        url: 'https://example.test/scene-1.mp4',
      },
      model: 'veo',
      prompt: 'old prompt',
      generateAudio: true,
      resolution: '720p',
    };
    const secondCandidate: Candidate = {
      ...candidate,
      runNumber: 2,
      video: {
        path: 'videos/scene-1b.mp4',
        url: 'https://example.test/scene-1b.mp4',
      },
    };
    const scene: GeneratedScene = {
      id: 'scene-1',
      name: 'Scene 1',
      type: 'generated',
      prompt: 'old prompt',
      candidates: [candidate, secondCandidate],
      selectedCandidateIndex: 0,
    };
    project = signal<ProjectConfig>({
      id: 'project-1',
      name: 'Test',
      storyboard: [scene],
      aspectRatio: '16:9',
      resolution: '720p',
      candidateDurationSeconds: 4,
      generateAudio: true,
      numberOfCandidates: 1,
      model: 'veo',
      inputConfig: {products: [], composition: ''},
      audioTracks: [],
      visualOverlays: [],
    });
    const updateProjectConfig = vi.fn((partial: Partial<ProjectConfig>) =>
      project.update(value => ({...value, ...partial})),
    );
    const remixEngine = {
      generatingSceneIds: signal(new Set<string>()),
      editingSceneIds: signal(new Set<string>()),
    };
    const config = {
      projectConfig: {value: project, isLoading: signal(false)},
      projectLoadError: signal(false),
      reloadProjectConfig: vi.fn(),
      globalConfig: {value: () => ({dictation: {enabled: true}})},
      updateProjectConfig,
      isGeneratedScene: (value: unknown) =>
        !!value && (value as {type?: string}).type === 'generated',
      isProvidedVideoScene: () => false,
      canEditCandidates: () => true,
      audioLocked: () => false,
      durationSlider: () => ({min: 1, max: 8, step: 1}),
      videoModels: () => ['veo'],
      selectVideoModel: vi.fn(),
      sceneIdCounter: () => 2,
      primaryColor: () => 0,
    };
    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        {provide: ConfigService, useValue: config},
        {provide: ClientMediaService, useValue: {}},
        {provide: ImageImportService, useValue: {}},
        {
          provide: MediaService,
          useValue: {
            getCachedUrl: vi.fn(
              (path: string) => `https://example.test/${path}`,
            ),
            resolve: vi.fn((file: {url: string}) => Promise.resolve(file.url)),
            signUrls: vi
              .fn()
              .mockImplementation(
                async (paths: string[]) =>
                  new Map(
                    paths.map(path => [path, `https://example.test/${path}`]),
                  ),
              ),
          },
        },
        {provide: RemixEngineService, useValue: remixEngine},
      ],
    });
    TestBed.overrideComponent(Storyboard, {
      remove: {imports: [DictationControl]},
      add: {imports: [DictationControlStub]},
    });
    fixture = TestBed.createComponent(Storyboard);
    fixture.detectChanges();
  });

  it('binds scene prompt dictation to the scene owner identity', () => {
    const control = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    expect(control.ownerKey).toBe('project-1:scene:scene-1');
    expect(control.textarea?.tagName).toBe('TEXTAREA');
    control.valueChange.emit('spoken prompt');
    expect(project().storyboard[0]).toMatchObject({prompt: 'spoken prompt'});
  });

  it('keeps the scene owner stable when selecting a same-prompt candidate', () => {
    const component = fixture.componentInstance;
    const scene = project().storyboard[0] as GeneratedScene;
    const control = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    expect(control.textarea?.tagName).toBe('TEXTAREA');
    expect(scene.prompt).toBe('old prompt');
    expect(control.ownerKey).toBe('project-1:scene:scene-1');
    component.selectCandidate(scene, 1);
    fixture.detectChanges();
    expect(scene.prompt).toBe('old prompt');
    expect(project().storyboard[0]).toMatchObject({selectedCandidateIndex: 1});
    const updatedControl = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    expect(updatedControl.ownerKey).toBe('project-1:scene:scene-1');
  });
});

describe('Storyboard dictation with the real control', () => {
  let fixture: ComponentFixture<Storyboard>;
  let component: Storyboard;
  let project: ReturnType<typeof signal<ProjectConfig>>;
  let http: HttpTestingController;
  let track: RecordingTrack;

  beforeEach(async () => {
    track = new RecordingTrack();
    RecordingMediaRecorder.isTypeSupported.mockReturnValue(true);
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [track],
    });
    vi.stubGlobal('MediaRecorder', RecordingMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {getUserMedia},
    });

    const candidate = {
      runNumber: 1,
      durationSeconds: 4,
      video: {
        path: 'videos/scene-1.mp4',
        url: 'https://example.test/scene-1.mp4',
      },
      model: 'veo',
      prompt: 'same prompt',
      generateAudio: true,
      resolution: '720p' as const,
    };
    const secondCandidate = {
      ...candidate,
      runNumber: 2,
      video: {
        path: 'videos/scene-1b.mp4',
        url: 'https://example.test/scene-1b.mp4',
      },
    };
    const scene: GeneratedScene = {
      id: 'scene-1',
      name: 'Scene 1',
      type: 'generated',
      prompt: 'same prompt',
      candidates: [candidate, secondCandidate],
      selectedCandidateIndex: 0,
    };
    project = signal<ProjectConfig>({
      id: 'project-1',
      name: 'Test',
      storyboard: [scene],
      aspectRatio: '16:9',
      resolution: '720p',
      candidateDurationSeconds: 4,
      generateAudio: true,
      numberOfCandidates: 1,
      model: 'veo',
      inputConfig: {products: [], composition: ''},
      audioTracks: [],
      visualOverlays: [],
    });
    const dictation: DictationConfig = {
      enabled: true,
      maxAudioBytes: 4 * 1024 * 1024,
      maxDurationSeconds: 120,
      mimeTypes: ['audio/webm;codecs=opus'],
    };
    const config = {
      projectConfig: {value: project, isLoading: signal(false)},
      projectLoadError: signal(false),
      reloadProjectConfig: vi.fn(),
      globalConfig: {value: () => ({dictation})},
      updateProjectConfig: (partial: Partial<ProjectConfig>) =>
        project.update(value => ({...value, ...partial})),
      flushPendingSave: vi.fn(),
      isGeneratedScene: (value: unknown) =>
        !!value && (value as {type?: string}).type === 'generated',
      isProvidedVideoScene: () => false,
      canEditCandidates: () => true,
      audioLocked: () => false,
      resolveVideoLocation: () => 'us-central1',
      durationSlider: () => ({min: 1, max: 8, step: 1}),
      videoModels: () => ['veo'],
      selectVideoModel: vi.fn(),
      sceneIdCounter: () => 2,
      primaryColor: () => 0,
    };
    await TestBed.configureTestingModule({
      imports: [Storyboard],
      providers: [
        DictationService,
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: ConfigService, useValue: config},
        {
          provide: ClientMediaService,
          useValue: {
            generateLowQualityThumbnail: vi.fn().mockResolvedValue(new Blob()),
            generateHighQualityThumbnail: vi.fn().mockResolvedValue(new Blob()),
            toBase64: vi.fn().mockResolvedValue('thumbnail'),
            toFile: vi.fn().mockResolvedValue(new File([], 'thumbnail')),
          },
        },
        {provide: ImageImportService, useValue: {}},
        {
          provide: MediaService,
          useValue: {
            getCachedUrl: vi.fn(
              (path: string) => `https://example.test/${path}`,
            ),
            resolve: vi.fn((file: {url: string}) => Promise.resolve(file.url)),
            signUrl: vi
              .fn()
              .mockImplementation((path: string) =>
                Promise.resolve(`https://example.test/${path}`),
              ),
            signUrls: vi
              .fn()
              .mockImplementation(
                async (paths: string[]) =>
                  new Map(
                    paths.map(path => [path, `https://example.test/${path}`]),
                  ),
              ),
          },
        },
        RemixEngineService,
        {provide: MatSnackBar, useValue: {open: vi.fn()}},
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Storyboard);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.unstubAllGlobals();
  });

  async function startRecording(): Promise<DictationControl> {
    const control = fixture.debugElement.query(By.directive(DictationControl))
      .componentInstance as DictationControl;
    control.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRecording()).toBe(true);
    return control;
  }

  it('keeps recording and inserts into the scene prompt when same-prompt candidate selection changes', async () => {
    const control = await startRecording();
    const scene = project().storyboard[0] as GeneratedScene;

    component.selectCandidate(scene, 1);
    fixture.detectChanges();

    expect(control.isRecording()).toBe(true);
    expect(track.stopped).toBe(false);

    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');
    request.flush({text: 'spoken words'});
    fixture.detectChanges();

    expect((project().storyboard[0] as GeneratedScene).prompt).toBe(
      'same prompt\nspoken words',
    );
  });

  it('delivers pending same-prompt dictation to the selected second scene', async () => {
    const firstScene = project().storyboard[0] as GeneratedScene;
    const secondScene: GeneratedScene = {
      ...firstScene,
      id: 'scene-2',
      name: 'Scene 2',
      candidates: firstScene.candidates!.map((candidate, index) => ({
        ...candidate,
        runNumber: index + 1,
        video: {
          path: `videos/scene-2-${index}.mp4`,
          url: `https://example.test/scene-2-${index}.mp4`,
        },
      })),
      selectedCandidateIndex: 0,
      prompt: 'same prompt',
    };
    project.update(value => ({
      ...value,
      storyboard: [firstScene, secondScene],
    }));
    fixture.detectChanges();

    component.selectScene('scene-2');
    fixture.detectChanges();

    const control = await startRecording();
    const selected = project().storyboard[1] as GeneratedScene;
    component.selectCandidate(selected, 1);
    fixture.detectChanges();

    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');
    request.flush({text: 'second scene transcript'});
    fixture.detectChanges();

    expect(component.selectedScene()?.id).toBe('scene-2');
    expect((project().storyboard[0] as GeneratedScene).prompt).toBe(
      'same prompt',
    );
    expect((project().storyboard[1] as GeneratedScene).prompt).toBe(
      'same prompt\nsecond scene transcript',
    );
  });

  it('keeps a same-prompt selection alive while transcription is pending', async () => {
    const control = await startRecording();
    const scene = project().storyboard[0] as GeneratedScene;

    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');

    component.selectCandidate(scene, 1);
    fixture.detectChanges();

    expect(request.cancelled).toBe(false);
    expect(control.state().status).toBe('transcribing');
    request.flush({text: 'pending selection'});
    fixture.detectChanges();

    expect((project().storyboard[0] as GeneratedScene).prompt).toBe(
      'same prompt\npending selection',
    );
  });

  it('keeps recording through public generation attach with a default candidate selection', async () => {
    const scene = project().storyboard[0] as GeneratedScene;
    scene.candidates = [];
    scene.selectedCandidateIndex = undefined;
    project.update(value => ({...value, storyboard: [scene]}));
    fixture.detectChanges();

    const control = await startRecording();
    const engine = TestBed.inject(RemixEngineService);
    vi.spyOn(engine, 'startVideoGenerationWorkflow').mockResolvedValue(
      of({executionId: 'execution-1'} satisfies SupplyNodeResponse),
    );
    let resolvePoll!: (status: WorkflowStatusResponse) => void;
    const poll = new Promise<WorkflowStatusResponse>(resolve => {
      resolvePoll = resolve;
    });
    vi.spyOn(engine, 'pollWorkflow').mockReturnValue(poll);
    const generation = engine.generateCandidates(scene, {
      durationSeconds: 4,
      model: 'veo',
      generateAudio: true,
      resolution: '720p',
    });
    vi.spyOn(engine, 'uploadThumbnail').mockResolvedValue({
      path: 'thumbnails/new.jpg',
      url: 'https://example.test/thumbnails/new.jpg',
    });

    await Promise.resolve();
    expect(control.isRecording()).toBe(true);
    expect(track.stopped).toBe(false);

    resolvePoll({
      sink: {
        actualCounts: {},
        inputFiles: {},
        inputGroups: {},
        lastUpdated: '',
        output: {'0': {video: [{file: 'videos/new.mp4'}]}},
        targetCounts: {},
      },
    });
    await generation;
    fixture.detectChanges();

    expect(
      (project().storyboard[0] as GeneratedScene).selectedCandidateIndex,
    ).toBe(0);
    expect((project().storyboard[0] as GeneratedScene).candidates).toHaveLength(
      1,
    );
    expect(control.isRecording()).toBe(true);
    expect(track.stopped).toBe(false);

    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');
    request.flush({text: 'after generation'});
    fixture.detectChanges();

    expect((project().storyboard[0] as GeneratedScene).prompt).toBe(
      'same prompt\nafter generation',
    );
  });

  it('cancels recording when candidate selection replaces the scene prompt text', async () => {
    const control = await startRecording();
    const scene = project().storyboard[0] as GeneratedScene;
    scene.candidates![1].prompt = 'different prompt';

    component.selectCandidate(scene, 1);
    fixture.detectChanges();

    expect(control.isRecording()).toBe(false);
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('cancels recording when the project changes', async () => {
    const control = await startRecording();
    project.update(value => ({...value, id: 'project-2'}));
    fixture.detectChanges();

    expect(control.isRecording()).toBe(false);
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('cancels recording when the scene changes within the same project', async () => {
    const control = await startRecording();
    const replacement: GeneratedScene = {
      id: 'scene-2',
      name: 'Scene 2',
      type: 'generated',
      prompt: 'same prompt',
      candidates: [],
    };
    project.update(value => ({...value, storyboard: [replacement]}));
    fixture.detectChanges();

    expect(control.isRecording()).toBe(false);
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('does not restore a take after a prompt changes A-B-A', async () => {
    const control = await startRecording();
    const scene = project().storyboard[0] as GeneratedScene;

    component.updateScenePrompt(scene, 'prompt B');
    fixture.detectChanges();
    component.updateScenePrompt(scene, 'same prompt');
    fixture.detectChanges();

    expect(control.isRecording()).toBe(false);
    expect(track.stopped).toBe(true);
    http.expectNone('/api/transcribe');
  });

  it('cancels an in-flight transcription across an A-B-A project navigation', async () => {
    const control = await startRecording();
    control.stop();
    await Promise.resolve();
    await Promise.resolve();
    const request = http.expectOne('/api/transcribe');

    project.update(value => ({...value, id: 'project-2'}));
    fixture.detectChanges();
    project.update(value => ({...value, id: 'project-1'}));
    fixture.detectChanges();

    expect(request.cancelled).toBe(true);
    expect((project().storyboard[0] as GeneratedScene).prompt).toBe(
      'same prompt',
    );
  });
});

describe('EditCandidateDialog dictation binding', () => {
  it('updates the edit prompt without submitting the dialog', async () => {
    const close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [EditCandidateDialog],
      providers: [
        {provide: MAT_DIALOG_DATA, useValue: {dictationEnabled: true}},
        {provide: MatDialogRef, useValue: {close}},
      ],
    });
    TestBed.overrideComponent(EditCandidateDialog, {
      remove: {imports: [DictationControl]},
      add: {imports: [DictationControlStub]},
    });
    const fixture = TestBed.createComponent(EditCandidateDialog);
    fixture.detectChanges();
    const control = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    expect(control.textarea?.tagName).toBe('TEXTAREA');
    control.valueChange.emit('make the sky purple');
    expect(fixture.componentInstance.editPrompt()).toBe('make the sky purple');
    expect(close).not.toHaveBeenCalled();
  });
});
