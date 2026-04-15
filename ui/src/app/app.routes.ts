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

import {Routes} from '@angular/router';
import {Homepage} from './homepage/homepage';
/**
 * Application routes.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Scene Machine',
    component: Homepage,
  },
  {
    path: 'generate/:projectType',
    title: 'Scene Machine',
    loadComponent: () => import('./generate/generate').then(m => m.Generate),
  },
  {
    path: ':id/setup',
    loadComponent: () => import('./setup/setup').then(m => m.Setup),
    title: 'Setup',
  },
  {
    path: ':id/storyboard',
    loadComponent: () =>
      import('./storyboard/storyboard').then(m => m.Storyboard),
    title: 'Storyboard',
  },
  {
    path: ':id/composition',
    loadComponent: () =>
      import('./composition/composition').then(m => m.Composition),
    title: 'Composition',
  },
  {
    path: ':id/output-video',
    loadComponent: () =>
      import('./output-video/output-video').then(m => m.OutputVideo),
    title: 'Output',
  },
  {
    path: 'templates',
    loadComponent: () => import('./templates/templates').then(m => m.Templates),
    title: 'Template Manager',
  },
  {
    path: 'settings',
    loadComponent: () => import('./homepage/homepage').then(m => m.Homepage), // Reusing homepage for now as dummy
    title: 'Settings',
  },
  {
    path: '**',
    redirectTo: '',
  },
];
