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
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {MatBadgeModule} from '@angular/material/badge';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatListModule} from '@angular/material/list';
import {MatMenuModule} from '@angular/material/menu';
import {Router, RouterModule} from '@angular/router';
import {ConfigService} from '../services/config/config';

/**
 * Component for the sidebar navigation.
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    MatListModule,
    MatIconModule,
    MatBadgeModule,
    MatButtonModule,
    RouterModule,
    MatMenuModule,
  ],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  router = inject(Router);
  private config = inject(ConfigService);
  theme = this.config.theme;
  primaryColor = this.config.primaryColor;

  collapsed = input(false);
  toggle = output<void>();
  readonly newRenderRunCount = this.config.newRenderRunCount;

  navigationItems = computed(() => {
    const config = this.config.projectConfig.value();
    const items = [
      {
        title: 'Setup',
        icon: 'tune',
        route: [config.id, 'setup'],
      },
      {
        title: 'Storyboard',
        icon: 'movie_edit',
        route: [config.id, 'storyboard'],
      },
      {
        title: 'Composition',
        icon: 'layers',
        route: [config.id, 'composition'],
        disabled: !config.storyboard.length,
      },
      {
        title: 'Output',
        icon: 'movie',
        route: [config.id, 'output-video'],
        disabled: !config.renderRuns?.length,
      },
    ];
    return items;
  });

  toggleCollapse() {
    this.toggle.emit();
  }
}
