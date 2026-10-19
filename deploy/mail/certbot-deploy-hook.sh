#!/bin/sh
# certbot deploy hook: hand the renewed mx.femboyz.cloud certificate to Stalwart.
#
# Installed copy: /etc/letsencrypt/renewal-hooks/deploy/femboyz-mail.sh (root, 755)
#
# The Let's Encrypt private key is root-only, and Stalwart runs as UID 2000,
# so instead of mounting /etc/letsencrypt (which also holds the femboyz.cloud
# key) we copy just this lineage into /etc/femboyz-mail/tls and restart
# Stalwart so it re-reads the files. certbot sets RENEWED_LINEAGE for every
# renewed cert; run by hand with no environment to force a sync.
set -eu

LINEAGE=/etc/letsencrypt/live/mx.femboyz.cloud
DEST=/etc/femboyz-mail/tls
COMPOSE=/etc/femboyz-mail/docker-compose.yml

if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$RENEWED_LINEAGE" != "$LINEAGE" ]; then
    exit 0
fi

install -d -m 700 -o 2000 -g 2000 "$DEST"
install -m 600 -o 2000 -g 2000 "$LINEAGE/fullchain.pem" "$DEST/fullchain.pem.new"
install -m 600 -o 2000 -g 2000 "$LINEAGE/privkey.pem" "$DEST/privkey.pem.new"
mv -f "$DEST/fullchain.pem.new" "$DEST/fullchain.pem"
mv -f "$DEST/privkey.pem.new" "$DEST/privkey.pem"

if docker compose -f "$COMPOSE" ps --status running --quiet stalwart | grep -q .; then
    docker compose -f "$COMPOSE" restart stalwart
fi
