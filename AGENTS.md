# AGENTS.md

## iOS app (`ios/`)

`ios/` contains **Pageturner**, a native SwiftUI reader and audiobook player built on the
Readium Swift toolkit (pinned to 3.11.0), linked to BookMaster. It replaces the PWA in `docs/`
(which stays deployed until the IPA has been tried on a device). See `README.md` for the feature
list and `ios/DESIGN.md` for the Liquid Glass design rules.

### Building and checking

- There is no Mac on this machine — builds run on GitHub Actions macOS runners.
  `.github/workflows/ios.yml` installs XcodeGen, generates the project from `ios/project.yml`,
  builds Release unsigned (`CODE_SIGNING_ALLOWED=NO`) and uploads `Pageturner.ipa` (artifact
  `Pageturner-ipa`). Install it with AltStore/SideStore/Sideloadly. The Xcode project is generated,
  not committed: `cd ios && xcodegen`.
- Push, then read the run's result before pushing again — the workflow cancels an in-progress run
  on the same branch, so back-to-back pushes never report. Compiler errors are in the job log
  (`grep "error: "`); the job summary also lists diagnostics.
- `.github/workflows/ios-sim.yml` is the nearest thing to looking at the app: a **Debug** build in the
  iOS Simulator, launched once per screen (`ios/scripts/simulator-shots.sh`) and photographed; the
  `simulator-screens` artifact holds PNGs, the app's log and any crash report. The launch arguments
  (`-PTDebugScreen`, `-PTDebugSeed`, `-PTDebugReaderSheet`, `-PTDebugSettingsPush`, `-PTDebugVoiceSource`,
  `-PTDebugNeuralProbe <voice key>`, `-PTDebugSpeechProbe`) are read by `Debug/DebugScenario.swift`,
  which is `#if DEBUG` only — none of it is in the IPA. Download with
  `gh api repos/<owner>/<repo>/actions/artifacts/<id>/zip`.
- `ios/Checks/bookmaster/` compiles the app's **real** pure-logic sources (BookMaster client and
  models, the `Book` model, text→EPUB converter, chapters, resume offer, notification plan, jump
  history, highlight export, reading stats, voice lists, neural voice conversion) on Linux with a Swift 6 toolchain and runs them: against a
  live local BookMaster (`run.sh`, needs a BookMaster checkout, `wrangler`, `python3`) or alone
  (`run.sh data`, ~330 checks, no servers). Anything that can be written without UIKit/Readium should
  be, so it can be checked there; `assemble.sh` lists the files it copies. `run.sh` stops if the target fails to
  build (it used to run the previous binary and report green).
- When touching Readium calls, verify signatures against the toolkit source — the 3.x API changed a lot
  between releases. The `Archive Readium sources` CI step uploads the resolved checkout as the
  `readium-src` artifact.
- Deployment target is iOS 17. Stores that predate it (`LibraryStore`, `ReaderModel`, `AudioPlayer`,
  `ReadingLog`) are `ObservableObject`; newer code (`BookMaster`, `FolderWatcher`, `Notifier`,
  `AppRouter`, `PlaybackCoordinator`, `IntentRouter`) uses `@Observable`.

### Gotchas that have cost a build

- A long chain of view modifiers (sheets, alerts, onChange…) can exceed the type checker
  ("unable to type-check this expression in reasonable time"). Split it into helper functions that each
  take and return `some View` — see `RootView` (`screens`/`bookSheets`/`alerts`/`routing`) and `ReaderView`.
- `[String].union` doesn't exist: build a `Set([...])` first.
- `AnyURL ==` is deprecated: use `isEquivalentTo`. `ReadiumShared.PDFDocument` is a protocol that clashes
  with PDFKit's class — write `PDFKit.PDFDocument`. `Link` and `Color` clash with SwiftUI's: write
  `ReadiumShared.Link`; keep Readium's `Color` in files that don't import SwiftUI.
- `tabViewBottomAccessory(isEnabled:)` is iOS 26.1; the plain `tabViewBottomAccessory` is 26.0.
- `.backgroundTask` is a *Scene* modifier, not a View one.
- Catalogue dates are seconds since 1970 on disk but `JSONDecoder`'s default reads 2001-based, which
  moved dates forward 31 years per save. Anything with a `Date` inside `Book` decodes it through
  `StoredDate.read` (see the `Book`, `Bookmark` and `Highlight` decoders).
- Foundation `Process` can hang on Linux; `pkill -f <pattern>` can match its own command line.

### UI structure (Liquid Glass; see `ios/DESIGN.md`)

- `Design/Glass.swift` is the only place that touches `glassEffect` / `GlassEffectContainer` and the
  `.glass` button styles — call its `ptGlass`, `PTGlassGroup`, `ptButtonStyle` helpers, never
  `#available(iOS 26, *)` at a call site. Glass is for controls floating over content, not content.
