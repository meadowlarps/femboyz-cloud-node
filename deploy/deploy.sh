#!/usr/bin/env bash
set -Eeuo pipefail

readonly expected_commit="${1:?usage: deploy.sh <commit-sha>}"
readonly app_dir=/srv/femboyz-cloud

if [[ ! "$expected_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Invalid commit SHA" >&2
    exit 2
fi

cd "$app_dir"

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Deployment checkout has uncommitted tracked changes" >&2
    exit 1
fi

git fetch --prune origin main

if [[ "$(git rev-parse origin/main)" != "$expected_commit" ]]; then
    echo "Commit was superseded by a newer push; skipping"
    exit 0
fi

git switch main
git pull --ff-only origin main

npm ci
npm run build
npm --prefix client ci
npm --prefix client run build

sudo systemctl restart femboyz-api.service femboyz-web.service

curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
    http://127.0.0.1:3000/ping >/dev/null
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
    http://127.0.0.1:3001/ >/dev/null

echo "Deployed $expected_commit"
