#!/usr/bin/env python3
"""Copy Stalwart's blobs from its RocksDB data store into an S3 blob store
(DEPLOYMENT.md 16.5). Run it with Stalwart stopped.

  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
    blobs-to-s3.py DB_DIR ENDPOINT BUCKET [--region R] [--prefix P] [--dry-run]

DB_DIR is the RocksDB directory (the stalwart_data volume). It must have been
flushed first: Stalwart leaves recent writes in the write-ahead log on
shutdown, and that log holds Merge records that only Stalwart's merge operator
can replay. RocksDB here would silently stop replaying at the first one and
miss every later blob. So after stopping Stalwart, start the same image once
with `--network none` on the volume and stop it again: opening the database
replays the log and flushes it to table files. The script refuses to run while
the logs hold more than WAL_LIMIT bytes.

Blobs live in its
column family "t" (SUBSPACE_BLOBS), stored as Stalwart wrote them, compression
marker included. They are copied byte for byte. The object name is the blob key
in Stalwart's own base32 alphabet, prefixed with P, exactly as
store/src/backend/s3 builds it. That way the metadata in RocksDB still finds
every blob after the switch. Objects that already exist with the same size are
skipped, so the script can be rerun. It finishes by reading every object back
and comparing it with the source.

Needs `rocksdict` and `boto3` (a throwaway venv is fine).
"""
import argparse
import os
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from rocksdict import AccessType, Options, Rdict

ALPHABET = b"abcdefghijklmnopqrstuvwxyz792013"  # utils/src/codec/base32_custom.rs
BLOB_CF = "t"        # SUBSPACE_BLOBS: blob hash -> stored bytes
LINK_CF = "k"        # blob links: keys start with the 32-byte blob hash
WAL_LIMIT = 4096


def stalwart_base32(data: bytes) -> str:
    """Base32Writer from Stalwart: MSB-first 5-bit groups, no padding."""
    out, acc, bits = [], 0, 0
    for byte in data:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(ALPHABET[(acc >> bits) & 0x1F])
    if bits:
        out.append(ALPHABET[(acc << (5 - bits)) & 0x1F])
    return bytes(out).decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db_dir")
    parser.add_argument("endpoint")
    parser.add_argument("bucket")
    parser.add_argument("--region", default="fsn1")
    parser.add_argument("--prefix", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    wal = sum(os.path.getsize(os.path.join(args.db_dir, f)) for f in os.listdir(args.db_dir) if f.endswith(".log"))
    if wal > WAL_LIMIT:
        sys.exit(f"{wal} bytes in the write-ahead log: run the --network none flush first (see the top of this file)")

    # RocksDB only opens with every column family listed; all are opened raw, read-only.
    families = {name: Options(raw_mode=True) for name in Rdict.list_cf(args.db_dir, Options(raw_mode=True))}
    db = Rdict(args.db_dir, Options(raw_mode=True), column_families=families, access_type=AccessType.read_only())
    blobs = db.get_column_family(BLOB_CF)
    s3 = boto3.client("s3", endpoint_url=args.endpoint, region_name=args.region,
                      config=Config(s3={"addressing_style": "path"}))

    referenced = {key[:32] for key in db.get_column_family(LINK_CF).keys()}
    missing = referenced - set(blobs.keys())
    if missing:
        sys.exit(f"{len(missing)} linked blobs are not in the blob column family; refusing to continue")

    copied = skipped = total_bytes = 0
    names = []
    for key, value in blobs.items():
        name = args.prefix + stalwart_base32(key)
        names.append((name, key))
        total_bytes += len(value)
        try:
            if s3.head_object(Bucket=args.bucket, Key=name)["ContentLength"] == len(value):
                skipped += 1
                continue
        except ClientError as err:
            if err.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                raise
        if not args.dry_run:
            s3.put_object(Bucket=args.bucket, Key=name, Body=value)
        copied += 1

    print(f"{len(names)} blobs, {total_bytes} bytes: {copied} {'to copy' if args.dry_run else 'copied'}, {skipped} already there")
    if args.dry_run:
        return

    bad = 0
    for name, key in names:
        body = s3.get_object(Bucket=args.bucket, Key=name)["Body"].read()
        if body != blobs[key]:
            bad += 1
            print(f"MISMATCH {name}", file=sys.stderr)
    db.close()
    if bad:
        sys.exit(f"{bad} objects differ from the source")
    print(f"verified {len(names)} objects")


if __name__ == "__main__":
    main()
