#!/usr/bin/env bash
# Run with Docker access. OUTPUT contains the full patched source distribution.
set -euo pipefail
readonly output="${1:?usage: build.sh OUTPUT_DIRECTORY}"
readonly here="$(cd "$(dirname "$0")" && pwd)"
readonly upstream=fc22f111efaefa837d1796864664935c12cbc7bd
readonly image=femboyz/bulwark:1.15.0-femboyz.3
mkdir -p "$output"
readonly destination="$(cd "$output" && pwd)"
readonly source_dir="$destination/source"
if [ -e "$source_dir" ]; then
    echo "Refusing to overwrite $source_dir; choose a fresh output directory" >&2
    exit 1
fi
git init --quiet "$source_dir"
git -C "$source_dir" remote add origin https://github.com/bulwarkmail/webmail.git
git -C "$source_dir" fetch --depth 1 origin "$upstream"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream"
git -C "$source_dir" apply --check "$here/auto-sso.patch"
git -C "$source_dir" apply "$here/auto-sso.patch"
# Fail if the initial bundled palette drifts from the managed theme.
diff -u <(cat "$here/../../../mail/theme/theme.css"; printf '\nhtml, body { background-color: #1b1a1a; }\n') "$source_dir/app/femboyz.css"
mkdir "$source_dir/.femboyz"
cp "$here"/* "$source_dir/.femboyz/"
cp "$source_dir/.dockerignore" "$source_dir/.femboyz/upstream.dockerignore"
cp "$here/Dockerfile.dockerignore" "$source_dir/.dockerignore"
tar --exclude=.git -czf "$destination/bulwark-1.15.0-femboyz.3-source.tar.gz" -C "$source_dir" .
docker build --platform linux/amd64 --tag "$image" --file "$here/Dockerfile" "$source_dir"
docker image inspect "$image" --format '{{.Id}}' > "$destination/image-id.txt"
sha256sum "$destination/bulwark-1.15.0-femboyz.3-source.tar.gz" > "$destination/source.sha256"
printf 'Built %s; source distribution and image ID are in %s\n' "$image" "$destination"
