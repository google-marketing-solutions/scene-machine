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
import {ImageImportService} from '../../services/image-import/image-import';
import {MediaService} from '../../services/media/media';
import {RemixEngineService} from '../../services/remix-engine/remix-engine';
import {SceneTiming} from '../composition';
import {ImageUploadDialog} from './image-upload-dialog';

const SCENE_TIMINGS: SceneTiming[] = [
  {id: 's1', name: 'Scene 1', start: 0, end: 5},
];

const EXISTING_FILE: GcsFile = {path: 'gcs/logo.png', url: 'https://x/logo'};

const EXISTING_OVERLAY = {
  name: 'logo.png',
  file: EXISTING_FILE,
  startSeconds: 1,
  durationSeconds: 4,
  widthPixels: 200,
  heightPixels: 100,
  pixelsFromTop: 10,
  pixelsFromLeft: 20,
};

/**
 * Builds the dialog under test with the supplied MAT_DIALOG_DATA and a set of
 * lightweight stubs. The template is replaced with an empty one so the spec
 * exercises the component class logic only (the real markup renders a
 * SceneSelector and reads ConfigService members not on this focused mock).
 */
async function createDialog(
  data: ImageUploadDialog['data'],
  visualOverlays: ProjectConfig['visualOverlays'] = [],
) {
  const projectConfig = signal<Partial<ProjectConfig>>({visualOverlays});
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
  // The real ImageImportService is pure (no network) for the data-transfer
  // helpers, but a stub keeps the spec from depending on its internals.
  const importMock = {
    imageFilesFromDataTransfer: vi.fn().mockReturnValue([]),
    imageUrlFromDataTransfer: vi.fn().mockReturnValue(null),
    importText: vi.fn().mockResolvedValue({files: [], failures: []}),
  };
  const dialogRef = {close: vi.fn()};

  TestBed.configureTestingModule({
    imports: [ImageUploadDialog],
    providers: [
      {provide: MatDialogRef, useValue: dialogRef},
      {provide: MAT_DIALOG_DATA, useValue: data},
      {provide: ConfigService, useValue: configMock},
      {provide: RemixEngineService, useValue: remixMock},
      {provide: MediaService, useValue: mediaMock},
      {provide: ImageImportService, useValue: importMock},
    ],
  });
  TestBed.overrideComponent(ImageUploadDialog, {set: {template: ''}});
  await TestBed.compileComponents();

  const fixture = TestBed.createComponent(ImageUploadDialog);
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
    importMock,
    dialogRef,
    snackBarOpen,
  };
}

