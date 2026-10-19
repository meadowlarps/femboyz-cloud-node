#!/usr/bin/env python3
"""Build Bulwark 1.15's managed theme/config and an uploadable theme ZIP.

Usage: ./deploy/mail/build-webmail.py OUTPUT_DIRECTORY
Copy admin/ into /etc/femboyz-mail/webmail/admin/ without removing admin.json;
copy branding/ into /etc/femboyz-mail/webmail/branding/. See DEPLOYMENT.md 15.
"""
import hashlib
import json
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def build(output: Path):
    source = Path(__file__).resolve().parents[2] / "mail"
    theme = source / "theme"
    manifest = json.loads((theme / "manifest.json").read_text())
    css = (theme / "theme.css").read_text()
    skin = (theme / "skin.css").read_text()
    destination = output / "admin" / "themes"
    destination.mkdir(parents=True, exist_ok=True)
    (output / "admin" / "policy.json").write_text((source / "config" / "policy.json").read_text())
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {key: manifest[key] for key in ["id", "name", "version", "author", "description", "variants"]}
    metadata.update(enabled=True, forceEnabled=True, hasSkin=True, installedAt=now, updatedAt=now,
                    contentHash=hashlib.sha256((css + "\0" + skin).encode()).hexdigest())
    (destination / "registry.json").write_text(json.dumps({"themes": [metadata]}, indent=2) + "\n")
    (destination / "femboyz.css").write_text(css)
    (destination / "femboyz.skin.css").write_text(skin)
    shutil.copytree(source / "branding", output / "branding", dirs_exist_ok=True)
    with zipfile.ZipFile(output / "femboyz-theme.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ["manifest.json", "theme.css", "skin.css"]:
            archive.write(theme / name, name)
    print(f"Built Bulwark theme, policy and branding in {output}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    build(Path(sys.argv[1]))
