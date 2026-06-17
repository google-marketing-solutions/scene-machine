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

"""In-memory stand-in for the narrow Firestore surface util.database uses.

The point of this fake is to let the REAL orchestration code in
util/database.py (input counting, target syncing, once-only sealing) run
unmodified in tests: only the storage layer underneath it is replaced.
The surface implemented is exactly what util/database.py touches:

  - Client.collection().document() / document().collection() paths
  - DocumentReference.get()/.set(merge=...) with Firestore's recursive
    map-merge semantics for merge=True
  - CollectionReference.stream() and .count().get()[0][0].value
  - Client.batch() and Client.transaction()
  - the @firestore.transactional decorator (replaced by
    fake_transactional, which serialises bodies under one lock so the
    sealing semantics are exercised deterministically under threads)

Not implemented (and not used by util/database.py): queries, ordering,
snapshots/listeners, server timestamps, retries.
"""

import copy
import functools
import threading
import types
from typing import Any

# One coarse lock for all fake-Firestore state. util/database.py runs its
# read-modify-write logic inside @firestore.transactional functions; holding
# this lock for the duration of each such function gives the same
# serialisability the real transactions provide.
_LOCK = threading.RLock()


def fake_transactional(func):
  """Replacement for google.cloud.firestore.transactional.

  Runs the decorated function under the global fake-store lock with the
  transaction object passed through, mirroring the real decorator's calling
  convention transaction-first.
  """

  @functools.wraps(func)
  def run_in_transaction(transaction, *args, **kwargs):
    with _LOCK:
      return func(transaction, *args, **kwargs)

  return run_in_transaction


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
  """Applies Firestore merge=True semantics: maps merge recursively."""
  for key, value in source.items():
    if isinstance(value, dict) and isinstance(target.get(key), dict):
      _deep_merge(target[key], value)
    else:
      target[key] = copy.deepcopy(value)


class FakeSnapshot:
  """Read-only view of a document at get() time."""

  def __init__(self, doc_id: str, data: dict[str, Any] | None):
    self.id = doc_id
    self._data = copy.deepcopy(data) if data is not None else None

  @property
  def exists(self) -> bool:
    return self._data is not None

  def to_dict(self) -> dict[str, Any] | None:
    return copy.deepcopy(self._data)


class FakeDocument:
  """DocumentReference equivalent, addressed by a path tuple."""

  def __init__(self, client: 'FakeFirestoreClient', path: tuple[str, ...]):
    self._client = client
    self._path = path

  @property
  def id(self) -> str:
    return self._path[-1]

  def collection(self, name: str) -> 'FakeCollection':
    return FakeCollection(self._client, self._path + (name,))

  def get(self, transaction=None) -> FakeSnapshot:
    del transaction  # reads are immediate; serialisation is via _LOCK
    with _LOCK:
      return FakeSnapshot(self.id, self._client.documents.get(self._path))

  def set(self, data: dict[str, Any], merge: bool = False) -> None:
    with _LOCK:
      if merge and self._path in self._client.documents:
        _deep_merge(self._client.documents[self._path], data)
      else:
        self._client.documents[self._path] = copy.deepcopy(data)


class _FakeAggregationQuery:
  """The .count() handle; .get() returns [[result]] like the real client."""

  def __init__(self, count: int):
    self._count = count

  def get(self):
    return [[types.SimpleNamespace(value=self._count)]]


class FakeCollection:
  """CollectionReference equivalent, addressed by a path tuple."""

  def __init__(self, client: 'FakeFirestoreClient', path: tuple[str, ...]):
    self._client = client
    self._path = path

  def document(self, name: str) -> FakeDocument:
    return FakeDocument(self._client, self._path + (name,))

  def _member_paths(self) -> list[tuple[str, ...]]:
    depth = len(self._path) + 1
    return [
        p
        for p in self._client.documents
        if len(p) == depth and p[: len(self._path)] == self._path
    ]

  def stream(self):
    with _LOCK:
      paths = sorted(self._member_paths())
      return [
          FakeSnapshot(p[-1], self._client.documents[p]) for p in paths
      ]

  def count(self) -> _FakeAggregationQuery:
    with _LOCK:
      return _FakeAggregationQuery(len(self._member_paths()))


class FakeBatch:
  """WriteBatch equivalent: buffers set() calls, applies them on commit."""

  def __init__(self):
    self._writes: list[tuple[FakeDocument, dict[str, Any]]] = []

  def set(self, ref: FakeDocument, data: dict[str, Any]) -> None:
    self._writes.append((ref, data))

  def commit(self) -> None:
    with _LOCK:
      for ref, data in self._writes:
        ref.set(data)
      self._writes.clear()


class FakeTransaction:
  """Transaction equivalent; writes apply immediately under _LOCK.

  fake_transactional holds _LOCK for the whole decorated body, so the
  read-then-write sequences in util/database.py are atomic with respect to
  each other, which is the property the sealing logic relies on.
  """

  def __init__(self, client: 'FakeFirestoreClient'):
    self._client = client

  def set(
      self, ref: FakeDocument, data: dict[str, Any], merge: bool = False
  ) -> None:
    ref.set(data, merge=merge)


class FakeFirestoreClient:
  """Drop-in for google.cloud.firestore.Client over an in-memory dict."""

  def __init__(self, database: str | None = None, **kwargs: Any):
    del kwargs
    self.database = database
    # path tuple (collection, doc[, subcollection, doc]) -> document data
    self.documents: dict[tuple[str, ...], dict[str, Any]] = {}

  def collection(self, name: str) -> FakeCollection:
    return FakeCollection(self, (name,))

  def batch(self) -> FakeBatch:
    return FakeBatch()

  def transaction(self, max_attempts: int = 5) -> FakeTransaction:
    del max_attempts
    return FakeTransaction(self)
