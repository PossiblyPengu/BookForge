#!/usr/bin/env python3
"""Write an AltStore / SideStore source (altstore.json) for a built Pageturner.ipa.

usage: make-altstore-source.py <Pageturner.ipa> <owner/repo> <download-url> <out.json>

The version, build number, minimum iOS and bundle id are read from the IPA itself, so the source can never
disagree with the file it points at. SideStore reads the app-level fields, AltStore the `versions` list; both are written.
"""
import json
import plistlib
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ipa, repo, download_url, out = sys.argv[1:5]
with zipfile.ZipFile(ipa) as z:
    damaged = z.testzip()
    if damaged:
        raise ValueError(f"Damaged IPA entry: {damaged}")
    name = next(n for n in z.namelist() if n.startswith("Payload/") and n.endswith(".app/Info.plist") and n.count("/") == 2)
    info = plistlib.loads(z.read(name))
version = info["CFBundleShortVersionString"]
build = str(info["CFBundleVersion"])
bundle = info["CFBundleIdentifier"]
minos = info.get("MinimumOSVersion", "17.0")
size = Path(ipa).stat().st_size
date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
raw = f"https://raw.githubusercontent.com/{repo}/main"
description = (
    "A reader and audiobook player for your own book files — EPUB, PDF, comics and audiobooks — with neural and "
    "device read-aloud voices and word, line and sentence highlighting. BookMaster tracks your reading."
)
notes = f"Build {build}. See the repository for what changed."
source = {
    "name": "Pageturner",
    "identifier": f"{bundle}.source",
    "subtitle": "Updates for Pageturner",
    "description": "Pageturner builds, published from GitHub Actions.",
    "iconURL": f"{raw}/ios/Pageturner/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
    "tintColor": "A0532A",
    "website": f"https://github.com/{repo}",
    "apps": [
        {
            "name": "Pageturner",
            "bundleIdentifier": bundle,
            "developerName": repo.split("/")[0],
            "subtitle": "Read and listen to your own books",
            "localizedDescription": description,
            "iconURL": f"{raw}/ios/Pageturner/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
            "tintColor": "A0532A",
            "screenshotURLs": [],
            # SideStore reads these…
            "version": version,
            "versionDate": date,
            "versionDescription": notes,
            "downloadURL": download_url,
            "size": size,
            # …AltStore reads this
            "versions": [
                {
                    "version": version,
                    "buildVersion": build,
                    "date": date,
                    "localizedDescription": notes,
                    "downloadURL": download_url,
                    "size": size,
                    "minOSVersion": minos,
                }
            ],
            "appPermissions": {"entitlements": [], "privacy": {}},
        }
    ],
    "news": [],
}
Path(out).write_text(json.dumps(source, indent=2) + "\n")
print(f"{bundle} {version} ({build}), {size} bytes -> {out}")
