"""Talking to the iPhone — pairing and IPA install, via pymobiledevice3.

iOS 17+ speaks RemoteXPC over a Bonjour-advertised ``remoted`` service; pairing
is the remote-pairing handshake (no cable, no iTunes). Two pair modes exist:

  * ``pair`` — we browse for a device advertising ``_remotepairing._tcp`` and
    drive the handshake (works when the device is advertising, e.g. unlocked
    on Wi-Fi with Developer Mode on).
  * ``pair-host`` — we advertise as a pairable Mac; on the phone:
    Settings > Developer > Paired Macs > pick this PC > enter the PIN.
    This is the reliable path on iOS 17+.

After pairing, ``get_rsds`` finds the device's remoted endpoint and the saved
pairing record authenticates us; ``installation_proxy`` then installs the IPA
through the RSD shim.
"""

import asyncio
import platform
from dataclasses import dataclass
from pathlib import Path

from pymobiledevice3.bonjour import browse_remotepairing_manual_pairing
from pymobiledevice3.exceptions import NoDeviceConnectedError, RemotePairingCompletedError
from pymobiledevice3.remote.tunnel_service import (
    PairableHostInfo,
    RemotePairingManualPairingService,
    serve_pairable_host,
)
from pymobiledevice3.remote.utils import get_rsds
from pymobiledevice3.services.installation_proxy import InstallationProxyService


@dataclass
class DeviceInfo:
    udid: str
    name: str
    rsd: object


async def pair_manual() -> bool:
    """Drive device-advertised remotepairing. Returns True if pairing completed."""
    answers = await browse_remotepairing_manual_pairing()
    devices = [
        (addr.full_ip, ans.port, ans.properties["name"], ans.properties["identifier"])
        for ans in answers
        for addr in ans.addresses
    ]
    if not devices:
        return False
    ip, port, name, identifier = devices[0]
    print(f"  pairing with {name} ({ip}) — approve on the device if asked")
    async with RemotePairingManualPairingService(identifier, ip, port) as service:
        try:
            await service.connect(autopair=True)
        except RemotePairingCompletedError:
            pass  # record already saved; the device closes the connection
    return True


async def pair_host(pin_echo=print) -> bool:
    """Advertise as a pairable Mac and accept a device-initiated pairing."""
    info = PairableHostInfo(name=platform.node() or "PC", model="Mac17,7")

    def on_pin(pin: str) -> None:
        pin_echo(f"\n  *** Enter this code on the device: {pin} ***\n")

    def waiting(elapsed: float) -> None:
        pin_echo(f"  waiting for the device… ({int(elapsed)}s)", end="\r")

    print(
        "  On the phone:\n"
        "    1. Settings > Privacy & Security > Developer Mode → ON (reboots once)\n"
        "    2. Phone on the same Wi-Fi as this PC\n"
        '    3. Settings > Developer > Paired Macs → pick this PC under "Other Devices"\n'
        "    4. Tap Pair and enter the code below"
    )
    result = await serve_pairable_host(
        info, pin_callback=on_pin, waiting_callback=waiting
    )
    peer = getattr(result, "device_info", None) or getattr(result, "peer", result)
    print(f"\n  paired with {getattr(peer, 'name', 'device')} "
          f"({getattr(peer, 'udid', 'unknown udid')})")
    return True


async def find_device(udid: str | None = None, timeout: float = 10.0) -> DeviceInfo:
    """Locate a paired device over remoted and return its info."""
    rsds = await get_rsds(bonjour_timeout=timeout, udid=udid)
    if not rsds:
        raise NoDeviceConnectedError(
            "No reachable device — is the phone on this Wi-Fi, unlocked, "
            "Developer Mode on, and paired (`ptinstall pair`)?"
        )
    rsd = rsds[0]
    info = rsd.peer_info.get("Properties", {}) if rsd.peer_info else {}
    return DeviceInfo(
        udid=getattr(rsd, "udid", None) or info.get("UniqueDeviceID", ""),
        name=info.get("DeviceName") or info.get("name") or "iPhone",
        rsd=rsd,
    )


async def install_ipa(ipa_path: Path, udid: str | None = None) -> DeviceInfo:
    """Install a signed IPA on the device via installation_proxy over RSD."""
    device = await find_device(udid)
    svc = InstallationProxyService(lockdown=device.rsd)
    try:
        await svc.install_from_local(ipa_path, developer=True)
    finally:
        close = getattr(svc, "close", None)
        if close:
            out = close()
            if asyncio.iscoroutine(out):
                await out
    return device
