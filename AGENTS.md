# AGENTS.md

## iOS app (`ios/`)

`ios/` contains **Pageturner**, a native SwiftUI EPUB/PDF reader built on the
Readium Swift toolkit (pinned to 3.11.0). Features: Files/share-sheet import,
library grid, EPUB navigator with themes/fonts, PDF navigator, read-aloud via
Apple's speech synthesizer that keeps playing with the screen locked.

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
