"""Small JSON config store under %APPDATA%\\PTInstall (or ~/.ptinstall)."""

import json
import os
import sys
from pathlib import Path

APP_NAME = "PTInstall"


def config_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path.home() / ".config"
    d = base / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def load() -> dict:
    path = config_dir() / "config.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save(cfg: dict) -> None:
    path = config_dir() / "config.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def cert_dir() -> Path:
    d = config_dir() / "cert"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ca_bundle() -> Path:
    """certifi + Apple's Root CA — the GSA endpoints (gsa.apple.com) present a
    chain under Apple's *private* "Apple Server Authentication CA", which no
    public CA store trusts; real Apple devices carry the root instead. We
    vendored apple.com's published AppleIncRootCertificate (SHA-256
    B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:
    C5:BE:91:B5:A1:10:01:F0:24). Public endpoints still validate normally —
    the bundle includes certifi.
    """
    import certifi

    res_dir = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "ptinstall"
    if not (res_dir / "apple_root_ca.pem").exists():
        res_dir = Path(__file__).parent
    out = config_dir() / "ca-bundle.pem"
    apple = (res_dir / "apple_root_ca.pem").read_text(encoding="utf-8")
    out.write_text(
        Path(certifi.where()).read_text(encoding="utf-8") + "\n" + apple,
        encoding="utf-8",
    )
    return out
