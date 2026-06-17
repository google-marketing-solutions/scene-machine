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
  inject,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import {MatSidenavContainer, MatSidenavModule} from '@angular/material/sidenav';
import {NavigationEnd, Router, RouterOutlet} from '@angular/router';
import {filter} from 'rxjs/operators';
import {env} from '../env';
import {ConfigService} from './services/config/config';
import {RemixEngineService} from './services/remix-engine/remix-engine';
import {Sidebar} from './sidebar/sidebar';

/**
 * Root component of the application.
 */
@Component({
  selector: 'app-root',
  imports: [MatButtonModule, MatSidenavModule, RouterOutlet, Sidebar],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  protected configService = inject(ConfigService);
  // Eagerly instantiated so persisted in-flight generations resume on every
  // route (the service's constructor effect watches the loaded project);
  // otherwise it would only be created lazily by storyboard/setup/composition.
  protected remixEngineService = inject(RemixEngineService);
  protected router = inject(Router);

  collapsed = signal(false);
  protected loggedIn = signal(false);
  protected showLoginMessage = signal(false);

  @ViewChild(MatSidenavContainer) sidenavContainer!: MatSidenavContainer;

  login() {
    // The only deployed front door is IAP, behind which the user is already
    // authenticated. The data plane is fully mediated through /api, which the
    // backend filters and stamps by the verified IAP identity, so the client
    // holds no session of its own. There is nothing to sign in to here, so just
    // mark the app as logged in.
    this.loggedIn.set(true);
  }

  async ngOnInit() {
    // This handles the initial page load for a project.
    this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe(event => {
        if (event.url === '/') {
          this.configService.resetProjectConfig();
          return;
        }
        let root = this.router.routerState.snapshot.root;
        while (root.firstChild) {
          root = root.firstChild;
        }
        const id = root.paramMap.get('id');
        if (id !== null) {
          if (this.loggedIn()) {
            this.configService.loadProjectConfig(id);
          } else {
            // Fixes a race condition where the Navigation event happens before the login.
            setTimeout(() => {
              this.configService.loadProjectConfig(id);
            }, 0);
          }
        }
      });

    // Local dev (controlPlaneMode 'none'): there is no front-door auth, so treat
    // the developer as already signed in so the UI renders and calls /api. The
    // local backend runs AUTH_MODE=none and derives no identity.
    if (env.controlPlaneMode === 'none') {
      this.loggedIn.set(true);
      return;
    }

    // Deployed (controlPlaneMode 'iap'): IAP already authenticated the user, so
    // there is nothing to sign in to; just mark the app logged in.
    this.login();
  }
}
