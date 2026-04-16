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

"""Deletes the contents of the specified database in Firestore."""

from concurrent import futures
from google.cloud import firestore

db = firestore.Client(database='...')


def delete_doc(doc: firestore.DocumentSnapshot) -> None:
  doc.reference.delete()


with futures.ThreadPoolExecutor(max_workers=16) as executor:
  for coll_ref in db.collections():
    print(coll_ref.id)
    docs = coll_ref.stream()
    for _ in executor.map(delete_doc, docs):
      pass
