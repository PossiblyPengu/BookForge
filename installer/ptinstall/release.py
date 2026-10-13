"""Fetch the latest Pageturner.ipa from the ios-latest GitHub release."""

import requests

REPO = "PossiblyPengu/PageTurner"
RELEASE_TAG = "ios-latest"
IPA_ASSET = "Pageturner.ipa"


def latest_ipa_url(repo: str = REPO, tag: str = RELEASE_TAG, asset: str = IPA_ASSET) -> str:
    """Direct download URL — stable, no API round-trip needed."""
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


def asset_stamp(repo: str = REPO, tag: str = RELEASE_TAG, asset: str = IPA_ASSET) -> str:
    """A fingerprint of the current release asset (updated_at + size) — cheap
    check for "did the build change since I last downloaded it"."""
    r = requests.get(
        f"https://api.github.com/repos/{repo}/releases/tags/{tag}", timeout=15)
    r.raise_for_status()
    for a in r.json().get("assets", []):
        if a["name"] == asset:
            return f"{a['updated_at']}:{a['size']}"
    raise RuntimeError(f"{asset} not found in release {tag}")


def download_ipa(dest_path, repo: str = REPO, tag: str = RELEASE_TAG, asset: str = IPA_ASSET):
    """Download the rolling-release IPA to dest_path. Returns the path."""
    url = latest_ipa_url(repo, tag, asset)
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        got = 0
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                got += len(chunk)
                if total:
                    print(f"\r  downloading {asset}: {got * 100 // total}%", end="", flush=True)
        if total:
            print()
    return dest_path

