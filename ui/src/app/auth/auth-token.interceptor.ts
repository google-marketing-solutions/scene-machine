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

import {HttpInterceptorFn} from '@angular/common/http';
import {env} from '../../env';

/**
 * Attaches control-plane auth headers to same-origin `/api/` requests.
 *
 * - `iap`: `X-Requested-With: XMLHttpRequest` (forces IAP to respond 401
 *   instead of 302 on session expiry).
 * - `none` (dev): pass-through, no auth header.
 *
 * Requests outside `/api/` are NEVER touched — the same HttpClient fetches
 * signed GCS URLs, where a stray header breaks CORS.
 */
export const authTokenInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) {
    return next(req);
  }
  if (env.controlPlaneMode === 'iap') {
    return next(
      req.clone({setHeaders: {'X-Requested-With': 'XMLHttpRequest'}}),
    );
  }
  return next(req);
};
