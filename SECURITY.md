# Pageturner Security Notes

Pageturner is a static, local-first PWA. There is no application server — all
parsing, playback, and storage happen in the browser on the user's device.

## Supply chain

- **No CDN dependencies.** Every script, parser, and TTS engine is vendored
  under `docs/vendor/` and served from the same origin. `npm run vendor`
  rebuilds the vendor tree from `node_modules`, so vendored code tracks
  `package-lock.json`.
- **CSP** (`docs/index.html`): `default-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`. The
  `wasm-unsafe-eval` exception is required by the ONNX/Piper WASM engines and
  permits compiling WASM only — not `eval()` on strings.
- **Security headers** (`docs/_headers`, served by Cloudflare Pages):
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` denies
  camera/microphone/geolocation, plus cache rules that keep HTML/JS fresh
  while caching icons and vendor assets.

## Data & privacy

- **Library storage is on-device** (IndexedDB). Book files, covers, progress,
  and settings never leave the device except for the lookups listed below.
- **Metadata lookup is the only feature that phones home.** Automatic and
  manual metadata search sends the book's title/author to Google Books and
  Open Library, and covers are fetched from those hosts. Settings → Metadata
  can disable online lookups; the queries and endpoints are in
  `docs/js/metadata.js`. With lookups off the app makes no network requests
  beyond its own files.
- **Neural TTS voices** download once from Hugging Face (`huggingface.co`
  in `connect-src`) and are cached for offline use. Speech synthesis itself
  runs entirely on-device (Piper/Kokoro WASM or the OS speech synthesizer).
- **Backups** are plain zips written locally; restoring validates the format
  before touching IndexedDB.

## Untrusted content handling

- **HTML books** render inside a `sandbox`ed iframe (no scripts, no
  same-origin access); Markdown is escaped before formatting; plain text is
  inserted via `textContent`.
- **Archive import** (ZIP containers, CBR) inspects the central directory
  before unpacking; entry names are treated as display strings only and never
  written to disk as paths.
- **Imported files** are stored as opaque Blobs and rendered through
  vendored parsers; nothing imported is executed.

## Native iOS app

The SwiftUI app under `ios/` is built unsigned on CI. It has the same
local-first posture: files live in the app container, metadata lookups are
the only network calls, and no analytics or third-party SDKs are embedded.

## Reporting

Open an issue at https://github.com/PossiblyPengu/META-GRABBER/issues.
