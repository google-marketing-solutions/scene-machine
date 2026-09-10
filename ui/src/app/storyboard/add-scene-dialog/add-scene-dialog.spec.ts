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
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AddSceneDialog} from './add-scene-dialog';

/** Builds the dialog under test with a stub MatDialogRef. */
async function createDialog() {
  const dialogRef = {close: vi.fn()};

  TestBed.configureTestingModule({
    imports: [AddSceneDialog],
    providers: [
      {provide: MatDialogRef, useValue: dialogRef},
      {provide: MAT_DIALOG_DATA, useValue: {}},
    ],
  });
  await TestBed.compileComponents();

  const fixture = TestBed.createComponent(AddSceneDialog);
  fixture.detectChanges();

  return {fixture, component: fixture.componentInstance, dialogRef};
}

describe('AddSceneDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the generate button with provider-neutral copy', async () => {
    const {fixture} = await createDialog();
    const heading = fixture.nativeElement.querySelector(
      '.generate-option h3',
    ) as HTMLElement;
    expect(heading.textContent?.trim()).toBe('Generate with Google AI');
  });

  it('closes with a generate result when the generate option is picked', async () => {
    const {component, dialogRef} = await createDialog();

    component.selectGenerate();

    expect(dialogRef.close).toHaveBeenCalledWith({type: 'generate'});
  });
});
