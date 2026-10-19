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
restart() { docker compose -f "$COMPOSE" start stalwart >/dev/null; }
docker compose -f "$COMPOSE" stop stalwart >/dev/null
trap restart EXIT

restic backup --host femboyz-cloud-node-a --tag stalwart \
    --exclude /etc/femboyz-mail/backup.env \
    --exclude /etc/femboyz-mail/restic-password \
    "$VOLUMES/femboyz-mail_stalwart_etc/_data" \
    "$VOLUMES/femboyz-mail_stalwart_data/_data" \
    /etc/femboyz-mail

restart
trap - EXIT

restic forget --tag stalwart --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# Weekly: verify the repository and re-read a sample of the stored data.
if [ "$(date +%u)" = 7 ]; then
    restic check --read-data-subset=10%
fi
