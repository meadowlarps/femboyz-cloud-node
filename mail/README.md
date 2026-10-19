# femboyz webmail

Bulwark 1.15.0-femboyz.2 is built from a pinned upstream commit plus the
automatic-login patch in `deploy/mail/bulwark/`. Its build instructions and
regression tests live there. This directory holds our theme, logos, and managed
policy. See DEPLOYMENT.md section 15 for production paths.

Build the uploadable ZIP and server-managed configuration:

```bash
python3 deploy/mail/build-webmail.py /tmp/femboyz-webmail
unzip -l /tmp/femboyz-webmail/femboyz-theme.zip
```

The ZIP uses Bulwark theme API v2: root manifest.json, theme.css, skin.css.
Both mode variants use the same dark palette. The builder creates the theme
registry with the required SHA-256 of CSS + NUL + skin. Install `admin/` without
removing the separately provisioned `admin.json`, and install `branding/`.

The managed sidebar app embeds the site's account page directly, with an
Open account link as a fallback. Bulwark's plugin iframe introduces an opaque
ancestor, so a custom settings plugin would prevent our account CSP and cookies
from working reliably. The native integration needs no credentials or tokens.

Upstream references:
- https://github.com/bulwarkmail/webmail/tree/1.15.0
- https://bulwarkmail.org/docs/getting-started/configuration/environment-reference
- https://bulwarkmail.org/docs/guides/customization
