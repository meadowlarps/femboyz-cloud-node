#!/bin/sh
# Nightly Stalwart backup to S3 (Hetzner Object Storage) with restic.
#
# Installed copy: /usr/local/sbin/femboyz-mail-backup (root, 755)
# Config:         /etc/femboyz-mail/backup.env (root, 600), see backup.env.example
# Run by:         femboyz-mail-backup.timer (see DEPLOYMENT.md 13.13)
#
#   femboyz-mail-backup             stop Stalwart, back up, start, apply retention
#   femboyz-mail-backup set-secret  prompt for the S3 secret key and store it
#   femboyz-mail-backup init        create the restic repository (once)
#   femboyz-mail-backup restic ...  run any restic command with the config loaded
set -eu

ENV_FILE=/etc/femboyz-mail/backup.env
COMPOSE=/etc/femboyz-mail/docker-compose.yml
VOLUMES=/var/lib/docker/volumes
ACCOUNT_BACKUP=/var/backups/femboyz-cloud
APP_DIR=/srv/femboyz-cloud
# Under /mnt: Ubuntu's AppArmor profile for fusermount3 refuses mount points in /run.
BLOB_MOUNT=/mnt/femboyz-mail-blobs

if [ "${1:-}" = "set-secret" ]; then
    printf 'S3 secret key: ' >&2
    stty -echo; read -r secret; stty echo; echo >&2
    [ -n "$secret" ] || { echo "empty, nothing changed" >&2; exit 1; }
    tmp=$(mktemp "$ENV_FILE.XXXXXX")
    grep -v '^AWS_SECRET_ACCESS_KEY=' "$ENV_FILE" > "$tmp" || true
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$secret" >> "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
    echo "stored in $ENV_FILE" >&2
    exit 0
fi

set -a
. "$ENV_FILE"
set +a

case "${1:-}" in
    init) exec restic init ;;
    restic) shift; exec restic "$@" ;;
    "") ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac

# RocksDB must not be copied while it is written. Stop Stalwart for the
# duration of the snapshot; sending servers retry, so no mail is lost.
# Back up accounts and provider secrets with the mailboxes once accounts are enabled.
restart_accounts=false
restart_webmail=false
if [ "$(docker inspect -f '{{.State.Running}}' femboyz-webmail 2>/dev/null || true)" = true ]; then
    restart_webmail=true
fi
if [ -f "$APP_DIR/oidc-jwks.json" ] && systemctl is-active --quiet femboyz-api.service; then
    restart_accounts=true
fi
blobs_unmount() {
    if mountpoint -q "$BLOB_MOUNT"; then fusermount3 -u "$BLOB_MOUNT" || fusermount3 -uz "$BLOB_MOUNT"; fi
}
restart() {
    restart_status=0
    blobs_unmount || restart_status=1
    docker compose -f "$COMPOSE" start stalwart >/dev/null || restart_status=1
    if [ "$restart_accounts" = true ]; then systemctl start femboyz-api.service || restart_status=1; fi
    if [ "$restart_webmail" = true ]; then docker compose -f "$COMPOSE" start webmail >/dev/null || restart_status=1; fi
    return "$restart_status"
}
trap restart EXIT
if [ "$restart_webmail" = true ]; then docker compose -f "$COMPOSE" stop webmail >/dev/null; fi
if [ "$restart_accounts" = true ]; then systemctl stop femboyz-api.service; fi
docker compose -f "$COMPOSE" stop stalwart >/dev/null

# Pause both writers before dumping MongoDB so account provisioning/deletion cannot
# leave a snapshot whose Mongo records and mailboxes come from different states.
set --
if [ -f "$APP_DIR/oidc-jwks.json" ]; then
    install -d -m 700 "$ACCOUNT_BACKUP"
    docker exec femboyz-mongodb sh -c 'exec mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
        > "$ACCOUNT_BACKUP/mongo.archive.gz.tmp"
    chmod 600 "$ACCOUNT_BACKUP/mongo.archive.gz.tmp"
    mv "$ACCOUNT_BACKUP/mongo.archive.gz.tmp" "$ACCOUNT_BACKUP/mongo.archive.gz"
    set -- "$ACCOUNT_BACKUP/mongo.archive.gz" "$APP_DIR/.env.prod" "$APP_DIR/oidc-jwks.json"
fi

# Mail bodies live in the S3 blob store (DEPLOYMENT.md 16.5), not in the volume.
# Mount it read-only so one snapshot holds the metadata and every blob it references.
if [ -n "${BLOB_BUCKET:-}" ]; then
    export RCLONE_CONFIG_BLOBS_TYPE=s3 RCLONE_CONFIG_BLOBS_PROVIDER=Other \
        RCLONE_CONFIG_BLOBS_ENDPOINT="$BLOB_ENDPOINT" RCLONE_CONFIG_BLOBS_REGION="${BLOB_REGION:-fsn1}" \
        RCLONE_CONFIG_BLOBS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" RCLONE_CONFIG_BLOBS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
    install -d -m 700 "$BLOB_MOUNT"
    rclone mount "blobs:$BLOB_BUCKET" "$BLOB_MOUNT" --read-only --daemon --vfs-cache-mode off --dir-cache-time 1m
    set -- "$@" "$BLOB_MOUNT"
fi

restic backup --host femboyz-cloud-node-a --tag stalwart \
    --exclude /etc/femboyz-mail/backup.env \
    --exclude /etc/femboyz-mail/restic-password \
    "$VOLUMES/femboyz-mail_stalwart_etc/_data" \
    "$VOLUMES/femboyz-mail_stalwart_data/_data" \
    /etc/femboyz-mail "$@"

restart
trap - EXIT

restic forget --tag stalwart --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# Weekly: verify the repository and re-read a sample of the stored data.
if [ "$(date +%u)" = 7 ]; then
    restic check --read-data-subset=10%
fi
