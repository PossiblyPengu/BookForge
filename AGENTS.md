# AGENTS.md

## iOS app (`ios/`)

`ios/` contains **Pageturner**, a native SwiftUI EPUB/PDF reader built on the
Readium Swift toolkit (pinned to 3.11.0). Features: Files/share-sheet import,
library grid with search/sort, EPUB navigator with themes/fonts, PDF
navigator, in-book search, bookmarks and text highlights (Readium
decorations + a custom EditingAction), read-aloud via Apple's speech
synthesizer (voice/rate, sleep timer, lock-screen controls), an AVPlayer
audiobook player for multi-track m4b/mp3/etc, metadata editing with online
lookup, and zip backup export/restore compatible with the PWA's backup
layout (`data.json` + `files/` + `covers/`; iOS books carry
`platform: "ios"`, web records are mapped on restore).

- There is no Mac on this machine — builds run on GitHub Actions macOS runners.
  `.github/workflows/ios.yml` installs XcodeGen, generates the project from
  `ios/project.yml`, builds unsigned (`CODE_SIGNING_ALLOWED=NO`), and uploads
  `Pageturner.ipa` as a build artifact. Install the IPA with AltStore/SideStore/
  Sideloadly.
- The Xcode project is generated, not committed: `cd ios && xcodegen`.
- When touching Readium calls, verify signatures against the toolkit source —
  the 3.x API changed a lot between releases (e.g. `EPUBNavigatorViewController`
  takes `config:` not `httpServer:`; TTS rate goes through `AVTTSEngineDelegate`).
- Relevant docs live in the readium/swift-toolkit repo under `docs/Guides/`.
