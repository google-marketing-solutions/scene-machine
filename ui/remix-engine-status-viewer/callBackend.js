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

async function callCloudRunEndpoint() {
  const executionId = executionIdInput.value.trim();
  if (!executionId || !config.gcsBucket || !config.apiGatewaySettings.apiKey) {
    alert('Could not get Execution ID, GCS Bucket, or API Key.');
    return;
  }
  const cloudRunUrl = `${
    config.apiGatewaySettings.baseUrl
  }/getStatus?api_key=${encodeURIComponent(
    config.apiGatewaySettings.apiKey,
  )}&gcsBucket=${encodeURIComponent(
    config.gcsBucket,
  )}&executionId=${encodeURIComponent(executionId)}`;
  getStatusButton.disabled = true;
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

    let data;
    try {
      data = JSON.parse(responseText); // Try parsing as JSON
      console.log('Response from Cloud Run:', data);
      initializeExecutionData(data);
    } catch (jsonError) {
      console.warn('Response was not valid JSON:', jsonError);
    }
  } catch (error) {
    console.error('Error calling Cloud Run:', error);
  } finally {
    getStatusButton.disabled = false;
  }
}
