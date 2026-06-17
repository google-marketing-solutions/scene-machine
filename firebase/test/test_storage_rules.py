"""Behavior tests for firebase/storage.rules via the Firebase Rules
`projects:test` API. Evaluates the rules SOURCE server-side against simulated
requests — does NOT deploy or touch the live bucket. Run from the repo root:
    FIREBASE_RULES_TEST_PROJECT=<your-gcp-project> python3 firebase/test/test_storage_rules.py
Requires an authenticated gcloud. Exits non-zero if any expectation fails.
"""
import json, subprocess, urllib.request, sys, os

# This is a standalone script (run directly with python3), not a pytest unit
# test: it calls gcloud and the Firebase Rules API at import time. When pytest
# imports it, skip the whole module so collection never touches gcloud in an
# environment without credentials. Run it directly instead, e.g.
#   FIREBASE_RULES_TEST_PROJECT=<proj> python3 firebase/test/test_storage_rules.py
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
rules = open("firebase/storage.rules").read()
AUTH = {"uid":"user123","token":{}}
def case(exp, method, path, auth=AUTH):
    req = {"path": f"/b/{PID}-scene-machine/o/{path}", "method": method}
    if auth is not None: req["auth"] = auth
    return {"expectation": exp, "request": req}
cases = [
    # All client Storage access is denied (deny-all rules). Reads go through
    # server-signed GET URLs, which bypass these rules, so there is no signed-in
    # read allowance to keep — every direct client read is DENIED.
    case("DENY","get","generate_video/abc/sample_0.mp4"),
    case("DENY","get","combine_video/abc/output.mp4"),
    case("DENY","get","generate_storyboard/abc/storyboard.json"),
    case("DENY","get","outpaint_image/abc/x.png"),
    case("DENY","get","examples/CatSofa.png"),
    case("DENY","get","remix-input/x.txt"),
    case("DENY","get","thumbnail/x.png"),
    # client writes to remix-input + thumbnail: DENIED even authed (mediated via /api)
    case("DENY","create","remix-input/img.png"),
    case("DENY","update","remix-input/img.png"),
    case("DENY","create","thumbnail/t.png"),
    # client writes to backend-output prefixes: still DENIED
    case("DENY","create","generate_video/abc/sample_0.mp4"),
    case("DENY","update","combine_video/abc/output.mp4"),
    case("DENY","delete","generate_video/abc/sample_0.mp4"),
    case("DENY","create","examples/evil.png"),
    case("DENY","create","some_other_prefix/x"),
    # unauthenticated: denied everywhere
    case("DENY","get","remix-input/x.txt", auth=None),
    case("DENY","create","remix-input/x.txt", auth=None),
]
body = {"source":{"files":[{"name":"storage.rules","content":rules}]},"testSuite":{"testCases":cases}}
req = urllib.request.Request(f"https://firebaserules.googleapis.com/v1/projects/{PID}:test",
    data=json.dumps(body).encode(),
    headers={"Authorization":f"Bearer {tok()}","Content-Type":"application/json","x-goog-user-project":PID})
results = json.load(urllib.request.urlopen(req)).get("testResults",[])
# Fail loudly on a truncated/empty API response: without this, a short results
# list would silently zip to fewer pairs and report "0 passed, 0 failed" (exit
# 0), so the gate would pass while testing nothing.
assert len(results) == len(cases), (
    f"Firebase Rules API returned {len(results)} results for {len(cases)} test "
    f"cases; expected one result per case.")
ok=fail=0
for c,r in zip(cases,results):
    st=r.get("state","?")
    lbl=f'{c["expectation"]:5} {c["request"]["method"]:7} {c["request"]["path"].split("/o/")[1]:42} auth={"yes" if "auth" in c["request"] else "no "}'
    if st=="SUCCESS": ok+=1; print(f"  PASS  {lbl}")
    else: fail+=1; print(f"  FAIL  {lbl} -> {st}")
print(f"\nStorage rules (mediated): {ok} passed, {fail} failed (of {len(cases)})")
sys.exit(1 if fail else 0)
