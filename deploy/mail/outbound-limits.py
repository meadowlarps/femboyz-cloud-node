#!/usr/bin/env python3
"""Outbound limits for femboyz.cloud senders (DEPLOYMENT.md 16.1). Idempotent.

  STW_TOKEN=- ./outbound-limits.py [URL]           # apply, then print the result
  STW_TOKEN=- ./outbound-limits.py --show [URL]    # print only

Counts recipients, not messages, per logged-in account (JMAP submission from
webmail and SMTP submission alike; Stalwart runs both through the RCPT stage).
noreply@ is exempt: the API rate-limits what it sends. Accounts on the
`femboyz-new-senders` list, which the API keeps in step with account age
(MAIL_NEW_SENDER_DAYS), also get the stricter tier. Over a limit, Stalwart
answers `452 4.4.5 Rate limit exceeded` for that recipient and webmail names it.
Throttles are matched to existing ones by description, so rerunning updates them.
"""
import json
import sys

from stwjmap import auth_header, call

NEW_SENDERS = "femboyz-new-senders"
MAX_RECIPIENTS = 25
HOUR, DAY = 3600_000, 86400_000

SENDER = "!is_empty(rcpt) && !is_empty(authenticated_as) && authenticated_as != 'noreply@femboyz.cloud'"
NEW_SENDER = f"!is_empty(rcpt) && key_exists('{NEW_SENDERS}', authenticated_as)"

THROTTLES = [
    ("femboyz: recipients per sender per hour", SENDER, 60, HOUR),
    ("femboyz: recipients per sender per day", SENDER, 300, DAY),
    ("femboyz: recipients per new sender per hour", NEW_SENDER, 20, HOUR),
    ("femboyz: recipients per new sender per day", NEW_SENDER, 100, DAY),
]

# Inbound mail from other servers keeps Stalwart's default of 100.
RCPT_STAGE = {
    "maxRecipients": {
        "match": {"0": {"if": "!is_empty(authenticated_as)", "then": str(MAX_RECIPIENTS)}},
        "else": "100",
    }
}


def throttle_object(description, match, count, period):
    return {
        "enable": True,
        "description": description,
        "key": {"authenticatedAs": True},
        "match": {"match": {}, "else": match},
        "rate": {"count": count, "period": period},
    }


def results(url, auth, calls):
    responses = call(url, auth, calls)["methodResponses"]
    for name, result, _ in responses:
        if name == "error" or any(result.get(k) for k in ("notCreated", "notUpdated", "notDestroyed")):
            sys.exit(f"Stalwart refused {name}: {json.dumps(result)}")
    return responses


def show(url, auth):
    throttles, rcpt = results(url, auth, [
        ["x:MtaInboundThrottle/get", {}, "t"],
        ["x:MtaStageRcpt/get", {"ids": ["singleton"], "properties": ["maxRecipients"]}, "r"],
    ])
    for t in throttles[1]["list"]:
        state = "on " if t["enable"] else "off"
        print(f"{state} {t['rate']['count']:>4} / {t['rate']['period'] // 1000:>6}s  {t['description']}")
        print(f"     key {sorted(k for k, v in t['key'].items() if v)}  match {t['match']['else']}")
    print("maxRecipients", json.dumps(rcpt[1]["list"][0]["maxRecipients"]))


def main():
    args = sys.argv[1:]
    show_only = "--show" in args
    args = [a for a in args if a != "--show"]
    url = args[0] if args else "https://mx.femboyz.cloud/jmap/"
    auth = auth_header()

    if not show_only:
        existing = results(url, auth, [["x:MtaInboundThrottle/get", {"properties": ["description"]}, "t"]])
        by_description = {t["description"]: t["id"] for t in existing[0][1]["list"]}
        create, update = {}, {}
        for index, spec in enumerate(THROTTLES):
            obj = throttle_object(*spec)
            if spec[0] in by_description:
                del obj["description"]  # read-only once created
                update[by_description[spec[0]]] = obj
            else:
                create[f"t{index}"] = obj
        results(url, auth, [
            ["x:MtaInboundThrottle/set", {"create": create, "update": update}, "t"],
            ["x:MtaStageRcpt/set", {"update": {"singleton": RCPT_STAGE}}, "r"],
            ["x:Action/set", {"create": {"a": {"@type": "ReloadSettings"}}}, "a"],
        ])
        print(f"Applied: {len(create)} created, {len(update)} updated, settings reloaded.\n")

    show(url, auth)


if __name__ == "__main__":
    main()