describe('ImageUploadDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    expect(component).toBeTruthy();
  });

  it('seeds endSeconds from the supplied video duration when adding', async () => {
    const {component} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
      videoDurationSeconds: signal(12),
    });
    expect(component.isEditMode()).toBe(false);
    expect(component.endSeconds()).toBe(12);
  });

  it('prefills edit state from the supplied overlay', async () => {
    const {component, mediaMock} = await createDialog({
      overlay: EXISTING_OVERLAY,
      overlayIndex: 0,
      sceneTimings: SCENE_TIMINGS,
    });

    expect(component.isEditMode()).toBe(true);
    expect(component.existingFileName()).toBe('logo.png');
    expect(component.existingFile()).toEqual(EXISTING_FILE);
    expect(component.startSeconds()).toBe(1);
    // endSeconds is start + duration.
    expect(component.endSeconds()).toBe(5);
    expect(component.imageWidthPixels()).toBe(200);
    expect(component.imageHeightPixels()).toBe(100);
    expect(component.pixelsFromTop()).toBe(10);
    expect(component.pixelsFromLeft()).toBe(20);
    expect(mediaMock.resolve).toHaveBeenCalledWith(EXISTING_FILE);
    expect(component.imageUrl()).toBe('https://signed/url');
  });

  it('flags an invalid time range when end precedes start', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    component.startSeconds.set(8);
    component.endSeconds.set(4);
    expect(component.isInvalidTimeRange()).toBe(true);

    component.endSeconds.set(10);
    expect(component.isInvalidTimeRange()).toBe(false);
  });

  it('rejects a non-image file in processFile', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    component.processFile(
      new File([new Uint8Array([1])], 'note.txt', {type: 'text/plain'}),
    );
    expect(component.selectedFile()).toBeNull();
    expect(component.imageUrl()).toBeNull();
  });

  it('keeps aspect ratio when locked and width changes', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    component.aspectRatio.set(2); // width is twice the height
    component.isAspectRatioLocked.set(true);

    component.onWidthChange(400);

    expect(component.imageWidthPixels()).toBe(400);
    expect(component.imageHeightPixels()).toBe(200);
  });

  it('leaves the paired dimension alone when the lock is off', async () => {
    const {component} = await createDialog({sceneTimings: SCENE_TIMINGS});
    component.aspectRatio.set(2);
    component.isAspectRatioLocked.set(false);
    component.imageHeightPixels.set(123);

    component.onWidthChange(400);

    expect(component.imageWidthPixels()).toBe(400);
    expect(component.imageHeightPixels()).toBe(123);
  });

  it('does nothing and stays open on add with an invalid time range', async () => {
    const {component, configMock, dialogRef} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
    });
    component.existingFile.set(EXISTING_FILE);
    component.startSeconds.set(9);
    component.endSeconds.set(2);

    await component.onAdd();

    expect(configMock.updateProjectConfig).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('appends a new overlay and closes when adding a fresh upload', async () => {
    const {component, configMock, remixMock, dialogRef} = await createDialog({
      sceneTimings: SCENE_TIMINGS,
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'badge.png', {
      type: 'image/png',
    });
    component.processFile(file);
    component.startSeconds.set(2);
    component.endSeconds.set(6);
    component.imageWidthPixels.set(300);
    component.imageHeightPixels.set(150);
    component.pixelsFromTop.set(5);
    component.pixelsFromLeft.set(7);

    await component.onAdd();

    expect(remixMock.uploadMedia).toHaveBeenCalledWith(file);
    expect(configMock.projectConfig.value().visualOverlays).toEqual([
      {
        name: 'badge.png',
        file: {path: 'remix-input/up', url: 'https://up'},
        startSeconds: 2,
        durationSeconds: 4,
        widthPixels: 300,
        heightPixels: 150,
        pixelsFromTop: 5,
        pixelsFromLeft: 7,
      },
    ]);
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
  });

  it('replaces the edited overlay in place without re-uploading', async () => {
    const {component, configMock, remixMock, dialogRef} = await createDialog(
      {
        overlay: EXISTING_OVERLAY,
        overlayIndex: 0,
        sceneTimings: SCENE_TIMINGS,
      },
      [EXISTING_OVERLAY],
    );
    component.endSeconds.set(9);

    await component.onAdd();

    expect(remixMock.uploadMedia).not.toHaveBeenCalled();
    const overlays = configMock.projectConfig.value().visualOverlays!;
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toEqual({
      ...EXISTING_OVERLAY,
      // start 1 + new duration: end(9) - start(1) = 8.
      durationSeconds: 8,
    });
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a snackbar and keeps the dialog open when upload fails', async () => {
    const {component, configMock, remixMock, snackBarOpen, dialogRef} =
      await createDialog({sceneTimings: SCENE_TIMINGS});
    remixMock.uploadMedia.mockRejectedValueOnce(new Error('boom'));
    component.processFile(
      new File([new Uint8Array([9])], 'bad.png', {type: 'image/png'}),
    );
    component.startSeconds.set(0);
    component.endSeconds.set(3);

    await component.onAdd();

    expect(snackBarOpen).toHaveBeenCalledWith(
      'Failed to upload image.',
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
