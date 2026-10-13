"""Fetch the latest Pageturner.ipa from the ios-latest GitHub release."""

import requests

REPO = "PossiblyPengu/PageTurner"
RELEASE_TAG = "ios-latest"
IPA_ASSET = "Pageturner.ipa"


def latest_ipa_url(repo: str = REPO, tag: str = RELEASE_TAG, asset: str = IPA_ASSET) -> str:
    """Direct download URL — stable, no API round-trip needed."""
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


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
