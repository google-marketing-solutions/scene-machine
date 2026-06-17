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

import {TestBed} from '@angular/core/testing';
import {MAT_DIALOG_DATA, MatDialogRef} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AspectRatio,
  GeneratedScene,
  Product,
} from '../../services/config/config';
import {RemixEngineService} from '../../services/remix-engine/remix-engine';
import {GenerateStoryboardDialog} from './generate-storyboard-dialog';

// removeScene splices generatedScenes in place, so every caller needs its own
// fresh array (a shared module constant would be mutated across tests).
function scenes(): GeneratedScene[] {
  return [
    {prompt: 'Scene A'},
    {prompt: 'Scene B'},
  ] as unknown as GeneratedScene[];
}

const PRODUCT_WITH_BAD_IMAGE = (): Product =>
  product({
    images: [{path: 'gcs/p.png', url: 'https://p', aspectRatioDeviation: 0.5}],
  });

function product(overrides: Partial<Product> = {}): Product {
  return {id: 1, name: 'Product 1', images: [], ...overrides};
}

interface DialogData {
  aspectRatio: AspectRatio;
  products: Product[];
  briefing: string;
  overwriteSystemPrompt: boolean;
}

/**
 * Builds the dialog under test. The template is replaced with an empty one so
 * the spec exercises the component class logic only. By default the remix
 * service resolves a fresh two-scene array; pass {generateResult: undefined} to
 * model a generation failure.
 *
 * Seeding a product whose image is out of aspect range makes ngOnInit return
 * early WITHOUT generating — useful when a test needs to drive (and assert) the
 * generation outcome explicitly rather than racing the constructor's auto-run.
 *
 * generateResult lives in an options object (not a plain default parameter) so
 * that an explicit `undefined` is honoured as "failed" instead of falling back
 * to the success default.
 */
async function createDialog(
  dataOverrides: Partial<DialogData> = {},
  options: {generateResult?: GeneratedScene[] | undefined} = {},
) {
  const generateResult =
    'generateResult' in options ? options.generateResult : scenes();
  const data: DialogData = {
    aspectRatio: '16:9',
    products: [product()],
    briefing: 'Sell the thing',
    overwriteSystemPrompt: false,
    ...dataOverrides,
  };
  const remixMock = {
    generateStoryboard: vi.fn().mockResolvedValue(generateResult),
  };
  const dialogRef = {close: vi.fn(), disableClose: false};
  const snackBar = {open: vi.fn()};

  TestBed.configureTestingModule({
    imports: [GenerateStoryboardDialog],
    providers: [
      {provide: MatDialogRef, useValue: dialogRef},
      {provide: MAT_DIALOG_DATA, useValue: data},
      {provide: RemixEngineService, useValue: remixMock},
      // Unlike the upload dialogs, this component injects MatSnackBar from the
      // root injector (it does not import MatSnackBarModule), so a root provider
      // is the instance it actually uses.
      {provide: MatSnackBar, useValue: snackBar},
    ],
  });
  TestBed.overrideComponent(GenerateStoryboardDialog, {set: {template: ''}});
  await TestBed.compileComponents();

  const fixture = TestBed.createComponent(GenerateStoryboardDialog);
  const component = fixture.componentInstance;
  fixture.detectChanges();
  await fixture.whenStable();

  return {fixture, component, remixMock, dialogRef, snackBar};
}

describe('GenerateStoryboardDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const {component} = await createDialog();
    expect(component).toBeTruthy();
  });

  it('maps the aspect ratio to a CSS ratio string', async () => {
    const {component} = await createDialog({aspectRatio: '9:16'});
    expect(component.aspectRatio).toBe('9/16');
  });

  it('auto-generates a storyboard on init when all images are valid', async () => {
    const {component, remixMock} = await createDialog({
      products: [product({images: []})],
    });

    expect(remixMock.generateStoryboard).toHaveBeenCalledWith(
      [product({images: []})],
      'Sell the thing',
      'none',
    );
    expect(component.imageDecision()).toBe('none');
    expect(component.generatedScenes).toEqual(scenes());
    expect(component.isLoading()).toBe(false);
  });

  it('waits for an image decision when an image has an out-of-range aspect ratio', async () => {
    const {component, remixMock} = await createDialog({
      products: [PRODUCT_WITH_BAD_IMAGE()],
    });

    // ngOnInit returns early: no generation yet, decision still unset.
    expect(remixMock.generateStoryboard).not.toHaveBeenCalled();
    expect(component.imageDecision()).toBeNull();
  });

  it('generates with the chosen image decision', async () => {
    const {component, remixMock} = await createDialog({
      products: [PRODUCT_WITH_BAD_IMAGE()],
    });
    component.imageDecision.set('outpaint');

    await component.generateStoryboard();

    expect(remixMock.generateStoryboard).toHaveBeenCalledWith(
      expect.anything(),
      'Sell the thing',
      'outpaint',
    );
    expect(component.generatedScenes).toEqual(scenes());
  });

  it('removes a scene by index', async () => {
    const {component} = await createDialog();
    expect(component.generatedScenes).toHaveLength(2);
    const survivor = component.generatedScenes[1];

    component.removeScene(0);

    expect(component.generatedScenes).toEqual([survivor]);
  });

  it('confirms by closing with the generated scenes', async () => {
    const {component, dialogRef} = await createDialog();
    const generated = component.generatedScenes;

    component.onGenerateVideos();

    expect(dialogRef.close).toHaveBeenCalledTimes(1);
    expect(dialogRef.close).toHaveBeenCalledWith(generated);
  });

  it('cancels by closing without a value', async () => {
    const {component, dialogRef} = await createDialog();
    dialogRef.close.mockClear();

    component.onCancel();

    expect(dialogRef.close).toHaveBeenCalledTimes(1);
    expect(dialogRef.close).toHaveBeenCalledWith();
  });

  it('shows an error and closes when generation fails', async () => {
    // Gate the ngOnInit auto-run with an out-of-range image so the failure can
    // be driven explicitly (and asserted) rather than racing the constructor.
    const {component, remixMock, snackBar, dialogRef} = await createDialog(
      {products: [PRODUCT_WITH_BAD_IMAGE()]},
      {generateResult: undefined},
    );
    expect(remixMock.generateStoryboard).not.toHaveBeenCalled();
    component.imageDecision.set('none');

    await component.generateStoryboard();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Storyboard generation failed. Please try again.',
      'Close',
      expect.anything(),
    );
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
    expect(component.isLoading()).toBe(false);
  });
});
