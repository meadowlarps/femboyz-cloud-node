# Bulwark automatic-login patch

Base: Bulwark **1.15.0**, upstream commit
`fc22f111efaefa837d1796864664935c12cbc7bd` (tag `1.15.0`).
Our image: `femboyz/bulwark:1.15.0-femboyz.1`.

The old login page set `sessionStorage.sso_attempted=1` and used a timer to
clear it. Leaving the page for OAuth destroyed that timer, blocking future
automatic logins in the same tab. The patch migrates that flag, uses a timestamp
for the 30-second failure guard, and clears it after successful authentication.
The old ambiguous sign-out marker is also migrated on upgrade. Full provider
logout clears the attempt and local sign-out pause so a later mail
visit immediately starts SSO. Local-only logout retains the pause to prevent
signing straight back in through an unchanged provider session. Error, add-account,
multi-server and already-authenticated checks remain in place.

Build on an amd64 machine with Git, Docker and network access:

```bash
sudo ./deploy/mail/bulwark/build.sh /var/tmp/femboyz-bulwark-build-1
sudo docker save femboyz/bulwark:1.15.0-femboyz.1 | gzip > /tmp/bulwark-image.tar.gz
scp /tmp/bulwark-image.tar.gz ops@femboyz:/tmp/
ssh ops@femboyz 'gzip -dc /tmp/bulwark-image.tar.gz | sudo docker load'
```

Use a fresh output directory each time. The script verifies the exact source
commit and applies the committed patch. Its Docker build runs the focused SSO
and provider-logout regression tests before the production Next.js build. Node's
base image is pinned by digest. The locale prefix remains `always`, matching the
registered production callbacks. `pull_policy: never` prevents compose from
replacing the locally built image with a registry image.

Copy the generated `bulwark-1.15.0-femboyz.1-source.tar.gz` to
`/etc/femboyz-mail/webmail/branding/`, mode 644, and record `image-id.txt` at
`/etc/femboyz-mail/webmail/image-id.txt`. Verify the loaded image ID matches before
starting it. The source archive includes the complete patched upstream source,
its license, tests, and our build instructions in `.femboyz/`. It is served at
`/branding/femboyz/bulwark-1.15.0-femboyz.1-source.tar.gz`, linked through
`SOURCE_CODE_URL`, and included in the encrypted mail backup. This code retains
upstream's AGPL-3.0-only license.

Build and deploy a new version suffix for future patch changes. Upgrades need a
fresh upstream commit, patch applicability check, regression tests and browser
login/logout verification. To roll back, restore the previous installed compose,
env and branding; the old upstream image remains available on the server.
