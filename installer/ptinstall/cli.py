"""ptinstall — Windows installer for the Pageturner IPA.

Commands:

  pair        Pair this PC with the phone (one-time)
  devices     Show paired/reachable devices
  install     Download → sign → install the latest IPA (the whole flow)
  refresh     Same as install — the weekly re-sign-and-push (reuses the
              cached IPA when the release hasn't changed)
  download    Just download the latest unsigned IPA
  sign        Sign a local IPA with an existing .p12 + .mobileprovision

Env vars: PTINSTALL_APPLE_ID, PTINSTALL_APPLE_PASSWORD, PTINSTALL_ANISETTE_URL.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

from . import config, device, gsa, ota, pipeline, release, signing


def _prompt(prompt="Code: "):
    def fn(msg=prompt):
        try:
            return input(msg)
        except EOFError:
            return ""
    return fn


def cmd_pair(args):
    async def go():
        if args.mode == "host":
            await device.pair_host()
        else:
            ok = await device.pair_manual()
            if not ok:
                print(
                    "No device advertising remotepairing found.\n"
                    "Falling back to pairable-host mode — approve from the phone."
                )
                await device.pair_host()
    asyncio.run(go())


def cmd_devices(args):
    async def go():
        try:
            dev = await device.find_device()
            print(f"{dev.name}\t{dev.udid}")
        except Exception as e:
            print(f"no device: {e}")
    asyncio.run(go())


def cmd_download(args):
    dest = args.out or (config.config_dir() / "Pageturner.ipa")
    release.download_ipa(dest)
    print(dest)


def cmd_sign(args):
    signing.sign_ipa(args.ipa, args.p12, args.profile, args.out, bundle_id=args.bundle_id)
    print(args.out)


def cmd_install(args):
    apple_id = args.apple_id or os.environ.get("PTINSTALL_APPLE_ID")
    password = args.password or os.environ.get("PTINSTALL_APPLE_PASSWORD")
    if not args.no_sign and not apple_id:
        raise SystemExit(
            "Apple ID required to fetch a signing certificate "
            "(--apple-id, or PTINSTALL_APPLE_ID env)."
        )
    workdir = config.config_dir() / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    asyncio.run(
        pipeline.run(
            apple_id=apple_id or "",
            password=password,
            ipa_path=args.ipa,
            udid=args.udid,
            anisette_mode=args.anisette,
            anisette_url=args.anisette_url or os.environ.get("PTINSTALL_ANISETTE_URL"),
            skip_sign=args.no_sign,
            workdir=workdir,
            prompt=_prompt(),
        )
    )


def cmd_ota_sign(args):
    """Headless OTA signing — invoked by the ota-sign workflow. Secrets arrive
    via PTINSTALL_OTA_* env vars so they never appear in argv/logs."""
    env = os.environ.get
    sys.exit(
        ota.run(
            request_id=args.request_id or env("PTINSTALL_OTA_REQUEST_ID", ""),
            udid=args.udid or env("PTINSTALL_OTA_UDID", ""),
            apple_id=args.apple_id or env("PTINSTALL_OTA_APPLE_ID", ""),
            password=args.password or env("PTINSTALL_OTA_PASSWORD"),
            twofa=args.twofa or env("PTINSTALL_OTA_TWOFA", ""),
            device_name=args.device_name
                or env("PTINSTALL_OTA_DEVICE_NAME", "iPhone"),
            ipa_path=args.ipa,
            anisette_mode=args.anisette,
            anisette_url=args.anisette_url or env("PTINSTALL_ANISETTE_URL"),
            anisette_file=args.anisette_file,
            out_dir=args.out_dir,
            host=args.host or env("PTINSTALL_OTA_HOST", ota.DEFAULT_HOST),
            nonce=args.nonce or env("PTINSTALL_OTA_NONCE", ""),
        )
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ptinstall",
        description="Install the latest Pageturner IPA on an iPhone — "
                    "no iTunes, no AltServer.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("pair", help="pair this PC with the phone")
    sp.add_argument("--mode", choices=["auto", "host"], default="auto",
                    help="'auto' browses for the device; 'host' advertises "
                         "this PC (iOS 17+ reliable path)")
    sp.set_defaults(fn=cmd_pair)

    sp = sub.add_parser("devices", help="list reachable paired devices")
    sp.set_defaults(fn=cmd_devices)

    sp = sub.add_parser("download", help="download the latest unsigned IPA")
    sp.add_argument("-o", "--out", type=Path)
    sp.set_defaults(fn=cmd_download)

    sp = sub.add_parser("sign", help="sign a local IPA")
    sp.add_argument("ipa", type=Path)
    sp.add_argument("out", type=Path)
    sp.add_argument("--p12", type=Path, required=True)
    sp.add_argument("--profile", type=Path, required=True)
    sp.add_argument("--bundle-id")
    sp.set_defaults(fn=cmd_sign)

    install_args = argparse.ArgumentParser(add_help=False)
    install_args.add_argument("--apple-id")
    install_args.add_argument("--password", help="Apple ID password "
                                       "(better: PTINSTALL_APPLE_PASSWORD env)")
    install_args.add_argument("--ipa", type=Path,
                              help="use this IPA instead of downloading")
    install_args.add_argument("--udid",
                              help="target device UDID (default: first found)")
    install_args.add_argument("--anisette", choices=["auto", "local", "remote"],
                              default="auto")
    install_args.add_argument("--anisette-url",
                              help="anisette server URL "
                                   "(default: SideStore's public server)")
    install_args.add_argument("--no-sign", action="store_true",
                              help="install --ipa without signing (already signed)")

    sp = sub.add_parser("install", parents=[install_args],
                        help="download → sign → install")
    sp.set_defaults(fn=cmd_install)

    sp = sub.add_parser("refresh", parents=[install_args],
                        help="weekly re-sign-and-push — same as install")
    sp.set_defaults(fn=cmd_install)

    sp = sub.add_parser("ota-sign",
                        help="headless OTA signing for the install page "
                             "(CI use — emits IPA + manifest + status JSON)")
    sp.add_argument("--request-id")
    sp.add_argument("--udid")
    sp.add_argument("--apple-id")
    sp.add_argument("--password")
    sp.add_argument("--twofa", help="trusted-device code from the page")
    sp.add_argument("--device-name")
    sp.add_argument("--ipa", type=Path)
    sp.add_argument("--anisette", choices=["auto", "local", "remote"],
                    default="auto")
    sp.add_argument("--anisette-url")
    sp.add_argument("--anisette-file", type=Path,
                    help="persist the anisette identity across 2FA retries")
    sp.add_argument("--out-dir", type=Path, required=True)
    sp.add_argument("--host", help="install page origin for manifest URLs")
    sp.add_argument("--nonce", help="echoed into the status file so the page "
                                    "can match a run to its dispatch")
    sp.set_defaults(fn=cmd_ota_sign)

    return p


def main(argv=None):
    # Frozen exes inherit the console codepage (cp1252 on many Windows boxes);
    # degrade non-ASCII output to '?' instead of crashing on print.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except KeyboardInterrupt:
        sys.exit(130)
    except (gsa.AuthError, gsa.NeedsTwoFactor, signing.SignError) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
