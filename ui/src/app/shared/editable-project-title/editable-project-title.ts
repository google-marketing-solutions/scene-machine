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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {ConfigService} from '../../services/config/config';

/**
 * Inline-editable project title shared by the storyboard, composition and
 * output headers. Renders the project name with a pencil affordance; clicking
 * the pencil (or the name) swaps in an input pre-filled with the current name.
 * Committing (blur or Enter) writes the name via ConfigService and persists it
 * immediately with saveNow(); Escape cancels; an empty name is ignored.
 */
@Component({
  selector: 'app-editable-project-title',
  standalone: true,
  imports: [MatIconModule, MatButtonModule],
  templateUrl: './editable-project-title.html',
  styleUrl: './editable-project-title.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditableProjectTitle {
  readonly config = inject(ConfigService);

  /** Whether the title is currently showing the inline input. */
  readonly editing = signal(false);

  private readonly input =
    viewChild<ElementRef<HTMLInputElement>>('titleInput');

  /** Enter edit mode and focus the input pre-filled with the current name. */
  startEditing(): void {
    this.editing.set(true);
    // The input renders after this signal flips; focus on the next frame.
    queueMicrotask(() => {
      const el = this.input()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

  /** Commit the edited name (blur or Enter): persist immediately, or revert. */
  commit(value: string): void {
    if (!this.editing()) {
      return;
    }
    this.editing.set(false);
    const name = value.trim();
    if (!name || name === this.config.projectConfig.value().name) {
      return;
    }
    this.config.updateProjectConfig({name});
    this.config.saveNow();
  }

  /** Cancel editing without saving (Escape). */
  cancel(): void {
    this.editing.set(false);
  }
}
