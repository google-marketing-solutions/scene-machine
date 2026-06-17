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

import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {ActivatedRoute, Router} from '@angular/router';
import {ConfigService} from '../services/config/config';

/**
 * Component to handle generation of a new project.
 */
@Component({
  selector: 'app-generate',
  imports: [],
  template: '<html></html>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Generate {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private config = inject(ConfigService);
  private snackBar = inject(MatSnackBar);

  generateUUID(): string {
    return crypto.randomUUID();
  }

  constructor() {
    // A new project is built from the global config defaults (aspect ratio,
    // resolution, model). If /api/config has not loaded yet (or failed), those
    // defaults are empty, so creating now would persist a project with missing
    // settings. Bounce back home with a recoverable message instead. (E1)
    if (!this.config.globalConfig.value()) {
      this.snackBar.open(
        'Configuration is not loaded yet. Please try again in a moment.',
        'Dismiss',
        {panelClass: ['error-snackbar']},
      );
      void this.router.navigate(['/'], {replaceUrl: true});
      return;
    }
    const uuid = this.generateUUID();
    const projectType = this.route.snapshot.paramMap.get('projectType');
    const redirectRoute = projectType === 'ai' ? 'setup' : 'storyboard';
    this.config.setNewProject(uuid);
    // Persist the brand-new project immediately so it exists server-side and
    // shows on the homepage right away, instead of only after the user makes an
    // edit and the 5s autosave fires.
    this.config.saveNow();
    void this.router.navigate([`/${uuid}/${redirectRoute}`], {
      replaceUrl: true,
    });
  }
}
