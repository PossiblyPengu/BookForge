# Pageturner

An offline-capable, installable e-reader and audiobook player PWA. Everything runs locally in the browser — no server required.

## Features

- **Reading:** EPUB, MOBI/AZW3, FB2/FBZ, CBZ and CBR comics, PDF, TXT/Markdown/HTML
- **Audiobooks:** M4B/M4A/MP3/FLAC/OGG/OPUS/WAV — multi-file books with per-file or embedded chapters, speed control, sleep timer, resume position, lock-screen (MediaSession) controls
- **Text-to-speech:** read-aloud with device voices (Web Speech API) or on-device neural voices (Piper + ONNX Runtime WASM — no audio leaves the device)
- **Metadata:** automatic lookup via Google Books + Open Library, candidate picker when the match is ambiguous, manual editing
- **Library:** local-first — books, covers, and reading progress persist in IndexedDB
- **Installable:** iOS-style design, Add to Home Screen on iOS, standalone display, offline via service worker

## Install on iOS

Open the deployed site in **Safari** → Share → **Add to Home Screen**.

> The app is fully self-hosted (vendored parser/TTS engines) and works offline.
> Neural TTS voices download once (~50 MB per voice) and are cached for offline use.

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
npm run icons        # regenerate PWA/touch icons from icon.svg
```

## Architecture

No build step — the app is vanilla ES modules served statically. All heavy
dependencies are vendored into `docs/vendor/` so the app works offline and
under a strict CSP (no inline scripts, no CDN).

```text
docs/
├── index.html            # app shell (library / reader / player / settings + sheets)
├── manifest.json         # PWA manifest (standalone, maskable icons)
├── sw.js                 # service worker: app shell + runtime cache for lazy vendor assets
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
│   ├── tts.js            # TTS controller: Web Speech + Piper WASM engines
│   ├── player.js         # audiobook player: chapters, speed, sleep timer, MediaSession
│   ├── book-parser.js    # filename/ID3 book+chapter inference for audio imports
│   ├── metadata.js       # Google Books / Open Library lookup + candidate matching
│   ├── util.js           # DOM helpers, toasts, bottom sheets
│   └── sw-register.js    # SW registration, update prompt, offline indicator
└── vendor/               # vendored engines (rebuilt by npm run vendor)
    ├── foliate/          # foliate-js reader engine
    ├── pdfjs/            # PDF.js
    ├── piper/            # piper-tts-web + phonemize WASM/data
    ├── ort/              # onnxruntime-web (non-threaded WASM)
    ├── unrar.*           # RAR extraction (CBR support)
    ├── fflate.mjs        # zip writer
    └── music-metadata.mjs # audio tag/chapter parser (ESM bundle)
```

## Notes & limitations

- **CBR** files are unpacked in-browser (RAR WASM) and repacked as CBZ; very large archives are memory-bound.
- **MOBI/AZW3** support is via foliate-js; DRM-locked files cannot be opened.
- **Piper TTS** requires `wasm-unsafe-eval` (already in the CSP) and downloads voice models from Hugging Face on first use per voice.
- **Native iOS packaging** (Capacitor) is possible but requires macOS + Xcode; the PWA path is the supported install route.
- Google Drive integration from the previous Forge version was removed — the app is local-first.
