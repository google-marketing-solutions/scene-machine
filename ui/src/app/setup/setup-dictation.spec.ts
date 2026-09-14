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

import {Component, EventEmitter, Input, Output, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideRouter} from '@angular/router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from '../services/client-media/client-media';
import {ConfigService, ProjectConfig} from '../services/config/config';
import {ImageImportService} from '../services/image-import/image-import';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {TemplatesService} from '../services/templates/templates';
import {DictationControl} from '../shared/dictation/dictation-control';
import {Setup} from './setup';

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
  @Input() maxDurationSeconds = 120;
  @Input() maxChars?: number;
  @Output() valueChange = new EventEmitter<string>();
}

describe('Setup dictation parent binding', () => {
  let fixture: ComponentFixture<Setup>;
  let project: ReturnType<typeof signal<ProjectConfig>>;
  let updateProjectConfig: ReturnType<typeof vi.fn>;
  let generateCandidates: ReturnType<typeof vi.fn>;
  let editCandidate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    project = signal<ProjectConfig>({
      id: 'project-1',
      name: 'Test',
      storyboard: [],
      aspectRatio: '16:9',
      resolution: '720p',
      candidateDurationSeconds: 4,
      generateAudio: true,
      numberOfCandidates: 1,
      model: 'veo',
      inputConfig: {
        products: [{id: 1, name: 'Product', description: '', images: []}],
        composition: '',
      },
      audioTracks: [],
      visualOverlays: [],
    });
    updateProjectConfig = vi.fn((partial: Partial<ProjectConfig>) =>
      project.update(value => ({...value, ...partial})),
    );
    generateCandidates = vi.fn();
    editCandidate = vi.fn();
    const config = {
      projectConfig: {value: project, isLoading: signal(false)},
      globalConfig: {
        value: () => ({
          dictation: {enabled: true, maxDurationSeconds: 120, maxChars: 500},
        }),
      },
      allowedAspectRatios: () => ['16:9', '9:16'],
      allowedResolutions: () => ['720p'],
      videoModels: () => ['veo'],
      durationSlider: () => ({min: 1, max: 8, step: 1}),
      audioLocked: () => false,
      selectResolution: vi.fn(),
      selectVideoModel: vi.fn(),
      saveNow: vi.fn(),
      updateProjectConfig,
      isGeneratedScene: (value: unknown) =>
        !!value && (value as {type?: string}).type === 'generated',
    };
    await TestBed.configureTestingModule({
      imports: [Setup],
      providers: [
        provideRouter([]),
        {provide: ConfigService, useValue: config},
        {provide: ClientMediaService, useValue: {}},
        {provide: ImageImportService, useValue: {}},
        {
          provide: RemixEngineService,
          useValue: {generateCandidates, editCandidate},
        },
        {
          provide: TemplatesService,
          useValue: {templates: {value: signal([])}},
        },
      ],
    });
    TestBed.overrideComponent(Setup, {
      remove: {imports: [DictationControl]},
      add: {imports: [DictationControlStub]},
    });
    fixture = TestBed.createComponent(Setup);
    fixture.detectChanges();
  });

  it('applies emitted dictation text through the parent binding', () => {
    const control = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    control.valueChange.emit('spoken description');
    expect(project().inputConfig.products[0].description).toBe(
      'spoken description',
    );
    expect(updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(control.maxDurationSeconds).toBe(30);
    expect(control.maxChars).toBe(500);
    expect(generateCandidates).not.toHaveBeenCalled();
    expect(editCandidate).not.toHaveBeenCalled();
  });

  it('routes composition dictation through the custom-template binding', () => {
    const control = fixture.debugElement
      .queryAll(By.directive(DictationControlStub))
      .map(node => node.componentInstance as DictationControlStub)
      .find(node => node.ownerKey.endsWith(':composition'))!;
    control.valueChange.emit('spoken composition');
    expect(project().inputConfig.composition).toBe('spoken composition');
    expect(project().inputConfig.templateId).toBe('custom');
    expect(generateCandidates).not.toHaveBeenCalled();
    expect(editCandidate).not.toHaveBeenCalled();
  });

  it('binds dictation controls for audience and style in the real template', () => {
    const controls = fixture.debugElement
      .queryAll(By.directive(DictationControlStub))
      .map(node => node.componentInstance as DictationControlStub);
    const ownerKeys = controls.map(control => control.ownerKey);
    expect(
      controls.every(control => control.textarea?.tagName === 'TEXTAREA'),
    ).toBe(true);
    expect(ownerKeys).toContain('project-1:audience');
    expect(ownerKeys).toContain('project-1:style');
    expect(ownerKeys).toContain('project-1:composition');
    controls
      .find(control => control.ownerKey.endsWith(':audience'))!
      .valueChange.emit('spoken audience');
    controls
      .find(control => control.ownerKey.endsWith(':style'))!
      .valueChange.emit('spoken style');
    expect(project().inputConfig.audience).toBe('spoken audience');
    expect(project().inputConfig.style).toBe('spoken style');
    expect(generateCandidates).not.toHaveBeenCalled();
    expect(editCandidate).not.toHaveBeenCalled();
  });

  it('changes the product owner key when the project changes', () => {
    const control = fixture.debugElement.query(
      By.directive(DictationControlStub),
    ).componentInstance as DictationControlStub;
    expect(control.ownerKey).toBe('project-1:product:1');
    project.update(value => ({...value, id: 'project-2'}));
    fixture.detectChanges();
    expect(control.ownerKey).toBe('project-2:product:1');
  });
});
