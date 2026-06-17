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
 * Resolves the base URL the status endpoint lives under.
 *
 * Front-door topology: the control plane is served same-origin under `/api`,
 * so the base is relative (the deploy writes `backendApi.baseUrl` as `/api`).
 * If the field is empty or omitted we fall back to `/api` served same-origin.
 *
 * For robustness we still accept an absolute base with a real host (e.g.
 * `https://backend.example.com`) and keep it verbatim, so a deployment that
 * fronts the backend elsewhere keeps working.
 *
 * @return {string} The base URL to prefix `/getStatus` with (no trailing slash).
 */
function resolveStatusBaseUrl() {
  const raw = (config.backendApi && config.backendApi.baseUrl)
    ? String(config.backendApi.baseUrl).trim()
    : '';
  if (!raw) {
    return '/api';
  }
  // Already a relative/same-origin path (front door): use as-is.
  if (raw.startsWith('/')) {
    return raw.replace(/\/+$/, '');
  }
  // Empty-authority URL such as `https:///api` — an older deploy baked this when
  // the host was left empty (the current deploy writes a plain `/api`, handled
  // above). Note we must NOT pass this to `new URL()`: the parser collapses the
  // empty authority and mis-reads the first path segment as the host
  // (`https:///api` -> host `api`). Match `<scheme>://` immediately followed by
  // `/` (or end) and keep the path, served same-origin.
  const emptyAuthority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(\/.*)?$/i);
  if (emptyAuthority) {
    const path = (emptyAuthority[1] || '').replace(/\/+$/, '');
    return path || '/api';
  }
  // A real absolute host is present: keep the absolute URL verbatim.
  return raw.replace(/\/+$/, '');
}

/**
 * Returns the legacy `&api_key=...` query fragment, or '' when no real key is
 * configured. The front-door config carries a sentinel ('none'/empty) which we
 * must NOT send — the same-origin control plane has no api key.
 *
 * @return {string} `&api_key=<encoded>` for a legacy key, otherwise ''.
 */
function statusApiKeyParam() {
  const apiKey = config.backendApi && config.backendApi.apiKey
    ? String(config.backendApi.apiKey).trim()
    : '';
  if (!apiKey || apiKey.toLowerCase() === 'none') {
    return '';
  }
  return `&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Classifies a /getStatus response body. After an IAP session expires, IAP
 * answers with a 302 to the Google sign-in page; fetch follows it to a 200 HTML
 * page, so `response.ok` is true and JSON.parse throws on the HTML. This
 * distinguishes that "session expired" case from a genuinely malformed JSON
 * body, so the caller can prompt re-auth instead of failing silently. (V4)
 *
 * @param {{redirected?: boolean}} response The fetch Response.
 * @param {string} text The response body text.
 * @return {{kind: string, data: object}} kind is 'auth-redirect', 'ok', or
 *     'bad-json'; data holds the parsed JSON only when kind is 'ok'.
 */
function classifyStatusResponse(response, text) {
  if (response.redirected || /^\s*<(?:!doctype|html)/i.test(text)) {
    return {kind: 'auth-redirect'};
  }
  try {
    return {kind: 'ok', data: JSON.parse(text)};
  } catch (jsonError) {
    return {kind: 'bad-json'};
  }
}

async function callCloudRunEndpoint() {
  const executionId = executionIdInput.value.trim();
  if (!executionId || !config.gcsBucket) {
    alert('Could not get Execution ID or GCS Bucket.');
    return;
  }
  const cloudRunUrl = `${resolveStatusBaseUrl()}/getStatus?gcsBucket=${encodeURIComponent(
    config.gcsBucket,
  )}&executionId=${encodeURIComponent(executionId)}${statusApiKeyParam()}`;
  getStatusButton.disabled = true;
  // Served same-origin behind IAP: the default same-origin credentials carry the
  // IAP session cookie automatically, so no auth header is needed here.
  const options = {
    method: 'GET',
  };

  try {
    const response = await fetch(cloudRunUrl, options);
    const responseText = await response.text(); // Get text first to show in case of JSON parse error

    if (!response.ok) {
      throw new Error(
        `HTTP error! status: ${response.status} - ${response.statusText}. Body: ${responseText}`,
      );
    }

    const classified = classifyStatusResponse(response, responseText);
    if (classified.kind === 'auth-redirect') {
      // The IAP session expired: fetch followed the login redirect to an HTML
      // sign-in page (200 OK). Prompt re-auth instead of failing silently. (V4)
      alert('Your session has expired. Reload the page to sign in again.');
      return;
    }
    if (classified.kind === 'bad-json') {
      console.warn('Response was not valid JSON:', responseText);
      alert('Could not read the status response. See the console for details.');
      return;
    }
    console.log('Response from Cloud Run:', classified.data);
    initializeExecutionData(classified.data);
  } catch (error) {
    console.error('Error calling Cloud Run:', error);
  } finally {
    getStatusButton.disabled = false;
  }
}

// Exported for the Node unit test (callBackend.spec.js). In the browser the
// status viewer loads this as a plain <script>, where `module` is undefined, so
// this guard is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {classifyStatusResponse};
}
