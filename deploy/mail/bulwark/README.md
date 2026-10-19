# Bulwark automatic-login patch

Base: Bulwark **1.15.0**, upstream commit
`fc22f111efaefa837d1796864664935c12cbc7bd` (tag `1.15.0`).
Our image: `femboyz/bulwark:1.15.0-femboyz.4`.

Normal single-provider entry forwards automatically to the site login or inbox.
The initial session check is visually quiet; checks lasting over 700 ms show
one **Checking login…** message without a logo or layout shift. The custom PWA
install card is removed and browser install prompts are suppressed before
hydration. Manual installation remains available in the browser menu.

The managed palette is also bundled in `app/femboyz.css`, with the site's
`#1b1a1a` background on the server-rendered html/body. Keep this bundled copy
in sync with `mail/theme/theme.css` when changing the palette; the build verifies
this. The transition background also survives older cached themes.

Discovery/start requests time out after 15 seconds; actual errors show
**Try again** instead of an indefinite spinner. Add-account, multi-server and
local-only sign-out flows keep their existing controls.

The old login page's permanent flag, and our first patch's 30-second pending
attempt, both blocked a user who left the provider login through Home and clicked
Mail again. The current patch migrates both pending flags and records the retry
pause only when the callback actually fails. Successful login/full provider logout
clears that failure pause. Local-only logout retains its one-shot pause, preventing
an immediate sign-in through a provider session that was never ended.

Build on an amd64 machine with Git, Docker and network access:

```bash
sudo ./deploy/mail/bulwark/build.sh /var/tmp/femboyz-bulwark-build-1
sudo docker save femboyz/bulwark:1.15.0-femboyz.4 | gzip > /tmp/bulwark-image.tar.gz
scp /tmp/bulwark-image.tar.gz ops@femboyz:/tmp/
ssh ops@femboyz 'gzip -dc /tmp/bulwark-image.tar.gz | sudo docker load'
```

Use a fresh output directory each time. The script verifies the exact source
commit and applies the committed patch. Its Docker build runs the focused SSO
and provider-logout regression tests before the production Next.js build. Node's
base image is pinned by digest. The locale prefix remains `always`, matching the
registered production callbacks. `pull_policy: never` prevents compose from
replacing the locally built image with a registry image.

Copy the generated `bulwark-1.15.0-femboyz.4-source.tar.gz` to
`/etc/femboyz-mail/webmail/branding/`, mode 644, and record `image-id.txt` at
`/etc/femboyz-mail/webmail/image-id.txt`. Verify the loaded image ID matches before
starting it. The source archive includes the complete patched upstream source,
its license, tests, and our build instructions in `.femboyz/`. It is served at
`/branding/femboyz/bulwark-1.15.0-femboyz.4-source.tar.gz`, linked through
`SOURCE_CODE_URL`, and included in the encrypted mail backup. This code retains
upstream's AGPL-3.0-only license.

Build and deploy a new version suffix for future patch changes. Upgrades need a
fresh upstream commit, patch applicability check, regression tests and browser
login/logout verification. To roll back, restore the previous installed compose,
env and branding; the old upstream image remains available on the server.
