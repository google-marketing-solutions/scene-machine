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
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatAutocompleteModule} from '@angular/material/autocomplete';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {SceneTiming} from '../composition';

/**
 * A dropdown for selecting either the start or end timing of a scene.
 */
@Component({
  selector: 'app-scene-selector',
  imports: [
    MatAutocompleteModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
  ],
  templateUrl: './scene-selector.html',
  styleUrl: './scene-selector.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SceneSelector {
  @Input({required: true}) sceneTimings!: SceneTiming[];
  @Input({required: true}) useSceneTiming!: 'start' | 'end';
  @Input({required: true}) label!: string;
  @Input({required: true}) value!: number;
  @Output() readonly valueChange = new EventEmitter<number>();
}
