"""Behavior tests for firebase/firestore.rules via the Firebase Rules
`projects:test` API. This evaluates the rules SOURCE server-side against
simulated requests — it does NOT deploy or read the live database, so it is
safe to run against any project the caller can access.

Run from the repo root:
    FIREBASE_RULES_TEST_PROJECT=<your-gcp-project> python3 firebase/test/test_firestore_rules.py
Requires `gcloud auth print-access-token` to return a token for that project
(ADC / an authenticated gcloud). Exits non-zero if any expectation fails.
"""
import json, os, subprocess, urllib.request, sys

# This is a standalone script (run directly with python3), not a pytest unit
# test: it calls gcloud and the Firebase Rules API at import time. When pytest
# imports it, skip the whole module so collection never touches gcloud in an
# environment without credentials. Run it directly instead, e.g.
#   FIREBASE_RULES_TEST_PROJECT=<proj> python3 firebase/test/test_firestore_rules.py
if __name__ != "__main__":
    import pytest

    pytest.skip(
        "Firebase rules tests are standalone scripts; run them directly with "
        "python3.",
        allow_module_level=True,
    )

PID = os.environ.get("FIREBASE_RULES_TEST_PROJECT") or subprocess.check_output(
    ["gcloud","config","get-value","project"]).decode().strip()
def tok():
    return subprocess.check_output(["gcloud","auth","print-access-token"]).decode().strip()

rules = open("firebase/firestore.rules").read()

AUTH = {"uid":"user123","token":{}}
def case(exp, method, path, auth=AUTH):
    req = {"path": f"/databases/(default)/documents/{path}", "method": method}
    if auth is not None: req["auth"] = auth
    return {"expectation": exp, "request": req}

cases = [
    # config/global: direct client read DENIED (mediated via GET /api/config),
    # writes DENIED. The client never reads Firestore directly; the backend
    # reads config/global with the Admin SDK, which bypasses these rules.
    case("DENY","get","config/global"),
    case("DENY","update","config/global"),
    case("DENY","create","config/global"),
    case("DENY","delete","config/global"),
    # projects: direct client access DENIED even when authed (mediated via /api)
    case("DENY","get","projects/p1"),
    case("DENY","list","projects/p1"),
    case("DENY","create","projects/p1"),
    case("DENY","update","projects/p1"),
    case("DENY","delete","projects/p1"),
    # creativeTemplates: direct client access DENIED even when authed
    case("DENY","get","creativeTemplates/t1"),
    case("DENY","create","creativeTemplates/t1"),
    case("DENY","update","creativeTemplates/t1"),
    case("DENY","delete","creativeTemplates/t1"),
    # backend-DB collections / arbitrary paths: client access DENIED
    case("DENY","get","executions/e1"),
    case("DENY","update","executions/e1"),
    case("DENY","get","someOtherCollection/x"),
    # unauthenticated: everything denied
    case("DENY","get","config/global", auth=None),
    case("DENY","get","projects/p1", auth=None),
    case("DENY","create","projects/p1", auth=None),
]

body = {"source":{"files":[{"name":"firestore.rules","content":rules}]},
        "testSuite":{"testCases":cases}}
req = urllib.request.Request(
    f"https://firebaserules.googleapis.com/v1/projects/{PID}:test",
    data=json.dumps(body).encode(),
    headers={"Authorization":f"Bearer {tok()}","Content-Type":"application/json","x-goog-user-project":PID})
resp = json.load(urllib.request.urlopen(req))
results = resp.get("testResults",[])
# Fail loudly on a truncated/empty API response: without this, a short results
# list would silently zip to fewer pairs and report "0 passed, 0 failed" (exit
# 0), so the gate would pass while testing nothing.
assert len(results) == len(cases), (
    f"Firebase Rules API returned {len(results)} results for {len(cases)} test "
    f"cases; expected one result per case. Response: {resp}")
ok = 0; fail = 0
for c,r in zip(cases, results):
    state = r.get("state","?")
    label = f'{c["expectation"]:5} {c["request"]["method"]:7} {c["request"]["path"].split("/documents/")[1]:28} auth={"yes" if "auth" in c["request"] else "no "}'
    if state == "SUCCESS": ok+=1; print(f"  PASS  {label}")
    else: fail+=1; print(f"  FAIL  {label}  -> {state}")
print(f"\nFirestore rules (mediated): {ok} passed, {fail} failed (of {len(cases)})")
sys.exit(1 if fail else 0)
