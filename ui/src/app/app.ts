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
import {Auth, GoogleAuthProvider, signInWithPopup} from '@angular/fire/auth';
import {MatButtonModule} from '@angular/material/button';
import {MatSidenavContainer, MatSidenavModule} from '@angular/material/sidenav';
import {NavigationEnd, Router, RouterOutlet} from '@angular/router';
import {filter} from 'rxjs/operators';
import {ConfigService} from './services/config/config';
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
  protected router = inject(Router);

  private auth = inject(Auth);

  collapsed = signal(false);
  protected loggedIn = signal(false);
  protected showLoginMessage = signal(false);

  @ViewChild(MatSidenavContainer) sidenavContainer!: MatSidenavContainer;

  login() {
    signInWithPopup(this.auth, new GoogleAuthProvider())
      .then(() => {
        this.loggedIn.set(true);
        window.location.reload();
      })
      .catch(error => {
        console.log(error);
      });
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
    await this.auth.authStateReady();
    if (this.auth.currentUser) {
      this.loggedIn.set(true);
    } else {
      this.loggedIn.set(false);
      this.showLoginMessage.set(true);
      this.login();
    }
  }
}
