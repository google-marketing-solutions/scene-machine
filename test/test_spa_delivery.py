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

import gzip
import json

from test.test_frontdoor import _load_orch
from test.test_frontdoor import orchestrator_module
from test.test_frontdoor_data import _IAP_AUDIENCE
from test.test_frontdoor_data import _load_app


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


def _write_compressible_spa(spa_dir):
  spa_dir.mkdir()
  (spa_dir / 'index.html').write_text('<html>' + ('index ' * 200) + '</html>')
  asset = spa_dir / 'main-ABC12345.js'
  asset.write_text('console.log("asset");\n' * 200)
  return asset


def test_spa_gzip_negotiation_round_trips_and_varies(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')
  asset = _write_compressible_spa(tmp_path / 'browser')
  monkeypatch.setattr(orch, '_SPA_DIR', asset.parent)

  response = orch.app.test_client().get(
      '/main-ABC12345.js', headers={'Accept-Encoding': 'gzip'}
  )

  assert response.status_code == 200
  assert response.headers['Content-Encoding'] == 'gzip'
  assert gzip.decompress(response.data) == asset.read_bytes()
  assert response.headers['Vary'] == 'Accept-Encoding'
  assert response.headers['Cache-Control'] == (
      'private, max-age=31536000, immutable'
  )


def test_spa_does_not_compress_when_gzip_is_unacceptable_or_unspecified(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')
  asset = _write_compressible_spa(tmp_path / 'browser')
  monkeypatch.setattr(orch, '_SPA_DIR', asset.parent)
  client = orch.app.test_client()

  for headers in (
      {'Accept-Encoding': 'gzip;q=0'},
      {'Accept-Encoding': ''},
  ):
    response = client.get('/main-ABC12345.js', headers=headers)
    assert response.status_code == 200
    assert response.headers.get('Content-Encoding') is None
    assert response.data == asset.read_bytes()
    assert response.headers['Vary'] == 'Accept-Encoding'


def test_spa_does_not_double_compress_an_existing_encoding(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')
  asset = _write_compressible_spa(tmp_path / 'browser')
  monkeypatch.setattr(orch, '_SPA_DIR', asset.parent)
  preencoded = orch.flask_response(
      b'precompressed' * 100, status=200, mimetype='application/javascript'
  )
  preencoded.headers['Content-Encoding'] = 'gzip'
  monkeypatch.setattr(orch, 'send_from_directory', lambda *_a, **_k: preencoded)

  response = orch.app.test_client().get(
      '/main-ABC12345.js', headers={'Accept-Encoding': 'gzip'}
  )

  assert response.data == b'precompressed' * 100
  assert response.headers['Content-Encoding'] == 'gzip'


def test_spa_compression_preserves_conditional_and_range_semantics(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')
  asset = _write_compressible_spa(tmp_path / 'browser')
  monkeypatch.setattr(orch, '_SPA_DIR', asset.parent)
  client = orch.app.test_client()

  compressed = client.get(
      '/main-ABC12345.js', headers={'Accept-Encoding': 'gzip'}
  )
  assert compressed.headers['Content-Encoding'] == 'gzip'
  conditional = client.get(
      '/main-ABC12345.js',
      headers={
          'Accept-Encoding': 'gzip',
          'If-None-Match': compressed.headers['ETag'],
      },
  )
  assert conditional.status_code == 304
  assert conditional.data == b''
  assert conditional.headers['ETag'] == compressed.headers['ETag']

  ranged = client.get(
      '/main-ABC12345.js',
      headers={'Accept-Encoding': 'gzip', 'Range': 'bytes=2-5'},
  )
  assert ranged.status_code == 206
  assert ranged.data == asset.read_bytes()[2:6]
  assert ranged.headers.get('Content-Encoding') is None
  assert ranged.headers['Content-Range'] == f'bytes 2-5/{asset.stat().st_size}'


def test_spa_html_is_compressed_but_remains_revalidable(
    monkeypatch, orchestrator_module, tmp_path
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')
  asset = _write_compressible_spa(tmp_path / 'browser')
  monkeypatch.setattr(orch, '_SPA_DIR', asset.parent)

  response = orch.app.test_client().get(
      '/', headers={'Accept-Encoding': 'gzip'}
  )

  assert response.status_code == 200
  assert response.headers['Content-Encoding'] == 'gzip'
  assert (
      gzip.decompress(response.data)
      == (asset.parent / 'index.html').read_bytes()
  )
  assert response.headers['Cache-Control'] == 'no-cache'


def _populate_large_project(fake_db, orch):
  project_id = 'project-compression'
  fake_db.collection('projects').docs[project_id] = {
      'id': project_id,
      'name': 'Project compression',
      'createdBy': None,
      'storyboard': [],
  }
  scene = {
      'id': 'scene-1',
      'name': 'Scene 1',
      'type': 'generated',
      'lowQualityThumbnail': 'data:image/png;base64,' + ('a' * 2000),
      'candidates': [
          {
              'runNumber': index,
              'prompt': 'A repeated prompt ' * 30,
              'video': {'path': f'videos/{index}.mp4'},
          }
          for index in range(8)
      ],
      'selectedCandidateIndex': 2,
  }
  fake_db.collection('projects').subcollection(
      project_id, orch._SCENES_SUBCOLLECTION
  ).docs[orch._scene_doc_id(0)] = scene


def test_project_gets_compress_only_successful_json_and_round_trip(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch, fake_db, _ = _load_app(monkeypatch)
  _populate_large_project(fake_db, orch)
  real_json_response = orch._json_response

  def _json_response_with_cache(*args, **kwargs):
    response = real_json_response(*args, **kwargs)
    response.headers['Cache-Control'] = 'private, max-age=60'
    return response

  monkeypatch.setattr(orch, '_json_response', _json_response_with_cache)
  client = orch.app.test_client()

  for path in ('/api/projects', '/api/projects/project-compression'):
    response = client.get(path, headers={'Accept-Encoding': 'gzip'})
    assert response.status_code == 200
    assert response.headers['Content-Encoding'] == 'gzip'
    body = json.loads(gzip.decompress(response.data))
    if path == '/api/projects':
      assert [project['id'] for project in body['projects']] == [
          'project-compression'
      ]
    else:
      assert body['id'] == 'project-compression'
    assert response.headers['Vary'] == 'Accept-Encoding'
    assert response.headers['Cache-Control'] == 'private, max-age=60'


def test_compression_stays_within_successful_get_allowlist(
    monkeypatch, orchestrator_module
):
  del orchestrator_module
  orch = _load_orch(monkeypatch, ROLE='app', WORKER_URL='https://worker.test')

  orch.app.add_url_rule(
      '/compression-excluded-json',
      endpoint='compression_excluded_json',
      view_func=lambda: orch.flask_response(
          'x' * 1000, mimetype='application/json'
      ),
      methods=['GET'],
  )
  orch.app.add_url_rule(
      '/compression-excluded-post',
      endpoint='compression_excluded_post',
      view_func=lambda: orch.flask_response(
          'x' * 1000, mimetype='application/json'
      ),
      methods=['POST'],
  )
  orch.app.add_url_rule(
      '/compression-excluded-status',
      endpoint='compression_excluded_status',
      view_func=lambda: orch.flask_response(
          'x' * 1000, status=404, mimetype='application/json'
      ),
      methods=['GET'],
  )
  orch.app.add_url_rule(
      '/compression-excluded-mime',
      endpoint='compression_excluded_mime',
      view_func=lambda: orch.flask_response('x' * 1000, mimetype='text/plain'),
      methods=['GET'],
  )

  client = orch.app.test_client()
  for method, path in (
      ('get', '/compression-excluded-json'),
      ('post', '/compression-excluded-post'),
      ('get', '/compression-excluded-status'),
      ('get', '/compression-excluded-mime'),
  ):
    response = getattr(client, method)(
        path, headers={'Accept-Encoding': 'gzip'}
    )
    assert response.headers.get('Content-Encoding') is None
    assert response.headers.get('Vary') is None

  # Exercise each guard after the endpoint allow-list has matched. These
  # responses are intentionally over the 500-byte threshold.
  monkeypatch.setitem(
      orch.app.view_functions,
      'projects_handler',
      lambda: orch.flask_response('x' * 1000, mimetype='application/json'),
  )
  post_response = client.post(
      '/api/projects', headers={'Accept-Encoding': 'gzip'}
  )
  assert post_response.status_code == 200
  assert post_response.headers.get('Content-Encoding') is None
  assert post_response.headers.get('Vary') is None

  for status, mimetype in ((404, 'application/json'), (200, 'text/plain')):
    monkeypatch.setitem(
        orch.app.view_functions,
        'spa_handler',
        lambda path='', status=status, mimetype=mimetype: orch.flask_response(
            'x' * 1000, status=status, mimetype=mimetype
        ),
    )
    response = client.get(
        '/compression-guard', headers={'Accept-Encoding': 'gzip'}
    )
    assert response.status_code == status
    assert response.headers.get('Content-Encoding') is None


def test_iap_auth_error_is_not_compressed(monkeypatch, orchestrator_module):
  del orchestrator_module
  orch = _load_orch(
      monkeypatch,
      ROLE='app',
      AUTH_MODE='iap',
      IAP_AUDIENCE=_IAP_AUDIENCE,
      WORKER_URL='https://worker.test',
  )

  response = orch.app.test_client().get(
      '/api/projects', headers={'Accept-Encoding': 'gzip'}
  )

  assert response.status_code == 401
  assert response.headers.get('Content-Encoding') is None
