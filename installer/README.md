# ptinstall — install Pageturner on an iPhone, the easy way

A self-contained Windows tool that replaces the AltStore/SideStore/Sideloadly
dance for installing this repo's IPA:

```
pair once → install forever (one command)
```

It downloads `Pageturner.ipa` from the `ios-latest` GitHub release, signs it
with a certificate fetched from Apple's developer services using your Apple ID,
and pushes it to your iPhone **over Wi-Fi** — no iTunes, no AltServer, no Mac,
no on-device helper app.

## What it can and can't change

Free Apple IDs are capped by Apple, not by this tool:

- **7-day expiry.** A free-account certificate lives 7 days, so the app has to
  be re-signed weekly — that's re-running one command, same as every other
  sideload method. A paid Developer account lifts this to a year.
- **3-app / 10-App-ID limits** — same Apple-side caps everyone hits.
- **Developer Mode** must be on for developer installs (one-time,
  Settings → Privacy & Security → Developer Mode).
- First run needs your Apple ID + a 2FA code (sent to your trusted devices).
  The password is never stored — it's prompted per run (or set
  `PTINSTALL_APPLE_PASSWORD` in env if you'd rather not type it).

What it *does* make easier: no iTunes install, no PC-companion-app running in
the background, no VPN tunnel, no manual IPA wrangling, and the device
connection is pure Wi-Fi (remote-pairing + RSD, iOS 17+).

## Setup

**Easiest:** grab `ptinstall.exe` from the `installer-latest` release (CI
builds it on every change; publish it with a manual run of *ptinstall exe*) —
one file, nothing to install, run it from anywhere.

**Or run from source:**

```bat
cd installer
pip install -r requirements.txt
python -m ptinstall …
```

Optional but recommended — local anisette generation (avoids the remote
anisette server entirely):

```bat
pip install pyprovision
```

## Use it

**One-time pairing** (phone + PC on the same Wi-Fi):

```bat
python -m ptinstall pair
```

If the phone isn't found automatically, run `python -m ptinstall pair --mode host`
and on the phone: *Settings → Developer → Paired Macs* → pick this PC → enter
the code shown.

**Install the latest build:**

```bat
python -m ptinstall install --apple-id you@example.com
```

First time: Apple pushes a 6-digit code to your trusted devices — type it when
asked. The tool registers the phone's UDID on your account (once), creates the
App ID `io.github.possiblypengu.pageturner.<teamid>`, fetches a development
cert + profile, downloads and signs the IPA, and installs it.

**Weekly refresh** (free-cert expiry):

```bat
ptinstall refresh
```

Same as `install`, and it reuses the cached IPA when the release hasn't
moved — just re-signs and pushes.

## Commands

| command | what it does |
|---|---|
| `pair [--mode auto\|host]` | pair PC ↔ phone |
| `devices` | list reachable paired devices + UDIDs |
| `download [-o path]` | fetch the latest unsigned IPA |
| `sign ipa out --p12 p --profile f [--bundle-id id]` | sign a local IPA with an existing cert |
| `install [opts]` | the full pipeline |
| `refresh [opts]` | same as `install` — the weekly re-sign-and-push |

Useful `install` flags: `--ipa path` (sign/install a local IPA instead of
downloading), `--udid X` (pick a device), `--anisette local|remote`,
`--anisette-url URL` (custom anisette server), `--no-sign` (install an
already-signed IPA, no Apple ID needed).

Env vars: `PTINSTALL_APPLE_ID`, `PTINSTALL_APPLE_PASSWORD`,
`PTINSTALL_ANISETTE_URL`.

## How it works (the honest version)

- **Cert**: `gsa.apple.com` GrandSlam SRP-6a login (the Xcode flow, same as
  AltSign), then `developerservices2.apple.com` provisioning plist calls —
  register UDID → App ID → submit RSA-2048 CSR → download cert + team
  provisioning profile. The cert lands in `%APPDATA%\PTInstall`.
- **Anisette**: `pyprovision` generates it locally if installed; otherwise a
  configurable anisette-v3 server (SideStore's public one by default).
- **Sign**: `zsign` (auto-downloaded, checksum-verified), bundle ID rewritten
  to the registered App ID — free profiles only cover their exact App ID.
- **Install**: `pymobiledevice3` — remote-pairing handshake over Wi-Fi, then
  `installation_proxy` through the iOS 17+ RSD shim. Nothing Apple-proprietary
  is needed on the PC.

## Untested-on-live-hardware bits

The Apple-ID login + 2FA and the phone pairing/install path are implemented
against AltSign/pymobiledevice3's exact protocols but haven't been run against
a real account/device from this repo yet — first-run hiccups (anisette source,
2FA flavor, pairing state) are expected and should be quick to fix.
