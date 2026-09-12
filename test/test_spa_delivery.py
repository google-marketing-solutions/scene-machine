# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Behavioral tests for the app service's SPA asset delivery policy."""

from test.test_frontdoor import _load_orch
from test.test_frontdoor import orchestrator_module


def test_fingerprinted_angular_javascript_is_immutably_cached(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>index</html>')
  asset = spa_dir / 'main-ABC12345.js'
  asset.write_text('console.log("asset");')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)

  response = orch.app.test_client().get('/main-ABC12345.js')

  assert response.status_code == 200
  assert response.data == asset.read_bytes()
  assert response.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )


def test_fingerprinted_angular_stylesheet_is_immutably_cached(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>index</html>')
  (spa_dir / 'styles-ABC12345.css').write_text('body { color: red; }')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)

  response = orch.app.test_client().get('/styles-ABC12345.css')

  assert response.status_code == 200
  assert response.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )


def test_only_angular_root_fingerprints_receive_long_lived_cache(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>index</html>')
  for filename in (
      'polyfills-12345678.js',
      'chunk-ZYXW9876.js',
      'main-ABC1234.js',
      'main-abc12345.js',
      'app-ABC12345.js',
  ):
    (spa_dir / filename).write_text(filename)
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)
  client = orch.app.test_client()

  for filename in ('polyfills-12345678.js', 'chunk-ZYXW9876.js'):
    response = client.get(f'/{filename}')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == (
        'private, max-age=31536000, immutable'
    )

  for filename in (
      'main-ABC1234.js',
      'main-abc12345.js',
      'app-ABC12345.js',
  ):
    response = client.get(f'/{filename}')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-cache'


def test_spa_entry_and_missing_asset_fallbacks_remain_revalidable(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  index = spa_dir / 'index.html'
  index.write_text('<html>index</html>')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)
  client = orch.app.test_client()

  for path in ('/', '/storyboard/project-1', '/main-ABC12345.js'):
    response = client.get(path)
    assert response.status_code == 200
    assert response.data == index.read_bytes()
    assert response.headers['Cache-Control'] == 'no-cache'


def test_api_404_and_traversal_do_not_receive_asset_cache_policy(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>index</html>')
  outside = tmp_path / 'outside.js'
  outside.write_text('secret')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)
  client = orch.app.test_client()

  api_response = client.get('/api/unknown')
  assert api_response.status_code == 404
  assert 'immutable' not in api_response.headers.get('Cache-Control', '')

  traversal_response = client.get('/%2e%2e/outside.js')
  assert traversal_response.status_code in (200, 404)
  assert traversal_response.data != outside.read_bytes()
  assert 'immutable' not in traversal_response.headers.get('Cache-Control', '')


def test_fingerprinted_asset_retains_conditional_and_range_delivery(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  spa_dir = tmp_path / 'browser'
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>index</html>')
  asset = spa_dir / 'main-ABC12345.js'
  asset.write_bytes(b'0123456789')
  monkeypatch.setattr(orch, '_SPA_DIR', spa_dir)
  client = orch.app.test_client()

  response = client.get('/main-ABC12345.js')
  assert response.status_code == 200
  assert response.headers['ETag']
  assert response.headers['Accept-Ranges'] == 'bytes'
  assert response.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )

  ranged = client.get('/main-ABC12345.js', headers={'Range': 'bytes=2-5'})
  assert ranged.status_code == 206
  assert ranged.data == b'2345'
  assert ranged.headers['Content-Range'] == 'bytes 2-5/10'
  assert ranged.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )

  conditional = client.get(
      '/main-ABC12345.js',
      headers={'If-None-Match': response.headers['ETag']},
  )
  assert conditional.status_code == 304
  assert conditional.data == b''
  assert conditional.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )
