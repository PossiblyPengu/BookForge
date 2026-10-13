"""Headless OTA signing — the webpage-triggered variant of ``pipeline.run``.

Runs on a CI runner (no phone, no pymobiledevice3): GSA login → provisioning →
zsign → a signed IPA + an itms-services manifest + a status JSON, all dropped
in an out dir that the workflow publishes to the ``ota-latest`` release.

Two-factor is a two-run affair here: run 1 hits Apple's ``au`` flag, which
fires the trusted-device code push, then exits with state ``needs-2fa``; the
page collects the code and re-dispatches the same request id. The anisette
identity (device-id/serial/user-id) is persisted per request id so run 2
looks like the same device to Apple and the trust from the validated code
carries over. ``X-Apple-I-MD``/``-M`` are one-time passwords and are fetched
fresh each run — only the stable identity headers are carried.
"""

import json
import os
import plistlib
from datetime import datetime, timezone
from pathlib import Path

from . import anisette, config, gsa, pipeline, release, signing

RELEASE_TAG = "ota-latest"
DEFAULT_HOST = "https://pageturner.pages.dev"


class _Status:
    """Writes status-<rid>.json; the install page polls this file. The
    ``nonce`` echoes the dispatch that produced it so the page can tell a
    fresh status from a stale one under the same request id."""

    def __init__(self, out_dir: Path, rid: str, nonce: str = ""):
        self.path = out_dir / f"status-{rid}.json"
        self.nonce = nonce

    def write(self, state: str, detail: str = "", **extra) -> None:
        payload = {
            "request_id": self.path.stem.removeprefix("status-"),
            "nonce": self.nonce,
            "state": state,
            "detail": detail,
            "updated": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _restore_anisette_identity(path: Path | None) -> None:
    """Re-seed config's device_ids from a previous run so Apple sees the same
    anisette device on the 2FA retry."""
    if path and path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("device_ids"):
            cfg = config.load()
            cfg["device_ids"] = data["device_ids"]
            config.save(cfg)


def _save_anisette_identity(path: Path | None) -> None:
    if path:
        ids = config.load().get("device_ids")
        if ids:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"device_ids": ids}, indent=2),
                            encoding="utf-8")


def _manifest(bundle_id: str, ipa_url: str, title="Pageturner",
              version="1.0") -> bytes:
    """The itms-services manifest iOS downloads to drive the install."""
    return plistlib.dumps({
        "items": [{
            "assets": [{"kind": "software-package", "url": ipa_url}],
            "metadata": {
                "bundle-identifier": bundle_id,
                "bundle-version": version,
                "kind": "software",
                "title": title,
            },
        }],
    })


def run(
    request_id: str,
    udid: str,
    apple_id: str,
    password: str | None,
    twofa: str = "",
    device_name: str = "iPhone",
    ipa_path: Path | None = None,
    anisette_mode: str = "auto",
    anisette_url: str | None = None,
    anisette_file: Path | None = None,
    out_dir: Path = Path("out"),
    host: str = DEFAULT_HOST,
    nonce: str = "",
) -> int:
    """Never raises for expected failures — the status file is the channel.
    Returns a process exit code: 0 handled (any state), 1 unexpected crash."""
    out_dir.mkdir(parents=True, exist_ok=True)
    status = _Status(out_dir, request_id, nonce)
    status.write("working", "starting")

    try:
        _restore_anisette_identity(anisette_file)
        headers = anisette.headers(prefer=anisette_mode, url=anisette_url)
        _save_anisette_identity(anisette_file)

        password = password or os.environ.get("PTINSTALL_APPLE_PASSWORD")
        if not password:
            status.write("failed", "no Apple ID password supplied")
            return 0
        try:
            session = gsa.authenticate(
                apple_id, password, headers,
                twofa_prompt=lambda _m: "",
                twofa_code=twofa or None,
            )
        except gsa.NeedsTwoFactor as e:
            status.write("needs-2fa", str(e))
            return 0
        except gsa.AuthError as e:
            status.write("failed", f"sign-in: {e}")
            return 0

        workdir = out_dir / "work"
        try:
            bundle = pipeline.ensure_cert(session, udid, device_name, workdir)
        except Exception as e:
            status.write("failed", f"provisioning: {e}")
            return 0

        try:
            if ipa_path is None:
                ipa_path = out_dir / "Pageturner.ipa"
                release.download_ipa(ipa_path)
            signed = out_dir / f"Pageturner-{request_id}.ipa"
            signing.sign_ipa(
                ipa_path,
                workdir / "signing.p12",
                workdir / "signing.mobileprovision",
                signed,
                bundle_id=bundle.bundle_id,
            )
        except Exception as e:
            status.write("failed", f"signing: {e}")
            return 0

        # The release assets are fetched through the install page's own
        # function endpoints (unguessable rid in the URL is the bearer token).
        ipa_url = f"{host}/api/install/ipa?rid={request_id}"
        manifest_url = f"{host}/api/install/manifest?rid={request_id}"
        (out_dir / f"manifest-{request_id}.plist").write_bytes(
            _manifest(bundle.bundle_id, ipa_url)
        )
        status.write("done", manifest_url=manifest_url, ipa_url=ipa_url)
        return 0
    except Exception as e:  # anything unplanned — still emit a status
        import traceback
        tb = traceback.extract_tb(e.__traceback__)[-1]
        status.write("failed",
                     f"crash: {type(e).__name__}: {e} ({tb.filename.split('/')[-1]}:{tb.lineno})")
        return 1
