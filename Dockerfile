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

# --- Build stage -------------------------------------------------------------
# The full python:3.13 image carries the compilers/headers that a dependency
# without a prebuilt cp313 wheel would need. Install everything into a
# relocatable prefix (/install) that the slim runtime can drop in as-is, so the
# build can never fail for lack of a compiler on the slim base.
FROM python:3.13@sha256:e72bfff2ccf413e3c329074d643fac616d7e1dfe85ac57e527f1d13cd8e0ee6c AS builder

ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.txt

# --- Runtime stage -----------------------------------------------------------
# python:3.13-slim is ~850 MB smaller than the full image: faster to push to the
# registry and faster to cold-start. It carries only ffmpeg, the dependencies
# built above, and the app — no compilers or build cruft.
FROM python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f

ENV PYTHONUNBUFFERED=1

# ffmpeg is required by the worker's video actions (combine/convert). One layer,
# no recommended extras, apt lists dropped to keep the image small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Run as a non-root user with a real home, and give it a writable app dir it
# owns. The worker's video actions write temp files using bare relative names
# into the process CWD (== WORKDIR), so WORKDIR must be owned by this user.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser \
  && mkdir -p /app \
  && chown appuser:appuser /app

WORKDIR /app

# Drop in the dependencies built in the full image (same python 3.13, so the
# installed packages and gunicorn entry point land on /usr/local and PATH).
# Left root-owned and world-readable — import/exec only need read access.
COPY --from=builder /install /usr/local

# Runtime files only (not the whole repo): explicit copies keep docs, examples,
# tests, deploy scripts, and .git out of the image. Root-owned but world-readable
# so imports work without a chown; only the write target (WORKDIR /app) is
# user-owned.
#
# Intentionally NOT copied: creative_templates/ — deploy.sh seeds those to
# Firestore from the build host, and the running backend never reads them.
# deployed_version.txt is stamped by deploy.sh before the build; common.py reads
# it for the API user-agent and tolerates its absence ('unknown').
COPY actions/ actions/
COPY actions_lib/ actions_lib/
COPY util/ util/
COPY *.py ./
COPY deployed_version.txt ./
COPY ui/dist/ ui/dist/
COPY ui/definitions/ ui/definitions/
COPY ui/remix-engine-status-viewer/ ui/remix-engine-status-viewer/

# Drop privileges last, after every step that needs root (apt, the COPYs).
USER appuser

# gunicorn args are env-driven so each service can size them to its workload.
# The defaults suit the I/O-bound 'app' (front door); deploy.sh overrides
# GUNICORN_TIMEOUT for the CPU-bound 'worker'. A FINITE timeout (the previous
# config disabled it entirely) lets gunicorn reap a wedged request thread
# instead of leaking it for the life of the instance; it is set above each
# service's Cloud Run request timeout so a legitimate in-budget request is
# never killed early. (D7)
ENV GUNICORN_WORKERS=1
ENV GUNICORN_THREADS=32
ENV GUNICORN_TIMEOUT=330
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers ${GUNICORN_WORKERS} --threads ${GUNICORN_THREADS} --timeout ${GUNICORN_TIMEOUT} orch:app"]
