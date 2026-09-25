# Pageturner

An offline-capable, installable e-reader and audiobook player PWA. Everything runs locally in the browser — no server required.

## Features

- **Reading:** EPUB, MOBI/AZW3, FB2/FBZ, CBZ and CBR comics, PDF, TXT/Markdown/HTML
- **Audiobooks:** M4B/M4A/MP3/FLAC/OGG/OPUS/WAV — multi-file books with per-file or embedded chapters, speed control, sleep timer with a live countdown, time left in the chapter, a Now Playing screen tinted from the cover, resume position, lock-screen controls with a scrubbable position
- **One voice at a time:** read-aloud and the audiobook player yield to each other rather than both playing
- **Text-to-speech:** read-aloud with device voices (Web Speech API) or on-device neural voices (Piper + ONNX Runtime WASM — no audio leaves the device)
- **In-book search:** full-text search with live results and highlighted matches, across EPUB-family books, PDFs and plain text
- **Bookmarks & highlights:** select text to highlight, copy or share it; bookmark any page; both listed alongside the table of contents
- **Footnotes in place:** note references open in a popover instead of throwing you into the endnotes, and any jump — note, cross-reference or search hit — leaves a Back chip
- **Metadata:** automatic lookup via Google Books + Open Library, candidate picker when the match is ambiguous, manual editing
- **Library:** local-first — books, covers, and reading progress persist in IndexedDB; search, sort, and a Books/Audiobooks filter; Continue-reading card resumes in one tap; select mode for bulk delete and bulk metadata lookup
- **Covers for everything:** books without art get a designed cover (title and author on a book-cloth colour chosen from the title), legible from thumbnail to full screen
- **Book page:** progress and when you last opened it, the description, a primary action worded for where you are (Read / Continue reading / Read again), and a nudge when details are missing
- **Backup:** export the whole library (books, covers, positions) to one zip and restore it here or on another device
- **Installable:** iOS-style design, Add to Home Screen on iOS, generated iOS launch images, standalone display, offline via service worker
- **OS integration:** share-target import, and file handlers — double-click a book to open it in the installed app
- **Progress:** mark a book finished or start it over from the library's detail sheet
- **Keyboard:** arrows/space turn pages, `F` or `/` searches, `T` opens contents, `B` bookmarks, `+`/`−` sets text size, `Esc` steps back out

## Install on iOS

Open the deployed site in **Safari** → Share → **Add to Home Screen**.

> The app is fully self-hosted (vendored parser/TTS engines) and works offline.
> Neural TTS voices download once (~60 MB per voice) and are cached for offline use.

## Usage

Serve the `docs/` directory over HTTP(S) — it is a plain static site:

```bash
npx serve docs
```

## Development

```bash
npm install          # install dev dependencies
npm test             # run unit tests (vitest)
npm run lint         # run ESLint
npm run smoke        # end-to-end headless-Chrome smoke test (imports a real EPUB into IndexedDB and opens the reader)
npm run vendor       # rebuild docs/vendor/ from node_modules
npm run icons        # regenerate PWA/touch icons + iOS launch images from icon.svg
npm run version      # rewrite the version into every file that carries it
```

### Releasing

`package.json` holds the version people see and a `build` number; everything
else is generated from them by `scripts/version.js`:

| Written to | What it sets |
| --- | --- |
| `docs/js/version.js` | `VERSION` / `BUILD`, shown in Settings → About |
| `docs/sw.js` | the `pageturner-cache-v*` / `pageturner-runtime-v*` names |
| `docs/index.html` | the Settings → Version row |
| `ios/project.yml` | `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` |
| `package-lock.json` | the root package's own version (nothing else in the lockfile) |

```bash
npm run version:bump     # build only — ships the same version to installed apps
node scripts/version.js 2.5.0   # new version, build bumped with it
npm run version:check    # CI fails if any of them drifted apart
```

Bumping the build is what makes a deploy reach an already-installed PWA: the
service worker keys its caches on that number, so a new build replaces the
cached app shell instead of serving last week's copy.

## Architecture

No build step — the app is vanilla ES modules served statically. All heavy
dependencies are vendored into `docs/vendor/` so the app works offline and
under a strict CSP (no inline scripts, no CDN).

