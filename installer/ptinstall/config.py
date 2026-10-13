"""Small JSON config store under %APPDATA%\\PTInstall (or ~/.ptinstall)."""

import json
import os
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
