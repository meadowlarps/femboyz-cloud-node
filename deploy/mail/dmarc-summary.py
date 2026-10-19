#!/usr/bin/env python3
"""Summarise received DMARC aggregate reports (DEPLOYMENT.md 16.3).

  STW_TOKEN=- ./dmarc-summary.py [DAYS] [URL]

Stalwart parses reports sent to its inboundReportAddresses (dmarc@* and
postmaster@* here) into x:DmarcExternalReport objects. This prints one line per
reporter and sending IP: messages, and how many passed DKIM / SPF alignment.
Anything that isn't 167.233.218.194 is either forwarding or someone spoofing
femboyz.cloud. Tighten the DMARC policy only once our own IP passes everywhere.
"""
import collections
import datetime
import sys

from stwjmap import auth_header, call

OUR_IP = "167.233.218.194"


def items(value):
    """Stalwart sends List values as maps keyed "0", "1", ..."""
    if isinstance(value, dict):
        return [value[k] for k in sorted(value, key=int)]
    return value or []


def main():
    args = sys.argv[1:]
    days = int(args[0]) if args and args[0].isdigit() else 14
    url = next((a for a in args if a.startswith("http")), "https://mx.femboyz.cloud/jmap/")
    since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)

    responses = call(url, auth_header(), [
        ["x:DmarcExternalReport/query", {"limit": 1000}, "q"],
        ["x:DmarcExternalReport/get", {"#ids": {"resultOf": "q", "name": "x:DmarcExternalReport/query", "path": "/ids"}}, "g"],
    ])["methodResponses"]
    reports = responses[1][1].get("list", [])

    rows = collections.defaultdict(lambda: [0, 0, 0])
    used = 0
    for entry in reports:
        report = entry["report"]
        if datetime.datetime.fromisoformat(report["dateRangeEnd"].replace("Z", "+00:00")) < since:
            continue
        used += 1
        for record in items(report.get("records")):
            row = rows[(report["orgName"], record.get("sourceIp") or "?")]
            row[0] += record["count"]
            row[1] += record["count"] if record.get("evaluatedDkim") == "pass" else 0
            row[2] += record["count"] if record.get("evaluatedSpf") == "pass" else 0

    print(f"{used} reports in the last {days} days ({len(reports)} stored)\n")
    print(f"{'reporter':<28} {'source ip':<18} {'msgs':>6} {'dkim ok':>8} {'spf ok':>7}")
    for (org, ip), (count, dkim, spf) in sorted(rows.items(), key=lambda kv: -kv[1][0]):
        mark = "" if ip == OUR_IP else "  <- not us"
        print(f"{org[:28]:<28} {ip:<18} {count:>6} {dkim:>8} {spf:>7}{mark}")


if __name__ == "__main__":
    main()
