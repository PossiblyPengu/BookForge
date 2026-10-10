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
- This machine has no Swift toolchain, so the only compile check is the macOS
  runner. Push, then read the run's result before pushing again — the workflow
  cancels an in-progress run on the same branch, so back-to-back pushes never
  report. Compiler errors are in the job log (`grep "error: "`).
- Deployment target is iOS 17. Stores that predate it (`LibraryStore`,
  `ReaderModel`, `AudioPlayer`) are `ObservableObject`; newer code
  (`BookMaster`, `FolderWatcher`) uses `@Observable`.

### UI structure (Liquid Glass; see `ios/DESIGN.md`)

- `Design/Glass.swift` is the only place that touches `glassEffect` / `GlassEffectContainer`
  and the `.glass` button styles — call its `ptGlass`, `PTGlassGroup`, `ptButtonStyle` helpers,
  never `#available(iOS 26, *)` at a call site. Glass is for controls floating over content, not content.
- `App/RootView.swift` is the tab shell (iOS 26.1+: glass `TabView` with `tabViewBottomAccessory`;
  older: plain tabs with the mini player as an inset). `App/AppRouter.swift` decides what presents
  over the tabs (reader, book sheets, settings).
- Audiobooks play through `Audio/PlaybackCoordinator.swift`; `NowPlayingView` and `MiniPlayer` observe it.
- `tabViewBottomAccessory(isEnabled:)` is iOS 26.1; the plain `tabViewBottomAccessory` is 26.0.

### BookMaster link (`ios/Pageturner/BookMaster/`)

- `BookMasterClient` mirrors `docs/js/bookmaster.js`: pushes to
  `https://pageturner.pages.dev/api/bookmaster/<route>`; the Pages Function holds
  `PAGETURNER_SECRET`. Route names must be in that function's `ROUTES` set.
- Payloads follow BookMaster's `functions/_lib/routes/pageturner.ts`: ids are
  strings, `at` on a session is milliseconds (a number), percents are 0–100.
- Offline: progress is de-duplicated per title, sessions and quotes always queue,
  oldest first, a 4xx is dropped. Presence beats are never queued.
- Linking: `ASWebAuthenticationSession` → bookmaster.pages.dev/link/pageturner →
  `pageturner.pages.dev/?bm-link=<code>` → `docs/js/native-link.js` redirects to
  `pageturner://link?code=<code>`. Keep that script (and its precache entry in
  `docs/sw.js`) for as long as the site is deployed.
