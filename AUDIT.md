# Pageturner Full Audit — Findings & Implementation Roadmap

Exhaustive audit of the PWA (docs/), native iOS app (ios/), scripts, tests, CI, and config — 14 confirmed bugs, ~20 hardening items, and a phased roadmap covering web fixes + features and a full iOS feature-parity push (search, bookmarks, sleep timer, metadata, audiobooks, backup).

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Hygiene (H1–H5, H8, H10) | ✅ Done |
| 1 | Web P0+P1 (W1–W8, R1–R11) | ✅ Done |
| 2 | CI/deploy consolidation (H6, H7, H9) | ✅ Done |
| 3 | Web features (F1–F8) | ✅ Done |
| 4 | iOS-0 fixes (I1–I3) | ✅ Done |
| 5 | iOS parity (iOS-1…iOS-6) | ✅ Done — search/sort/detail/edit, bookmarks, in-book search, sleep timer, AVPlayer audiobooks w/ lock screen, text highlights, online metadata lookup, portable zip backup (web↔iOS) |
| 6 | Final pass | ⏳ Pending (last iOS build in flight; then verify + deploy) |

## Summary

This plan records a file-by-file audit of the entire repository and the remediation/feature work to follow. Scope approved by the user: **fix everything found, implement all suggested improvements, full iOS feature-parity push, remove dead Capacitor config, and consolidate deploys on Cloudflare gated by CI**.

Audit coverage: all 22 JS modules in `docs/js/` (read in full), `docs/sw.js`, `docs/index.html`, `docs/manifest.json`, `docs/_headers`, `docs/css/main.css` (section-level review + every selector referenced from JS verified), all 9 Swift sources in `ios/Pageturner/`, `ios/project.yml`, all scripts in `scripts/`, all 9 test files in `tests/`, all 3 GitHub workflows, `package.json`, `eslint.config.js`, `.gitignore`, `capacitor.config.json`, `wrangler.toml`, `README.md`, `AGENTS.md`, `SECURITY.md`, `LICENSE`. Repo is ~14K LOC of first-party code; working tree is clean at `pageturner@2.7.0`.

---

## Findings — confirmed defects

### P0 — Web correctness bugs

| # | File:line | Defect | Fix |
|---|-----------|--------|-----|
| W1 | `docs/js/reader.js:231,233` | Mangled regexes: `/^…S*s+/` and `/s+S*…$/` — backslashes lost before `S`/`s` in search-excerpt word-boundary trimming; the literal char class `S*s+` never matches intended `\S*\s+` | Restore `\S*\s+` / `\s+\S*` escapes; add unit test for excerpt trimming |
| W2 | `docs/js/library.js:450` | `fmtLength` uses `Math.round((sec % 3600) / 60)` → a 1h59.7m book shows **"1h 60m"** | Floor minutes or compute `Math.round(sec/60)` then carry |
| W3 | `docs/js/library.js:592-593` | Two dead ternaries — both branches identical (`"Mark as finished"`, `"Start from the beginning"`); audio wording was clearly meant to differ | Simplify to plain strings, or give audio its own labels ("Mark as listened") |
| W4 | `docs/js/player.js` `closePlayer` | MediaSession action handlers left live after close — lock-screen track/skip buttons call `skipChapter`→`seekGlobal`→`loadFile` on an empty `player.urls` → `audio.src = undefined` → error toast | Clear handlers + `playbackState = "none"` on close (same pattern as `tts.stop()`) |
| W5 | `docs/js/player.js` `openPlayer` | Missing-file early-return leaves `player.book` set → mini-player shows a stale, unplayable book | Reset `player` fields / `updateMini()` before returning |
| W6 | `docs/js/importer.js` `autoMeta` + `docs/js/library.js` `bulkMetadata` | `getBook(id) \|\| book` — if the user deletes the book while the lookup is in flight, the stale object is `putBook`-ed back → **deleted book resurrects** | Bail out when `getBook` returns `undefined` |
| W7 | `docs/manifest.json` | `.zip` is in the share-target `accept` but missing from `file_handlers.accept` — double-clicking a bulk zip on desktop can't reach the app | Add `.zip` (and its MIME types) to file_handlers |
| W8 | `docs/js/backup.js` `restoreBackup` | No `data.v` guard — a future or foreign zip layout restores silently wrong; mid-restore failure leaves orphaned blobs in `files` | Validate `data.v === 1`; stage file writes per-book and skip books whose file keys are missing |

