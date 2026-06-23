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

import {HttpEvent, HttpHandlerFn, HttpRequest} from '@angular/common/http';
import {Observable, lastValueFrom, of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {env} from '../../env';
import {authTokenInterceptor} from './auth-token.interceptor';

describe('authTokenInterceptor', () => {
  // controlPlaneMode is mutated per test against the real env object; the
  // initial value is captured and restored in afterEach so the rendered
  // (gitignored) src/env.ts value is not leaked between specs.
  const initialMode = env.controlPlaneMode;
  let captured: HttpRequest<unknown> | null;
  let next: HttpHandlerFn;

  beforeEach(() => {
    captured = null;
    next = (req: HttpRequest<unknown>) => {
      captured = req;
      return of({} as HttpEvent<unknown>);
    };
  });

  afterEach(() => {
    env.controlPlaneMode = initialMode;
  });

  // Runs the interceptor and waits for the request to reach `next`, capturing
  // it for header assertions. The interceptor injects nothing now, so no
  // injection context is needed.
  async function run(url: string): Promise<void> {
    const req = new HttpRequest('GET', url);
    await lastValueFrom(
      authTokenInterceptor(req, next) as Observable<HttpEvent<unknown>>,
    );
  }

  it('never touches non-/api/ requests (a stray header breaks Storage CORS)', async () => {
    env.controlPlaneMode = 'iap';
    await run('https://storage.googleapis.com/b/x/o/y?X-Goog-Signature=z');
    expect(captured!.headers.has('X-Requested-With')).toBe(false);
    expect(captured!.headers.has('Authorization')).toBe(false);
  });

  it('iap: forces a 401 (not a 302) on expiry via X-Requested-With', async () => {
    env.controlPlaneMode = 'iap';
    await run('/api/config');
    expect(captured!.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
  });

  it('none (dev): passes /api/ requests through with no auth header', async () => {
    env.controlPlaneMode = 'none';
    await run('/api/config');
    expect(captured!.headers.has('X-Requested-With')).toBe(false);
    expect(captured!.headers.has('Authorization')).toBe(false);
  });
});
