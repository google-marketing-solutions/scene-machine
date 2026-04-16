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

import {ElementRef, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_TRANSITION_OVERLAP} from '../../services/config/config';
import {TransitionModal} from './transition-modal';

describe('TransitionModal', () => {
  let component: TransitionModal;
  let fixture: ComponentFixture<TransitionModal>;
  let mockDialogElement: HTMLDialogElement;

  const mockTransitions = [
    {id: 'fade', name: 'Fade'},
    {id: 'wipeleft', name: 'Wipe Left'},
  ];

  beforeEach(async () => {
    mockDialogElement = document.createElement('dialog') as HTMLDialogElement;
    mockDialogElement.showModal = vi.fn();
    mockDialogElement.close = vi.fn();

    await TestBed.configureTestingModule({
      imports: [TransitionModal],
      providers: [
        {
          provide: ElementRef,
          useValue: {nativeElement: mockDialogElement},
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TransitionModal);
    component = fixture.componentInstance;

    // Manually set the viewChild for testing purposes
    component.dialog = signal({nativeElement: mockDialogElement});
    fixture.componentRef.setInput('transitions', mockTransitions);

    fixture.detectChanges(); // This will trigger the effect
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should open the dialog automatically on init', () => {
    expect(mockDialogElement.showModal).toHaveBeenCalled();
  });

  it('should emit selectedTransition and close on onSelect', () => {
    const testTransitionId = 'fade';
    component.selectedTransitionValue = testTransitionId;
    component.transitionOverlap.setValue(DEFAULT_TRANSITION_OVERLAP);

    vi.spyOn(component.selectedTransition, 'emit');
    vi.spyOn(component.closed, 'emit');

    component.onSelect();

    expect(component.selectedTransition.emit).toHaveBeenCalledWith({
      id: testTransitionId,
      overlap: DEFAULT_TRANSITION_OVERLAP,
    });
    expect(component.closed.emit).toHaveBeenCalled();
    expect(mockDialogElement.close).toHaveBeenCalled();
  });

  it('should emit closed and close on close', () => {
    vi.spyOn(component.closed, 'emit');
    component.close();

    expect(component.closed.emit).toHaveBeenCalled();
    expect(mockDialogElement.close).toHaveBeenCalled();
  });

  it('should bind transitions input', () => {
    expect(component.transitions()).toEqual(mockTransitions);
  });
});
