"""IPA signing via zsign — fetched from the official release on first use."""

import hashlib
import io
import os
import shutil
import stat
import subprocess
import tarfile
import zipfile
from pathlib import Path

import requests

from . import config

ZSIGN_VERSION = "1.1.2"
ZSIGN_SUMS = f"https://github.com/zhlynn/zsign/releases/download/v{ZSIGN_VERSION}/SHA256SUMS.txt"

if os.name == "nt":
    ZSIGN_ARCHIVE = f"https://github.com/zhlynn/zsign/releases/download/v{ZSIGN_VERSION}/zsign-windows-x64.zip"
    ZSIGN_BINARY = "zsign.exe"
    ZSIGN_ASSET = "windows-x64"
else:
    # Static musl build — runs on any Linux runner without extra libraries.
    ZSIGN_ARCHIVE = f"https://github.com/zhlynn/zsign/releases/download/v{ZSIGN_VERSION}/zsign-linux-musl-static.tar.gz"
    ZSIGN_BINARY = "zsign"
    ZSIGN_ASSET = "linux-musl-static"


class SignError(RuntimeError):
    pass


def _expected_sha256() -> str | None:
    try:
        r = requests.get(ZSIGN_SUMS, timeout=15)
        r.raise_for_status()
        for line in r.text.splitlines():
            parts = line.split()
            if len(parts) == 2 and ZSIGN_ASSET in parts[1]:
                return parts[0]
    except requests.RequestException:
        pass
    return None


def ensure_zsign() -> Path:
    """Find zsign on PATH or download the verified official build."""
    found = shutil.which("zsign")
    if found:
        return Path(found)
    exe = config.config_dir() / "tools" / ZSIGN_BINARY
    if exe.exists():
        return exe

    print(f"  downloading zsign v{ZSIGN_VERSION} ({ZSIGN_ASSET})…")
    r = requests.get(ZSIGN_ARCHIVE, timeout=60)
    r.raise_for_status()
    blob = r.content

    expected = _expected_sha256()
    digest = hashlib.sha256(blob).hexdigest()
    if expected and digest != expected:
        raise SignError(
            f"zsign download checksum mismatch\n  expected {expected}\n  got      {digest}"
        )

    exe.parent.mkdir(parents=True, exist_ok=True)
    if ZSIGN_ARCHIVE.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for name in z.namelist():
                if name.endswith(ZSIGN_BINARY):
                    exe.write_bytes(z.read(name))
                    break
            else:
                raise SignError(f"{ZSIGN_BINARY} not found in downloaded archive")
    else:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
            for m in t.getmembers():
                if m.name.endswith(ZSIGN_BINARY):
                    exe.write_bytes(t.extractfile(m).read())
                    break
            else:
                raise SignError(f"{ZSIGN_BINARY} not found in downloaded archive")
        exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  zsign installed to {exe}")
    return exe


def sign_ipa(ipa: Path, p12: Path, profile: Path, out: Path,
             bundle_id: str | None = None) -> Path:
    """Sign ipa → out. ``bundle_id`` rewrites CFBundleIdentifier when given.

    Free-account profiles only cover their exact App ID, so the app's bundle
    identifier must be rewritten to match.
    """
    zsign = ensure_zsign()
    cmd = [
        str(zsign),
        "-k", str(p12),
        "-p", "",
        "-m", str(profile),
        "-o", str(out),
    ]
    if bundle_id:
        cmd += ["-b", bundle_id]
    cmd.append(str(ipa))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SignError(
            f"zsign failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
        )
    return out
