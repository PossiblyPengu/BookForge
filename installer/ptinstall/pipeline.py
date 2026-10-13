"""End-to-end: release IPA → Apple-ID cert → signed IPA → installed on the phone."""

import asyncio
from pathlib import Path

from . import anisette, config, device, gsa, provision, release, signing


def _stale_ipa(path: Path) -> bool:
    """True when the cached IPA is missing or the release asset moved on."""
    if not path.exists():
        return True
    cfg = config.load()
    return cfg.get("ipa_stamp") != release.asset_stamp()

APP_NAME = "Pageturner"
BASE_BUNDLE_ID = "io.github.possiblypengu.pageturner"


def getpass_fn(prompt="Password: "):
    import getpass
    return getpass.getpass(prompt)


def ensure_cert(
    session: gsa.Session,
    udid: str,
    device_name: str,
    workdir: Path,
) -> provision.CertBundle:
    """Register device + App ID, submit CSR, download cert and profile,
    and materialise signing.p12 / signing.mobileprovision under workdir."""
    team = provision.pick_team(session)
    team_id = team["teamId"]
    print(f"  team: {team.get('name')} ({team_id})")

    if not provision.device_registered(session, team_id, udid):
        print(f"  registering device {device_name} ({udid})…")
        provision.register_device(session, team_id, udid, device_name)

    # Free-account App IDs must be globally unique — append the team ID,
    # which is what AltStore does; the app's bundle id is rewritten to match.
    bundle_id = f"{BASE_BUNDLE_ID}.{team_id}"
    app_id = provision.ensure_app_id(session, team_id, bundle_id, APP_NAME)
    app_id_id = app_id["appIdId"]
    print(f"  app id: {bundle_id}")

    bundle = provision.fetch_cert(session, team_id, app_id_id)
    bundle.bundle_id = bundle_id

    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "signing.p12").write_bytes(bundle.p12)
    (workdir / "signing.mobileprovision").write_bytes(bundle.profile)
    return bundle


def login(apple_id: str, password: str, anisette_mode: str,
          anisette_url: str | None, twofa_prompt) -> gsa.Session:
    headers = anisette.headers(prefer=anisette_mode, url=anisette_url)
    return gsa.authenticate(apple_id, password, headers, twofa_prompt=twofa_prompt)


async def run(
    apple_id: str,
    password: str | None,
    ipa_path: Path | None,
    udid: str | None,
    anisette_mode: str,
    anisette_url: str | None,
    skip_sign: bool,
    workdir: Path,
    prompt=getpass_fn,
) -> None:
    # 1 — device (pairing must already exist)
    print("== device ==")
    dev = await device.find_device(udid)
    if not dev.udid:
        raise SystemExit("Couldn't read the device UDID — check the pairing.")
    print(f"  found: {dev.name} ({dev.udid})")

    signed_path = workdir / "Pageturner-signed.ipa"

    if skip_sign:
        if not ipa_path or not ipa_path.exists():
            raise SystemExit("--no-sign needs --ipa <already-signed.ipa>")
        signed_path = ipa_path
    else:
        # 2 — Apple ID session
        print("== apple id ==")
        if password is None:
            password = prompt(f"Apple ID password for {apple_id}: ")
        session = login(apple_id, password, anisette_mode, anisette_url, prompt)
        print("  signed in")

        # 3 — cert + profile
        print("== certificate ==")
        bundle = ensure_cert(session, dev.udid, dev.name, workdir)

        # 4 — download the unsigned IPA (reuse the cached one if unchanged)
        print("== download ==")
        if ipa_path is None:
            ipa_path = workdir / "Pageturner.ipa"
            if _stale_ipa(ipa_path):
                release.download_ipa(ipa_path)
                cfg = config.load()
                cfg["ipa_stamp"] = release.asset_stamp()
                config.save(cfg)
            else:
                print("  release unchanged — reusing the cached IPA")
        print(f"  ipa: {ipa_path}")

        # 5 — sign
        print("== sign ==")
        signing.sign_ipa(
            ipa_path,
            workdir / "signing.p12",
            workdir / "signing.mobileprovision",
            signed_path,
            bundle_id=bundle.bundle_id,
        )
        print(f"  signed: {signed_path}")

    # 6 — install
    print("== install ==")
    await device.install_ipa(signed_path, udid=dev.udid)
    print(f"  installed on {dev.name} — done")