### P0 — iOS correctness bugs

| # | File | Defect | Fix |
|---|------|--------|-----|
| I1 | `ios/Pageturner/Reader/ReadAloud.swift` | `didFailWithError` → `synthesizer.next()` unconditionally — if every utterance fails (missing/broken voice) it burns through the entire book silently | Consecutive-failure counter; stop + surface error after ~3 |
| I2 | `ios/Pageturner/Reader/ReaderModel.swift` | `locationDidChange` → `library.update` → full JSON re-encode + atomic write **on every page turn** | Debounce/coalesce catalog writes (e.g. 1s trailing, flush on background/close) |
| I3 | `ios/Pageturner/Reader/ReadAloud.swift` | Now Playing title uses `publication.metadata.title` instead of `book.title` — shows raw EPUB metadata, not user's edited title | Use `book.title`/`book.author` consistently |

### P1 — Robustness / scale

| # | File | Issue | Approach |
|---|------|-------|----------|
| R1 | `docs/js/importer.js` `expandZip` | `unzipSync` holds archive + **all** decompressed entries in memory — a 500MB audiobook zip peaks ~1GB → iOS OOM | Rewrite on `zip.js readZip` central-directory reader: enumerate entries, inflate per-file via `Blob.stream()`/fflate `AsyncInflate`; keep mimetype/image-only book-zip detection (central dir gives names cheaply) |
| R2 | `docs/js/cbr.js` | Whole RAR + extracted images resident in memory (CBRs are typically 100–500MB) | Accept for now; add size warning above a threshold and document. (Full streaming unrar isn't available in the WASM build.) |
| R3 | `docs/js/db.js` | `DB_VERSION=1` with no upgrade path, no `versionchange` handler, no quota guard — writes throw unhandled rejections in debounced `saveProgress` paths | Add `versionchange`→close+reload toast; wrap debounced saves in try/catch; document kv schema for future v2 migration |
| R4 | `docs/js/app.js` `boot()` | Serial `await init*()` — one throwing init kills the whole boot | Wrap each init individually; a failed module degrades (toast) instead of a dead app |
| R5 | `docs/js/library.js` drop handler | Dropped folders come through `dataTransfer.files` flat — audio files lose directory structure → everything merges into one audiobook | Use `webkitGetAsEntry()` traversal to preserve folder paths (falls back to flat files) |
| R6 | `docs/js/tts.js` | `player.play().then(_startWordSync)` runs even when `play()` failed (onFail already fired) — harmless but sloppy ordering | Gate on success flag or move word-sync start into play's success path |
| R7 | `docs/js/app.js` `reclaim()` | Clears voice/engine caches + OPFS but never calls `piper.reset()` — a live session keeps voiceId/model; next `ensure()` thinks it's ready while the backing cache is gone | Call `piper.reset()` before reclaiming |
| R8 | `docs/js/util.js` + `docs/js/tts-engines.js` | Duplicate `isIOS` helper | Single export in util |
| R9 | `docs/js/util.js` `coverUrl`/`dropCoverUrl` | Object-URL cache keyed by book id — revocation on cover replace/book delete needs verification | Audit all call sites; revoke on delete + cover change (already partially done — confirm and add missing drops) |
| R10 | `docs/index.html` / `docs/_headers` | No `Permissions-Policy` — camera/mic/geo unused by the app | Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` to `_headers` |
| R11 | `docs/js/db.js` / orphan cleanup | No tool to sweep `files` keys not referenced by any book (interrupted restores, old deleteBook bug artifacts) | Settings → storage: "Repair storage" — reconcile `files` vs book fileKeys, report + reclaim bytes |

### P2 — Repo hygiene (all confirmed)

| # | Item | Action |
|---|------|--------|
| H1 | `scripts/.tmp-trace.mjs` — committed one-off debug script | Delete |
| H2 | `package.json` — description still "Convert MP3 chapters into M4B audiobooks"; `main: index.js` doesn't exist; `repository`/`homepage` point to `windsurf-project-2` | Update description/repository/homepage; drop `main` |
| H3 | `SECURITY.md` — entirely stale BookForge doc (Google Drive OAuth, CDN SRI, `constants.js`, `gdrive.js` — none exist) | Rewrite for current architecture: static PWA, no server, IndexedDB, public metadata APIs |
| H4 | `.gitignore` — missing `ios/Pageturner.xcodeproj/`, `ios/build/`, `ios/xcodebuild.log`, `ios/.build/`; stale `/requirements.txt` | Update |
| H5 | `eslint.config.js` — stale ignore `docs/coi-serviceworker.js` (file gone); `npm run lint` doesn't include `scripts/` (the config covers them when run directly) | Remove stale ignore; add `scripts/` to the lint script |
| H6 | `.github/workflows/ci.yml` — GitHub Pages deploy of `docs/` on every push while production is Cloudflare | **Remove** the Pages deploy job (user decision: Cloudflare only) |
| H7 | `.github/workflows/deploy-cloudflare.yml` — deploys on push **without waiting for CI** — a lint/test-failing commit still ships | Gate deploy on green lint+test (merge into one workflow with `needs:`, or `workflow_run` trigger on CI success) |
| H8 | `capacitor.config.json` + `@capacitor/*` deps + `cap:*` scripts — dead; native app is XcodeGen/Readium | **Remove** (user decision) |
| H9 | `ios.yml` — unpinned `macos-15` runner + `latest-stable` Xcode → non-reproducible builds | Pin Xcode version explicitly; keep `-skipPackagePluginValidation`; consider caching SPM checkout |
| H10 | `README.md` — accurate for the PWA but doesn't document the native iOS app/sideloading | Add short iOS section pointing to `ios/` + IPA workflow |

### Verified correct — no fix needed (regression tests only)

- **`tts-foliate.js` boundary logic** (`onPage`, `endsBefore`, `startsBefore`): checked against the WHATWG DOM spec — `START_TO_END` compares *this.end* to *source.start* and `END_TO_START` compares *this.start* to *source.end* (the counterintuitive swapped mapping browsers actually implement). So `onPage` ⇔ `loc.start ≤ range.start < loc.end` — "block begins inside the visible page" — correct. `endsBefore` ⇔ `range.end < loc.start` — "block entirely above the page" — correct. Keep the explanatory comment; add a unit/smoke regression so nobody "fixes" it again.
- `detect.js` dispatch, `metadata.js` normalization/confidence, `zip.js` ZIP64 read/write, `audio-focus.js`, `book-parser.js`, `manifest.json` share-target, `_headers` CSP/security headers, `sw.js` cache strategy + engine-asset migration, `tts.js` lookahead/retry/keepalive architecture, `library.js` search/sort, `openBook` audio→player routing, `expandZip` book-vs-container heuristics, `importer.js` file/dir grouping logic — all reviewed, no defects.

---

## Feature additions — Web/PWA

(Approved "implement everything" scope; ordered by value/risk.)

| # | Feature | Files | Notes |
|---|---------|-------|-------|
| F1 | **Import cancellation + richer progress** — cancel button on the import chip; per-file "3/12 — name" progress for bulk zips | `importer.js`, `library.js`, `index.html` | AbortSignal through `importFiles`/`expandZip`; checkpoints between files |
| F2 | **Folder drag-and-drop** preserving structure | `library.js` | `webkitGetAsEntry` traversal (see R5) |
| F3 | **Backup versioning + progress + safer restore** | `backup.js` | `data.v` guard, export/import progress UI, per-book staging (see W8) |
| F4 | **Storage health panel** — Settings → storage: `navigator.storage.estimate()` usage/quota, cache breakdown, "Repair storage" orphan sweep | `app.js`, `db.js`, `index.html` | New `db` helper `orphanedFiles()`; pairs with R11 |
| F5 | **Metadata robustness** — query cache (dedupe identical lookups in one session), shorter timeout, optional "don't search online" privacy toggle | `metadata.js`, `app.js`, `importer.js` | Toggle gates `autoMeta`/`bulkMetadata`/`runMetaSearch`; document that lookups send title/author to Google/Open Library (privacy note also goes in rewritten SECURITY.md) |
| F6 | **TTS regression coverage for boundary/resume logic** + fixable ordering nits | `tests/`, `scripts/smoke.mjs`, `tts.js` | R6 fix + tests (see Test plan) |
| F7 | **Version-consistency test** — run `scripts/version.js` check mode in CI so generated files can't drift | `scripts/version.js`, `ci.yml`, `package.json` | Small |
| F8 | **Kokoro engine honesty check** — it's gated on WebGPU which iOS lacks; ensure UI clearly explains availability + hides on unsupported devices | `tts-engines.js`, `app.js` | Small UX fix |

## Feature additions — iOS (full parity push, phased)

All native work validates through `.github/workflows/ios.yml` (no local Mac). Verify every Readium call against toolkit **3.11.0** before use.

| Phase | Scope | Files (new/existing under `ios/Pageturner/`) |
|-------|-------|-----------------------------------------------|
| **iOS-0** | Bug fixes I1–I3 + gitignore/Xcode pin | `ReadAloud.swift`, `ReaderModel.swift`, `ios.yml`, `.gitignore` |
| **iOS-1** | **Library parity**: search bar, sort options, book detail sheet (progress, format, "mark finished"/"reset"), delete confirmation, file size/duration display | `LibraryView.swift`, `LibraryStore.swift` (+ new `BookDetailView.swift`) |
| **iOS-2** | **Reader essentials**: in-book search (Readium `Publication.search` / `ContentSearch`), bookmarks list + toggle, in-book sleep timer for read-aloud, jump-back after TTS turn, reading-progress % in chrome | `ReaderModel.swift`, `ReaderView.swift`, `ReadAloud.swift` (+ `BookmarksStore` in catalogue model) |
| **iOS-3** | **Highlights**: Readium decorations API for user highlights + read-aloud word/sentence highlight on EPUB (PDF: sentence highlight only where feasible) | `ReaderModel.swift`, `ReaderView.swift`, new `Highlights.swift` |
| **iOS-4** | **Metadata**: edit sheet (title/author/series/year/description/cover), Google Books + Open Library lookup via `URLSession` with candidate picker (mirroring web `metadata.js` logic), confident-match auto-apply | new `MetadataStore.swift`, `MetadataEditView.swift` |
| **iOS-5** | **Audiobooks**: M4B/MP3/FLAC/etc. import + `AVAudioPlayer` player view with chapters, speed control, sleep timer, lock-screen MediaSession, per-book position persistence | new `AudioPlayerStore.swift`, `AudioPlayerView.swift`; extend `LibraryStore` file-type handling + `project.yml` document types |
| **iOS-6** | **Backup/restore**: export/import the **same zip layout as the PWA** (`data.json`, `files/`, `covers/`) so backups migrate between web and native; reuse web `zip.js` semantics in Swift (`ZIPFoundation` or manual store-method writer) | new `BackupStore.swift`, `project.yml` deps |
| **iOS-7** | **PWA→iOS continuity niceties** (if feasible): import a PWA backup zip directly; share-extension already exists | `BackupStore.swift` |

iOS parity is the largest work item — likely a multi-session effort. Ordering above is dependency-aware (detail sheet before metadata edit; catalogue model extensions before bookmarks/highlights).

---

## Test plan

**New unit tests (`tests/`)**
- `fmtLength` boundary cases (59.7 min → "60m" or carried hour; 1h59.9m → "1h 60m" regression) — W2
- Search-excerpt trimming regexes — W1
- `expandZip` streaming path: nested zip, huge single file, book-zip detection preserved — R1
- `backup` v-guard + per-book staging (mock store) — W8
- `orphanedFiles` reconciliation — R11
- `detectFormat` edge cases: `.zip` vs `.epub` renamed, `.htm`, `.oga` — coverage gap
- `version.js` check-mode — F7

**Smoke test additions (`scripts/smoke.mjs`)**
- TTS resume-at-visible-page assertion (locks in the verified-correct boundary logic)
- Audiobook player: open m4b fixture → play state, chapter skip, seek persist — coverage gap
- Backup round-trip E2E: export → delete book → restore → verify — coverage gap
- Sheet swipe-to-dismiss gesture — coverage gap
- MOBI/CBZ/FB2 fixtures if small samples can be generated in-memory — coverage gap
- Import-cancel path — F1

**iOS testing**
- No XCTest exists today — add a minimal `PageturnerTests` target (catalogue encode/decode, backup zip round-trip, filename metadata parse) runnable via `xcodebuild test -destination 'platform=iOS Simulator'` in `ios.yml`
- Manual: sideload IPA → verify read-aloud failure fix, lock-screen playback, search/bookmarks/highlights

**Verification gates before each web deploy**: `npm run lint` (now incl. `scripts/`), `npm test`, `npm run smoke`, `npm run version:check`, bump `sw.js` cache names (via `npm run version:bump` flow), deploy via `wrangler`, verify `pageturner.pages.dev` loads new build.

---

## Execution order

1. **Phase 0 — Hygiene** (H1–H5, H8, H10): dead files, gitignore, package.json metadata, SECURITY.md rewrite, Capacitor removal, eslint/lint script. Deployable with a version bump.
2. **Phase 1 — Web P0+P1 fixes** (W1–W8, R1–R11): all confirmed web bugs + robustness items + unit tests. Deploy.
3. **Phase 2 — CI/deploy consolidation** (H6, H7, H9): remove Pages job, gate Cloudflare on CI, pin iOS runner/Xcode. Verified by pushing.
4. **Phase 3 — Web features** (F1–F8): import cancel, folder DnD, backup hardening, storage panel, metadata privacy/cache, Kokoro honesty. Deploy each coherent batch.
5. **Phase 4 — iOS-0 fixes**: build via Actions, attach IPA, manually verify.
6. **Phase 5 — iOS parity iOS-1…iOS-6**: sequential, each phase a CI build + IPA. Largest risk items (audiobooks, backup-compat) last.
7. **Final pass**: re-audit diff vs this document; update README/AGENTS.

## Risks / constraints

- **iOS parity scale** — audiobook playback + highlights + backup-compat is a large native effort; each phase stays independently shippable so value lands incrementally.
- **Readium API drift** — every navigator/decorations/search call must be checked against 3.11.0 sources (per AGENTS.md); guessing signatures has already cost one compile-fix cycle.
- **CI-gated deploy** — `workflow_run` fires only on the default branch with workflows already committed; merging lint+test+deploy into one workflow with `needs:` is simpler and preferred.
- **`expandZip` streaming rewrite** — must preserve the mimetype/image-only book-zip detection using central-directory names alone (no full decompress); regression tests in place before swap.
- **Service worker** — every deploy must bump cache names or installed PWAs serve stale code; `version.js` flow handles it but must not be skipped.
- **Backup format** — web and iOS should share `data.json` schema; iOS-6 defines the cross-platform contract — pin `data.v` and write a format doc.
- **iOS PWA storage** — keep `navigator.storage.persist()` behavior; the storage panel (F4) makes eviction risk visible.
- **Privacy** — metadata lookups send book title/author to Google Books/Open Library; the F5 toggle + rewritten SECURITY.md makes that explicit and controllable.
- **`runProgress` dead ternaries** (W3) hint an intended audio-specific wording — confirm desired labels during implementation rather than just collapsing them.

## Open verification items (confirm during implementation, not blocking)

- `smoke.mjs` line ~160 `rangeForChunk` usage — covered by existing assertions.
- Whether `onPage` page-turn behavior is observable in the existing smoke run — add explicit assertion regardless.
- Actual GitHub repo name for `package.json` `repository`/`homepage` fields (can't be verified locally — ask user or use `git remote get-url origin`).