- `App/RootView.swift` is the tab shell (iOS 26.1+: glass `TabView` with `tabViewBottomAccessory`;
  older: plain tabs with the mini player as an inset). `App/AppRouter.swift` decides what presents over
  the tabs (reader, book sheets, settings, the "continue from BookMaster?" prompt).
- Audiobooks play through `Audio/PlaybackCoordinator.swift`; `NowPlayingView` and `MiniPlayer` observe
  it. Chapters (`Audio/AudioChapter.swift`) are an m4b's embedded markers or one per file.
- The reader (`Reader/`): `ReaderModel` owns the Readium navigator; `JumpHistory` drives the Back chip;
  highlights live on the `Book` (colour, note, chapter, progression) and are painted as decorations;
  `HighlightExport` writes them as Markdown. PDFs are searched by Readium itself (its PDF parser
  registers a content search service).

### BookMaster link (`ios/Pageturner/BookMaster/`)

- `BookMasterClient` mirrors `docs/js/bookmaster.js`: pushes to
  `https://pageturner.pages.dev/api/bookmaster/<route>`; the Pages Function holds `PAGETURNER_SECRET`.
  Route names must be in that function's `ROUTES` set.
- Payloads follow BookMaster's `functions/_lib/routes/pageturner.ts`: ids are strings, `at` on a session
  is milliseconds (a number), percents are 0–100.
- Offline: progress is de-duplicated per title, sessions and quotes always queue, oldest first, a 4xx is
  dropped. Presence beats are never queued. Only a push reply or a shelf pull may change a book's `bm*`
  fields (`LibraryStore.updateBookMaster` / `applyShelf`); `update()` always keeps the stored ones.
- Linking: `BookMasterLinkSheet` (a `WKWebView`, non-persistent data store) opens
  bookmaster.pages.dev/link/pageturner?from=https://pageturner.pages.dev; BookMaster signs the user in and
  sends the browser to `pageturner.pages.dev/?bm-link=<code>`, which the sheet's navigation delegate cancels,
  reading the code off the URL (`BMLinkURL.code(fromReturn:)` — only that host, https, a plausible code).
  Nothing of the web site is involved, so it works whether or not the PWA is deployed. (`pageturner://link?code=`
  and `docs/js/native-link.js` are the older route and still work; the app handles both.) Why not
  `ASWebAuthenticationSession`: its callback came from a page that was never deployed, so linking never completed.
- Notifications are **local** (`Notifications/`): a sideloaded app has no push entitlement, so iOS's
  background refresh (best effort, its schedule) asks BookMaster for new suggestions and posts them.
- Siri/Shortcuts (`Intents/`) and Spotlight (`Library/SpotlightIndexer.swift`) hand requests to the shell
  through `IntentRouter`, which holds them until the first screen exists.
- Read-aloud voices (`Reader/` and `Neural/`): `SpeechVoices.swift` is Foundation-only (list, group, search, "best
  voice for a language", the speed scale) and checked on Linux. Device voices: `SystemVoices.swift`; the shared list
  and the Settings/Reading-sheet rows: `VoiceListView.swift`; **always use `SpeechPreview.shared`** — an
  `AVSpeechSynthesizer` freed while iOS is still calling back into it crashes inside TextToSpeech.
  Neural voices (Piper on sherpa-onnx, the official SwiftPM package `k2-fsa/sherpa-onnx`):
  `NeuralVoiceCatalog.swift` (the bundled `NeuralVoices.json`, made by `scripts/make-neural-catalog.py`, pinned to a
  commit of rhasspy/piper-voices so URLs and MD5s stay true), `NeuralVoiceFormat.swift` (turns a Piper download
  into what sherpa loads: `tokens.txt`, and the voice's facts appended to the `.onnx` as protobuf `metadata_props`
  — byte-identical to sherpa's own conversion, verified by loading it with sherpa-onnx and transcribing the speech),
  `NeuralVoiceStore.swift` (download, MD5 check, install into Application Support, delete), `NeuralSynth.swift`
  (loads a model, makes a sentence on one serial queue), `NeuralPlayer.swift` (AVAudioEngine + time-stretch, so speed
  is exact and changes mid-sentence), `NeuralTTSEngine.swift` (Readium `TTSEngine`, and a composite that routes a voice
  to the right engine). espeak-ng's phoneme data (`ios/Resources/espeak-ng-data`, GPL-3) is bundled; sherpa exits the
  process on a model it can't load, so only files this code wrote itself are ever handed to it.
- Not built, on purpose: a Home Screen widget (app extension + App Group, which free-Apple-ID signing
  doesn't reliably provide) and CarPlay (entitlement).
