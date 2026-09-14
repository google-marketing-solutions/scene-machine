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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialogRef} from '@angular/material/dialog';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {EditCandidateDialog} from './edit-candidate-dialog';

describe('EditCandidateDialog', () => {
  let fixture: ComponentFixture<EditCandidateDialog>;
  let component: EditCandidateDialog;
  let dialogRef: {close: ReturnType<typeof vi.fn>};

  beforeEach(async () => {
    dialogRef = {close: vi.fn()};
    await TestBed.configureTestingModule({
      imports: [EditCandidateDialog],
      providers: [{provide: MatDialogRef, useValue: dialogRef}],
    }).compileComponents();
    fixture = TestBed.createComponent(EditCandidateDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows an example prompt and keeps Generate disabled for an empty prompt', () => {
    const textarea = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    const buttons = fixture.nativeElement.querySelectorAll(
      'button',
    ) as NodeListOf<HTMLButtonElement>;
    const editButton = Array.from(buttons).find(
      button => button.textContent?.trim() === 'Generate',
    ) as HTMLButtonElement;

    expect(textarea.placeholder).toBe('e.g., Make the sky purple');
    expect(textarea.value).toBe('');
    expect(getComputedStyle(textarea).resize).toBe('none');
    expect(fixture.nativeElement.querySelector('h2').textContent.trim()).toBe(
      'Edit candidate',
    );
    expect(editButton.disabled).toBe(true);
  });

  it('enables Generate and returns the trimmed instruction', () => {
    component.updateEditPrompt('  Make the sky purple  ');
    fixture.detectChanges();

    const generateButton = Array.from(
      fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>,
    ).find(
      button => button.textContent?.trim() === 'Generate',
    ) as HTMLButtonElement;

    expect(generateButton.disabled).toBe(false);
    generateButton.click();

    expect(dialogRef.close).toHaveBeenCalledWith('Make the sky purple');
  });
});
