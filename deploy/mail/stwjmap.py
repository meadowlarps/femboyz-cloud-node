#!/usr/bin/env python3
"""Tiny Stalwart JMAP client for the mail runbook (DEPLOYMENT.md section 13).

Credentials never go on the command line: the user comes from STW_USER and
the password is prompted for (or read from STW_PASS when scripting).

  # management call(s); JSON array of JMAP method calls on stdin
  echo '[["x:Domain/get", {}, "a"]]' | ./stwjmap.py call [URL]

  # upload a Sieve script for the logged-in account and (de)activate it
  ./stwjmap.py sieve NAME FILE --activate|--deactivate [URL]

URL defaults to https://mx.femboyz.cloud/jmap/. During bootstrap or recovery
mode use http://172.30.25.10:8080/jmap/ with the recovery admin.
"""
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.request

USING = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    "urn:ietf:params:jmap:sieve",
    "urn:stalwart:jmap",
]


def auth_header():
    user = os.environ.get("STW_USER") or input("Stalwart user: ")
    password = os.environ.get("STW_PASS") or getpass.getpass(f"Password for {user}: ")
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def request(url, auth, data, content_type="application/json"):
    req = urllib.request.Request(
        url, data=data, headers={"Authorization": auth, "Content-Type": content_type}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code}: {err.read().decode()}")


def call(url, auth, calls):
    body = json.dumps({"using": USING, "methodCalls": calls}).encode()
    return request(url, auth, body)


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("call", "sieve"):
        sys.exit(__doc__)

    if args[0] == "call":
        url = args[1] if len(args) > 1 else "https://mx.femboyz.cloud/jmap/"
        calls = json.load(sys.stdin)
        print(json.dumps(call(url, auth_header(), calls)["methodResponses"], indent=1))
        return

    if len(args) < 4 or args[3] not in ("--activate", "--deactivate"):
        sys.exit(__doc__)
    name, path, mode = args[1], args[2], args[3]
    url = args[4] if len(args) > 4 else "https://mx.femboyz.cloud/jmap/"
    base = url.split("/jmap")[0]
    auth = auth_header()

    session = request(base + "/jmap/session", auth, None)
    account = session["primaryAccounts"]["urn:ietf:params:jmap:sieve"]
    with open(path, "rb") as f:
        blob = request(f"{base}/jmap/upload/{account}/", auth, f.read(), "application/sieve")

    existing = call(url, auth, [["SieveScript/get", {"accountId": account}, "g"]])
    script_id = next(
        (s["id"] for s in existing["methodResponses"][0][1]["list"] if s["name"] == name), None
    )
    if script_id:
        change = {"update": {script_id: {"blobId": blob["blobId"]}}}
        ref = script_id
    else:
        change = {"create": {"new": {"name": name, "blobId": blob["blobId"]}}}
        ref = "#new"
    if mode == "--activate":
        change["onSuccessActivateScript"] = ref
    else:
        change["onSuccessDeactivateScript"] = True

    result = call(
        url,
        auth,
        [
            ["SieveScript/validate", {"accountId": account, "blobId": blob["blobId"]}, "v"],
            ["SieveScript/set", {"accountId": account, **change}, "s"],
            ["SieveScript/get", {"accountId": account, "properties": ["name", "isActive"]}, "g"],
        ],
    )
    print(json.dumps(result["methodResponses"], indent=1))


if __name__ == "__main__":
    main()
