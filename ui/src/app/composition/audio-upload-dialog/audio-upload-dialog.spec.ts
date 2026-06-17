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
import {TestBed} from '@angular/core/testing';
import {MAT_DIALOG_DATA, MatDialogRef} from '@angular/material/dialog';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConfigService,
  GcsFile,
  ProjectConfig,
} from '../../services/config/config';
import {MediaService} from '../../services/media/media';
import {RemixEngineService} from '../../services/remix-engine/remix-engine';
import {SceneTiming} from '../composition';
import {AudioUploadDialog} from './audio-upload-dialog';

const SCENE_TIMINGS: SceneTiming[] = [
  {id: 's1', name: 'Scene 1', start: 0, end: 5},
];

const EXISTING_FILE: GcsFile = {path: 'gcs/track.mp3', url: 'https://x/track'};

/**
 * Builds the dialog under test with the supplied MAT_DIALOG_DATA and a set of
 * lightweight stubs. The template is replaced with an empty one so the spec
 * exercises the component class logic only (the real markup renders a
 * SceneSelector and reads ConfigService members not on this focused mock).
 */
async function createDialog(
  data: AudioUploadDialog['data'],
  audioTracks: ProjectConfig['audioTracks'] = [],
) {
  const projectConfig = signal<Partial<ProjectConfig>>({audioTracks});
  const configMock = {
    projectConfig: {value: projectConfig},
    updateProjectConfig: vi.fn((partial: Partial<ProjectConfig>) =>
      projectConfig.update(c => ({...c, ...partial})),
    ),
  };
  const remixMock = {
    uploadMedia: vi
      .fn()
      .mockResolvedValue({path: 'remix-input/up', url: 'https://up'}),
  };
  const mediaMock = {resolve: vi.fn().mockResolvedValue('https://signed/url')};
  const dialogRef = {close: vi.fn()};

  TestBed.configureTestingModule({
    imports: [AudioUploadDialog],
    providers: [
      {provide: MatDialogRef, useValue: dialogRef},
      {provide: MAT_DIALOG_DATA, useValue: data},
      {provide: ConfigService, useValue: configMock},
      {provide: RemixEngineService, useValue: remixMock},
      {provide: MediaService, useValue: mediaMock},
    ],
  });
  TestBed.overrideComponent(AudioUploadDialog, {set: {template: ''}});
  await TestBed.compileComponents();

  const fixture = TestBed.createComponent(AudioUploadDialog);
  const component = fixture.componentInstance;
  fixture.detectChanges();
  await fixture.whenStable();

  // MatSnackBar resolves from the standalone component's own MatSnackBarModule
  // import, not the root injector, so a root provider would not be the instance
  // the component uses. Spy on the component's actual instance instead.
  const snackBar = (
    component as unknown as {
      matSnackBar: {open: (...args: unknown[]) => unknown};
    }
  ).matSnackBar;
  const snackBarOpen = vi
    .spyOn(snackBar, 'open')
    .mockReturnValue(undefined as never);

  return {
    fixture,
    component,
    configMock,
    remixMock,
    mediaMock,
    dialogRef,
    snackBarOpen,
  };
}

describe('AudioUploadDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    expect(component).toBeTruthy();
  });

  it('starts in add mode with no track data', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    expect(component.isEditMode()).toBe(false);
    expect(component.existingFile()).toBeNull();
  });

  it('prefills edit state from the supplied track', async () => {
    const {component, mediaMock} = await createDialog({
      track: {
        name: 'theme.mp3',
        file: EXISTING_FILE,
        startSeconds: 2,
        durationSeconds: 8,
      },
      trackIndex: 0,
      sceneTimings: SCENE_TIMINGS,
    });

    expect(component.isEditMode()).toBe(true);
    expect(component.existingFileName()).toBe('theme.mp3');
    expect(component.existingFile()).toEqual(EXISTING_FILE);
    expect(component.startSeconds()).toBe(2);
    // endSeconds is start + duration.
    expect(component.endSeconds()).toBe(10);
    // The stored file ref is resolved to a fresh signed URL.
    expect(mediaMock.resolve).toHaveBeenCalledWith(EXISTING_FILE);
    expect(component.audioUrl()).toBe('https://signed/url');
  });

  it('flags an invalid time range when end precedes start', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    component.startSeconds.set(5);
    component.endSeconds.set(3);
    expect(component.isInvalidTimeRange()).toBe(true);

    component.endSeconds.set(9);
    expect(component.isInvalidTimeRange()).toBe(false);
  });

  it('does nothing and stays open on add with an invalid time range', async () => {
    const {component, configMock, dialogRef} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
    });
    component.existingFile.set(EXISTING_FILE);
    component.startSeconds.set(5);
    component.endSeconds.set(1);

    await component.onAdd();

    expect(configMock.updateProjectConfig).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('appends a new track and closes when adding a fresh upload', async () => {
    const {component, configMock, remixMock, dialogRef} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'song.mp3', {
      type: 'audio/mpeg',
    });
    component.processFile(file);
    component.startSeconds.set(1);
    component.endSeconds.set(6);

    await component.onAdd();

    expect(remixMock.uploadMedia).toHaveBeenCalledWith(file);
    expect(configMock.updateProjectConfig).toHaveBeenCalledTimes(1);
    expect(configMock.projectConfig.value().audioTracks).toEqual([
      {
        name: 'song.mp3',
        file: {path: 'remix-input/up', url: 'https://up'},
        startSeconds: 1,
        durationSeconds: 5,
      },
    ]);
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
  });

  it('replaces the edited track in place without re-uploading', async () => {
    const existingTrack = {
      name: 'old.mp3',
      file: EXISTING_FILE,
      startSeconds: 0,
      durationSeconds: 4,
    };
    const {component, configMock, remixMock, dialogRef} = await createDialog(
      {
        track: existingTrack,
        trackIndex: 0,
        sceneTimings: SCENE_TIMINGS,
      },
      [existingTrack],
    );
    component.startSeconds.set(0);
    component.endSeconds.set(7);

    await component.onAdd();

    // No new file was chosen, so nothing is uploaded.
    expect(remixMock.uploadMedia).not.toHaveBeenCalled();
    const tracks = configMock.projectConfig.value().audioTracks!;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      name: 'old.mp3',
      file: EXISTING_FILE,
      startSeconds: 0,
      durationSeconds: 7,
    });
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a snackbar and keeps the dialog open when upload fails', async () => {
    const {component, configMock, remixMock, snackBarOpen, dialogRef} =
      await createDialog({sceneTimings: SCENE_TIMINGS});
    remixMock.uploadMedia.mockRejectedValueOnce(new Error('boom'));
    component.processFile(
      new File([new Uint8Array([9])], 'bad.mp3', {type: 'audio/mpeg'}),
    );
    component.startSeconds.set(0);
    component.endSeconds.set(3);

    await component.onAdd();

    expect(snackBarOpen).toHaveBeenCalledWith(
      'Failed to upload audio track.',
      'Dismiss',
      expect.anything(),
    );
    expect(configMock.updateProjectConfig).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(component.isUploading()).toBe(false);
  });

  it('closes without a value on cancel', async () => {
    const {component, dialogRef, configMock} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
    });

    component.close();

    expect(dialogRef.close).toHaveBeenCalledTimes(1);
    expect(dialogRef.close).toHaveBeenCalledWith();
    expect(configMock.updateProjectConfig).not.toHaveBeenCalled();
  });
});
