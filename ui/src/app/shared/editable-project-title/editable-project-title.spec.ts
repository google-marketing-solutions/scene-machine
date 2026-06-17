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

import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigService, ProjectConfig} from '../../services/config/config';
import {EditableProjectTitle} from './editable-project-title';

function makeProjectConfig(name: string): ProjectConfig {
  return {
    id: 'test-id',
    name,
    storyboard: [],
    aspectRatio: '16:9',
    resolution: '1080p',
    candidateDurationSeconds: 4,
    generateAudio: false,
    numberOfCandidates: 1,
    model: 'veo-1',
    inputConfig: {products: [], composition: ''},
    audioTracks: [],
    visualOverlays: [],
  };
}

describe('EditableProjectTitle', () => {
  let component: EditableProjectTitle;
  let fixture: ComponentFixture<EditableProjectTitle>;
  const projectConfigSignal = signal<ProjectConfig>(
    makeProjectConfig('Test Project'),
  );
  let updateProjectConfig: ReturnType<typeof vi.fn>;
  let saveNow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    projectConfigSignal.set(makeProjectConfig('Test Project'));
    updateProjectConfig = vi.fn((partial: Partial<ProjectConfig>) => {
      projectConfigSignal.update(config => ({...config, ...partial}));
    });
    saveNow = vi.fn();

    const mockConfigService = {
      projectConfig: {
        value: projectConfigSignal,
        isLoading: () => false,
        error: () => null,
      },
      updateProjectConfig,
      saveNow,
    };

    await TestBed.configureTestingModule({
      imports: [EditableProjectTitle],
      providers: [{provide: ConfigService, useValue: mockConfigService}],
    }).compileComponents();

    fixture = TestBed.createComponent(EditableProjectTitle);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function queryInput(): HTMLInputElement | null {
    return fixture.nativeElement.querySelector('.title-input');
  }

  it('shows the project name with a pencil affordance by default', () => {
    expect(component.editing()).toBe(false);
    expect(
      fixture.nativeElement.querySelector('.title-text').textContent.trim(),
    ).toBe('Test Project');
    const pencil = fixture.nativeElement.querySelector('.edit-button');
    expect(pencil.getAttribute('aria-label')).toBe('Rename project');
    expect(queryInput()).toBeNull();
  });

  it('clicking the pencil toggles into edit mode with an input', () => {
    fixture.nativeElement.querySelector('.edit-button').click();
    fixture.detectChanges();

    expect(component.editing()).toBe(true);
    const input = queryInput();
    expect(input).not.toBeNull();
    expect(input!.value).toBe('Test Project');
  });

  it('commit calls updateProjectConfig + saveNow exactly once', () => {
    component.startEditing();
    component.commit('Renamed Project');

    expect(updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(updateProjectConfig).toHaveBeenCalledWith({name: 'Renamed Project'});
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(component.editing()).toBe(false);
  });

  it('Escape cancels without saving', () => {
    component.startEditing();
    component.cancel();

    expect(component.editing()).toBe(false);
    expect(updateProjectConfig).not.toHaveBeenCalled();
    expect(saveNow).not.toHaveBeenCalled();
  });

  it('does not save an empty (or whitespace-only) title', () => {
    component.startEditing();
    component.commit('   ');

    expect(component.editing()).toBe(false);
    expect(updateProjectConfig).not.toHaveBeenCalled();
    expect(saveNow).not.toHaveBeenCalled();
  });

  it('does not save when the name is unchanged', () => {
    component.startEditing();
    component.commit('Test Project');

    expect(updateProjectConfig).not.toHaveBeenCalled();
    expect(saveNow).not.toHaveBeenCalled();
  });
});
