"""Anisette headers — the device-identity headers Apple requires on its auth
and provisioning endpoints.

Two providers, tried in order:

  * ``local`` — the ``pyprovision`` package (Python bindings for Apple's ADI
    library, i.e. libprovision). Fully self-contained: generates the machine
    provisioning data itself and keeps it under the config dir. Preferred.
  * ``remote`` — an anisette-v3-compatible HTTP endpoint that returns the
    ``X-Apple-I-MD`` / ``X-Apple-I-MD-M`` headers as JSON. Works with SideStore's
    public servers or a self-hosted Dadoum/anisette-v3-server.

Only ``X-Apple-I-MD`` and ``X-Apple-I-MD-M`` come from anisette; the remaining
``X-Apple-I-*`` headers are generated locally from stable device identifiers.
"""

import base64
import locale
import secrets
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import config

# Public anisette-v3 servers, in the order tried. Checked from GitHub's runners (Windows and Ubuntu) on 2026-10-13:
# ani.stikstore.app answers 403 there — a Cloudflare challenge for datacenter addresses, whatever the headers —
# while these three answer 200. It stays last: it works from a home connection (the Windows installer).
DEFAULT_ANISETTE_URLS = (
    "https://ani.sidestore.io",
    "https://ani.sidestore.app",
    "https://ani.npeg.us",
    "https://ani.stikstore.app",
)
DEFAULT_ANISETTE_URL = DEFAULT_ANISETTE_URLS[0]

# One server for the whole sign-in: its headers belong to its own machine identity, so a call that moved to
# another server half way through could be refused. Chosen on first use, kept for the process.
_chosen_url: str | None = None


class AnisetteError(RuntimeError):
    pass


def _device_ids() -> tuple[str, str, str]:
    """Stable (serial, user-id, device-id) triple, persisted in config."""
    cfg = config.load()
    ids = cfg.get("device_ids")
    if not ids:
        ids = {
            "serial": secrets.token_hex(6).upper(),
            "user_id": str(uuid.uuid4()).upper(),
            "device_id": str(uuid.uuid4()).upper(),
        }
        cfg["device_ids"] = ids
        config.save(cfg)
    return ids["serial"], ids["user_id"], ids["device_id"]


def _meta_headers() -> dict:
    serial, user_id, device_id = _device_ids()
    tz = datetime.now().astimezone().tzinfo
    return {
        "X-Apple-I-Client-Time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "X-Apple-I-TimeZone": str(tz),
        "loc": locale.getlocale()[0] or "en_US",
        "X-Apple-Locale": locale.getlocale()[0] or "en_US",
        "X-Apple-I-MD-RINFO": "17106176",
        "X-Apple-I-MD-LU": base64.b64encode(user_id.encode()).decode(),
        "X-Mme-Device-Id": device_id,
        "X-Apple-I-SRL-NO": serial,
    }


def _local_otp() -> dict:
    """pyprovision local ADI — returns the two anisette headers."""
    import pyprovision  # optional dependency
    from ctypes import c_ulonglong

    prov_dir = config.config_dir() / "anisette"
    prov_dir.mkdir(parents=True, exist_ok=True)

    adi = pyprovision.ADI(str(prov_dir))
    adi.provisioning_path = str(prov_dir)
    device = pyprovision.Device(str(prov_dir / "device.json"))
    if not device.initialized:
        device.server_friendly_description = (
            "<MacBookPro18,3> <macOS;13.4.1;22F8> "
            "<com.apple.AOSKit/282 (com.apple.dt.Xcode/3594.4.19)>"
        )
        device.unique_device_identifier = str(uuid.uuid4()).upper()
        device.adi_identifier = secrets.token_hex(8).lower()
        device.local_user_uuid = secrets.token_hex(32).upper()
    adi.identifier = device.adi_identifier
    dsid = c_ulonglong(-2).value
    if not adi.is_machine_provisioned(dsid):
        pyprovision.ProvisioningSession(adi, device).provision(dsid)
    otp = adi.request_otp(dsid)
    return {
        "X-Apple-I-MD": base64.b64encode(bytes(otp.one_time_password)).decode(),
        "X-Apple-I-MD-M": base64.b64encode(bytes(otp.machine_identifier)).decode(),
    }


def _fetch_otp(url: str) -> dict:
    r = requests.get(url, timeout=15, headers={"User-Agent": "Pageturner-installer"})
    r.raise_for_status()
    h = r.json()
    return {"X-Apple-I-MD": h["X-Apple-I-MD"], "X-Apple-I-MD-M": h["X-Apple-I-MD-M"]}


def _remote_otp(url: str | None = None) -> dict:
    """The two anisette headers from a remote server: the one asked for, else the first of the defaults that answers."""
    global _chosen_url
    if url:
        return _fetch_otp(url)
    if _chosen_url:
        return _fetch_otp(_chosen_url)
    failures = []
    for candidate in DEFAULT_ANISETTE_URLS:
        try:
            otp = _fetch_otp(candidate)
        except Exception as e:  # a 403 challenge, a dead host, a reply that is not anisette JSON…
            failures.append(f"{candidate}: {type(e).__name__}: {str(e)[:90]}")
            continue
        _chosen_url = candidate
        return otp
    raise AnisetteError("no anisette server answered — " + "; ".join(failures))


def headers(prefer: str = "auto", url: str | None = None) -> dict:
    """Full anisette header set for one auth/provisioning call series.

    ``prefer``: ``auto`` (pyprovision if importable, else remote), ``local``,
    or ``remote``. ``url`` overrides the remote endpoint.
    """
    otp = None
    if prefer in ("auto", "local"):
        try:
            otp = _local_otp()
        except ImportError:
            if prefer == "local":
                raise AnisetteError(
                    "pyprovision is not installed — pip install pyprovision, "
                    "or use --anisette remote"
                )
        except Exception as e:
            if prefer == "local":
                raise AnisetteError(f"local anisette failed: {e}")
    if otp is None:
        otp = _remote_otp(url)
    out = dict(_meta_headers())
    out.update(otp)
    return out


def resync(sim: str | None = None, url: str | None = None) -> dict:
    """Regenerate anisette after Apple demands a resync (GSA ``hsc 434``).

    pyprovision: wipe the provisioned machine state and re-provision with a
    fresh ADI identity. Remote endpoints: just fetch another OTP pair — the
    ``sim`` blob is for stateful providers and the stateless JSON servers
    have no resync primitive.
    """
    prov_dir = config.config_dir() / "anisette"
    shutil.rmtree(prov_dir, ignore_errors=True)
    try:
        otp = _local_otp()
    except Exception:
        otp = _remote_otp(url)
    out = dict(_meta_headers())
    out.update(otp)
    return out
