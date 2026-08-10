#!/usr/bin/env python3
"""Firefox distribution zip builder.

Reads manifest.json (Chrome-oriented) and produces a Firefox-compatible
manifest + zip for AMO submission / temporary add-on loading.

- Chrome MV3 requires "background.service_worker"; Firefox requires
  "background.scripts" (service_worker is ignored with a warning).
- Firefox requires browser_specific_settings.gecko.
"""

import json
import os
import sys
import zipfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_ZIP = os.path.join(BASE_DIR, "nico-side-comment.zip")

GECKO_ID = "{9e6948e3-1c58-4983-86f8-f0ad90269497}"

# Files included in the distribution (relative to BASE_DIR)
DIST_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "sidebar.css",
    "README.md",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "icons/icon-off16.png",
    "icons/icon-off48.png",
    "icons/icon-off128.png",
]


def build_firefox_manifest():
    with open(os.path.join(BASE_DIR, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    # Firefox: use background.scripts instead of service_worker
    manifest["background"] = {"scripts": ["background.js"]}

    # Firefox: gecko-specific settings
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "data_collection_permissions": {
                "required": ["none"],
            },
        }
    }

    return manifest


def main():
    firefox_manifest = build_firefox_manifest()

    if os.path.exists(OUTPUT_ZIP):
        os.remove(OUTPUT_ZIP)

    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        # Write the Firefox manifest as manifest.json (top-level)
        zf.writestr("manifest.json", json.dumps(firefox_manifest, indent=2, ensure_ascii=False))

        for name in DIST_FILES:
            if name == "manifest.json":
                continue  # already written above
            src = os.path.join(BASE_DIR, name)
            if not os.path.exists(src):
                print(f"WARNING: missing {name}")
                continue
            zf.write(src, name)
            print(f"added: {name}")

    print(f"\ncreated: {OUTPUT_ZIP}")
    print("manifest (firefox):")
    print(json.dumps(firefox_manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
