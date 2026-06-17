"""Static intent checks for the Firebase security rules.

Unlike firebase/test/test_firestore_rules.py and test_storage_rules.py — which
call the Firebase Rules `projects:test` API and therefore need gcloud creds and
a project (so they only run in CI with secrets) — this module only READS the
two rules text files and makes string assertions. It has no firebase deps, no
network, and no secrets, so it is collected and runs in a normal `pytest` pass.

It encodes the data-plane's intended invariants for the mediated (IAP-only)
model, so a regression that re-opens client write access (or widens the
client-readable config surface) fails here, in every PR, with no infra:

  * Firestore: NO broad authenticated WRITE and NO broad authenticated READ
    (clients never touch Firestore directly; all access goes through the app
    backend's Admin SDK, which bypasses these rules).
  * Storage: NO authenticated WRITE rule AND NO authenticated READ rule
    (uploads use server-signed PUT URLs and reads use server-signed GET URLs,
    both of which bypass these rules). All client Storage access is denied.
  * Firestore config: NO `config/*` doc is client-readable. The client reads
    global config only via GET /api/config (the backend reads config/global with
    the Admin SDK); the server-only `config/access` email allow-list is never
    exposed either. All direct client config access is denied.
"""
import pathlib
import re

_REPO = pathlib.Path(__file__).resolve().parent.parent
_FIRESTORE_RULES = _REPO / "firebase" / "firestore.rules"
_STORAGE_RULES = _REPO / "firebase" / "storage.rules"


def _strip_comments(text):
  """Drop `//` line comments so a commented-out rule can't satisfy a check."""
  return "\n".join(line.split("//", 1)[0] for line in text.splitlines())


def _normalize(text):
  """Collapse all runs of whitespace to single spaces so the assertions are
  robust to indentation / line-wrapping differences in the rules files."""
  return re.sub(r"\s+", " ", _strip_comments(text)).strip()


def _read_normalized(path):
  assert path.is_file(), f"expected rules file not found: {path}"
  return _normalize(path.read_text())


def test_firestore_has_no_broad_authenticated_write():
  """No `allow write: if request.auth != null` (in any allow form that grants
  write to any signed-in user). Clients must not write Firestore directly."""
  rules = _read_normalized(_FIRESTORE_RULES)
  # Match an allow-clause that grants write (write / read, write / write, read)
  # to the bare signed-in condition `request.auth != null`.
  broad_write = re.compile(
      r"allow\s+[^;{}]*\bwrite\b[^;{}]*:\s*if\s+request\.auth\s*!=\s*null")
  match = broad_write.search(rules)
  assert match is None, (
      "firestore.rules grants WRITE to any authenticated user "
      f"({match.group(0)!r}); the mediated model forbids direct client writes.")


def test_firestore_has_no_broad_authenticated_read():
  """No `allow read: if request.auth != null`. The catch-all denies all client
  reads (`if false`); a regression reverting it to the bare signed-in condition
  would re-expose projects, creativeTemplates, execution-state collections and
  the server-only config/access list to any IAP-admitted user. Clients read only
  via the backend's Admin SDK, which bypasses these rules."""
  rules = _read_normalized(_FIRESTORE_RULES)
  # Match an allow-clause that grants read (read alone, or read paired with
  # write in either order) to the bare signed-in condition `request.auth !=
  # null`, with or without parentheses around the condition. Mirrors
  # test_storage_has_no_authenticated_read.
  broad_read = re.compile(
      r"allow\s+[^;{}]*\bread\b[^;{}]*:\s*if\s+\(?\s*request\.auth\s*!=\s*null")
  match = broad_read.search(rules)
  assert match is None, (
      "firestore.rules grants READ to any authenticated user "
      f"({match.group(0)!r}); the mediated model forbids direct client reads.")


def test_storage_has_no_authenticated_write():
  """Storage rules must contain NO write allow-rule at all — uploads go through
  server-signed URLs, which bypass these rules."""
  rules = _read_normalized(_STORAGE_RULES)
  write_rule = re.compile(r"allow\s+[^;{}]*\bwrite\b[^;{}]*:\s*if\s+(?!false\b)")
  match = write_rule.search(rules)
  assert match is None, (
      "storage.rules contains a write allow-rule "
      f"({match.group(0)!r}); uploads must use server-signed URLs, so no client "
      "write rule should exist.")


def test_storage_has_no_authenticated_read():
  """Storage rules must contain NO `allow read: if request.auth != null` — the
  transitional signed-in READ is removed. Clients never read Storage directly;
  all reads go through server-signed GET URLs, which bypass these rules. The
  pattern is matched against whitespace-normalized text so it is robust to
  indentation / line-wrapping."""
  rules = _read_normalized(_STORAGE_RULES)
  # Match any allow-clause that grants read to the bare signed-in condition
  # `request.auth != null` (read alone, or read paired with write in either
  # order).
  read_rule = re.compile(
      r"allow\s+[^;{}]*\bread\b[^;{}]*:\s*if\s+request\.auth\s*!=\s*null")
  match = read_rule.search(rules)
  assert match is None, (
      "storage.rules grants READ to any authenticated user "
      f"({match.group(0)!r}); client reads must go through server-signed GET "
      "URLs, so no signed-in read rule should exist.")


def test_firestore_has_no_client_readable_config():
  """NO `config/*` doc is client-readable. The client reads global config only
  through GET /api/config (the backend reads config/global with the Admin SDK,
  bypassing these rules), so the rules must not grant read on any config path —
  not config/global, not a `config/{id}` wildcard, and not the server-only
  config/access email allow-list. Any read allowance under config/ is a leak."""
  rules = _read_normalized(_FIRESTORE_RULES)
  # A dedicated `match /config/...` block must not exist: such a block can only
  # serve to grant client access to config, which is fully mediated now.
  config_blocks = re.findall(r"match\s+(/config/[^\s{]+|/config/\{[^}]+\})",
                             rules)
  assert not config_blocks, (
      "firestore.rules has a /config/... match block "
      f"({config_blocks!r}); config is mediated via GET /api/config now, so no "
      "config match block should exist. The catch-all denies all config access.")
  # Belt-and-braces: no `allow read` anywhere whose path scope is config/.
  # Catch a read granted directly in a config match (in case the path regex
  # above is dodged by a differently-shaped block).
  config_read = re.compile(
      r"match\s+/config/[^{]*\{[^}]*allow\s+[^;{}]*\bread\b", re.DOTALL)
  match = config_read.search(rules)
  assert match is None, (
      "firestore.rules grants client READ under config/ "
      f"({match.group(0)!r}); config is read only via GET /api/config, so no "
      "client config read should exist.")
