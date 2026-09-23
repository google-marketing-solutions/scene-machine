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

# ==============================================================================
# Stage 1: OS Runtime + FFmpeg (Runs concurrently with Stage 2 under BuildKit!)
# ==============================================================================
FROM mirror.gcr.io/library/python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f AS runtime-base

ENV PYTHONUNBUFFERED=1

# Speed up dpkg on Cloud Build disks by disabling per-file fsync() during unpack
# and strictly excluding Debian recommended GUI/X11/Mesa bloat.
RUN echo "force-unsafe-io" > /etc/dpkg/dpkg.cfg.d/docker-apt-speedup \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* /etc/dpkg/dpkg.cfg.d/docker-apt-speedup \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser \
  && mkdir -p /app \
  && chown appuser:appuser /app

# ==============================================================================
# Stage 2: Python Dependency Builder via official Astral uv (digest-pinned)
#          (Executes in ~3-6s *while* Stage 1 is still running apt-get!)
# ==============================================================================
FROM mirror.gcr.io/library/python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f AS venv-builder

COPY --from=ghcr.io/astral-sh/uv:0.6.6@sha256:031ddbc79275e351a43cbb66f64d8cd314cc78c3878898f4ab4f147b092e8e2d /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY requirements.txt .
RUN uv venv /opt/venv \
  && uv pip install --no-cache --only-binary :all: --require-hashes -r requirements.txt

# ==============================================================================
# Stage 3: Final Image Assembly (< 1 second merge)
# ==============================================================================
FROM runtime-base AS final

ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --from=venv-builder /opt/venv /opt/venv


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

# COPY preserves the source files' permission bits, so a build host with a
# restrictive umask (e.g. 027/077, common on corporate machines) copies the code
# in non-world-readable. The non-root appuser would then be unable to read
# /app/orch.py and gunicorn would fail to import it (PermissionError: [Errno 13]).
# Normalize to readable-by-all (capital X adds +x to directories only, not to the
# .py files), independent of the build host's umask. Files stay root-owned, so
# appuser can read but not modify its own code.
RUN chmod -R a+rX /app

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
