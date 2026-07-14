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

/**
 * Node unit test for the status-viewer response classifier (V4). Run with:
 *   node ui/remix-engine-status-viewer/callBackend.spec.js
 * It exercises pure request construction and response classification (no DOM),
 * so it needs no test harness.
 */
const assert = require('assert');
const {buildStatusUrl, classifyStatusResponse} = require('./callBackend');

assert.strictEqual(
  buildStatusUrl('/api', 'private bucket', 'exec/one', ''),
  '/api/getStatus?gcsBucket=private%20bucket&executionId=exec%2Fone&signUrls=true',
);
assert.strictEqual(
  buildStatusUrl(
    'https://backend.example.com/api',
    'private-bucket',
    'exec two',
    'legacy key+',
  ),
  'https://backend.example.com/api/getStatus?gcsBucket=private-bucket&executionId=exec%20two&signUrls=true&api_key=legacy%20key%2B',
);
assert.strictEqual(
  buildStatusUrl('/api', 'private-bucket', 'exec', 'none'),
  '/api/getStatus?gcsBucket=private-bucket&executionId=exec&signUrls=true',
);

// An IAP login redirect: fetch followed the 302 to an HTML sign-in page, so
// response.redirected is true even though the status is 200.
assert.strictEqual(
  classifyStatusResponse(
    {redirected: true},
    '<!doctype html><title>Sign in</title>',
  ).kind,
  'auth-redirect',
);
// HTML body without the redirected flag is still treated as a login page.
assert.strictEqual(
  classifyStatusResponse(
    {redirected: false},
    '<html><body>Sign in</body></html>',
  ).kind,
  'auth-redirect',
);
// A valid JSON status response.
const ok = classifyStatusResponse({redirected: false}, '{"status":"ok"}');
assert.strictEqual(ok.kind, 'ok');
assert.deepStrictEqual(ok.data, {status: 'ok'});
// A genuinely malformed, non-HTML body is a bad-json error, not auth-redirect.
assert.strictEqual(
  classifyStatusResponse({redirected: false}, 'not json at all').kind,
  'bad-json',
);

console.log('callBackend tests passed ✓');