```text
docs/
├── index.html            # app shell (library / reader / player / settings + sheets)
├── manifest.json         # PWA manifest (standalone, maskable icons)
├── sw.js                 # service worker: app shell + runtime cache for lazy vendor assets
├── css/main.css          # the whole stylesheet (themes, sheets, reader chrome)
├── js/
│   ├── app.js            # boot, tabs, theme, mini-player
│   ├── db.js             # IndexedDB (books, file blobs, settings, progress)
│   ├── detect.js         # format detection (magic bytes + extension)
│   ├── importer.js       # import pipeline: parse, persist, auto-metadata
│   ├── library.js        # library grid, detail sheet, metadata picker/edit UI
│   ├── reader.js         # foliate-js host: EPUB/MOBI/AZW3/FB2/CBZ(+CBR), themes, progress
│   ├── reader-text.js    # TXT/MD/HTML renderer
│   ├── reader-pdf.js     # PDF.js renderer
│   ├── cbr.js            # CBR (RAR) → CBZ repack via unrar WASM + fflate
│   ├── tts.js            # read-aloud controller: scheduling, pause/resume, skip
│   ├── tts-engines.js    # speech backends: Web Speech, Piper, Kokoro + settings
│   ├── tts-voices.js     # voice picker, previews, sleep timer
│   ├── tts-foliate.js    # read-aloud block/highlight adapter for foliate-view
│   ├── player.js         # audiobook player: chapters, speed, sleep timer, MediaSession
│   ├── book-parser.js    # filename/ID3 book+chapter inference for audio imports
│   ├── metadata.js       # Google Books / Open Library lookup + candidate matching
│   ├── backup.js         # whole-library zip export / restore
│   ├── zip.js            # stored-entry ZIP/ZIP64 writer + random-access reader over Blobs
│   ├── audio-focus.js    # read-aloud and the audiobook player never play at once
│   ├── util.js           # DOM helpers, toasts, bottom sheets, search helpers
│   ├── version.js        # generated — VERSION / BUILD
│   └── sw-register.js    # SW registration, update prompt, offline indicator
└── vendor/               # vendored engines (rebuilt by npm run vendor)
    ├── foliate/          # foliate-js reader engine
    ├── pdfjs/            # PDF.js
    ├── piper/            # piper-tts-web + phonemize WASM/data
    ├── kokoro/           # kokoro-js (HQ voice, WebGPU) + ORT JSEP build
    ├── ort/              # onnxruntime-web (non-threaded WASM)
    ├── unrar.*           # RAR extraction (CBR support)
    ├── fflate.mjs        # zip writer
    └── music-metadata.mjs # audio tag/chapter parser (ESM bundle)
```

## Notes & limitations

- **CBR** files are unpacked in-browser (RAR WASM) and repacked as CBZ; very large archives are memory-bound.
- **MOBI/AZW3** support is via foliate-js; DRM-locked files cannot be opened.
- **Piper TTS** requires `wasm-unsafe-eval` (already in the CSP) and downloads voice models from Hugging Face on first use per voice.
- **KFX** (Kindle) files are DRM-locked containers and are rejected on import with an explanation rather than a generic failure.
- **A native iOS app** lives in `ios/` (SwiftUI on the Readium toolkit, built as an unsigned IPA by `.github/workflows/ios.yml`); see `AGENTS.md`. The PWA remains the supported install route.
- Google Drive integration from the previous Forge version was removed — the app is local-first.
- **iOS launch images** are generated per device size (iOS only uses an exactly matching `apple-touch-startup-image`), portrait only. `npm run icons` writes both the PNGs and the `<link>` tags between the `launch-images` markers in `index.html`.
- **Backups** are plain zips of stored entries (books and audio are already compressed), with ZIP64 for libraries or files over 4 GiB. `docs/js/zip.js` assembles the archive by reference from IndexedDB's Blobs, so exporting never copies the library into memory, and restores through the central directory with `Blob.slice()`. Archives open in any unzip tool; backups from earlier versions (deflated) still restore.
- **Neural voices stay on the device.** Choosing a voice downloads it once (about 60 MB) with its engine files; Settings → Saved voices lists what's kept, with sizes, and removes voices. Voices are stored in the Cache API — upstream piper-tts-web used OPFS `createWritable()`, which Safari lacks, so on iPhone and iPad nothing was ever saved and the voice re-downloaded every session (patched in `scripts/patch-piper.js`, so it survives `npm run vendor`). The service worker now retires only its own versioned caches, keeps engine binaries in `pageturner-engines` across updates, and re-checks them with a conditional request when a new version activates.
- **Read-aloud memory on iOS.** The Piper phonemizer is an Emscripten program whose `callMain()` pushes its arguments (the sentence included) onto the WebAssembly stack and never pops them. It's meant to run once, so reusing one instance per session ran `main()` off the end of the stack after ~100 sentences, and iOS closed the page ("A problem repeatedly occurred"). `scripts/patch-piper.js` restores the stack pointer after each call, drops an instance that fails anyway, and adds `TtsSession.release()` so a voice that's switched away from or previewed gives its ONNX memory back (it used to stay resident, ~60–110 MB a voice). `tests/piper-patch.test.js` runs 400 sentences through one phonemizer. The Kokoro HQ voice isn't offered on iPhone and iPad even where WebGPU exists: its ~330 MB fp32 model is more than iOS lets a page hold.
- **Automatic metadata** only applies a match whose core title is identical (and whose author agrees, when both are known). A title that merely contains yours — "The Salt Road" vs "The Salt Roads" — is left for the manual picker rather than silently giving the book someone else's cover.
- **Light theme contrast:** the amber accent is used as a fill; text and icons on light surfaces use a deeper amber (`--accent-ink`, ≥4.6:1).
- **Storage** is the browser's. Settings → About warns when the quota is nearly full or persistent storage wasn't granted; an exported backup is the only copy that survives the browser clearing site data.
- The manifest has no `screenshots`, so Android/desktop install prompts show the plain variant.
- **Rotation** re-renders PDF pages (their canvases are sized when drawn) and restores the reading fraction in the text renderer, whose scroll offset is absolute. EPUBs reflow through foliate's own `ResizeObserver`.
