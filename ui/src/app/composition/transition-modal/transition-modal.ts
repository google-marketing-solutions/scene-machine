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

import {CommonModule} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  Input,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  FormControl,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatSelectModule} from '@angular/material/select';
import {DEFAULT_TRANSITION_OVERLAP} from '../../services/config/config';

/**
 * Modal component for selecting a transition.
 */
@Component({
  selector: 'app-transition-modal',
  templateUrl: './transition-modal.html',
  styleUrls: ['./transition-modal.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    ReactiveFormsModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransitionModal {
  @Input({required: true}) maxTransitionOverlap!: number;
  readonly transitions = input.required<Array<{id: string; name: string}>>();
  readonly initialTransition = input<{id?: string; overlap?: number}>();
  readonly selectedTransition = output<{
    id: string;
    overlap: number;
  } | null>();

  readonly transitionOverlap = new FormControl<number>(
    DEFAULT_TRANSITION_OVERLAP,
    {
      validators: [
        Validators.required,
        Validators.min(0),
        Validators.max(this.maxTransitionOverlap),
      ],
    },
  );

  readonly closed = output<void>();

  dialog = viewChild.required<ElementRef>('dialog');
  selectedTransitionValue = '';

  constructor() {
    effect(() => {
      this.dialog().nativeElement.showModal();
      this.selectedTransitionValue = this.initialTransition()?.id ?? '';
      this.transitionOverlap.setValue(
        Math.min(
          this.initialTransition()?.overlap ?? DEFAULT_TRANSITION_OVERLAP,
          this.maxTransitionOverlap,
        ),
      );
    });
  }

  onSelect(): void {
    this.selectedTransition.emit({
      id: this.selectedTransitionValue,
      overlap: this.transitionOverlap.value ?? DEFAULT_TRANSITION_OVERLAP,
    });
    this.close();
  }

  onRemove(): void {
    this.selectedTransition.emit(null);
    this.close();
  }

  close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }
}
