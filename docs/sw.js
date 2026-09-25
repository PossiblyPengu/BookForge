
const CACHE_NAME = 'pageturner-cache-v43';
const RUNTIME_CACHE = 'pageturner-runtime-v43';
// Engine binaries (ONNX runtime, espeak data, model weights): ~30 MB that
// rarely changes. Kept across app updates rather than re-downloaded with every
// build, and re-checked with a cheap conditional request when a new version
// activates, so a changed binary still arrives.
const ENGINE_CACHE = 'pageturner-engines';
// Only these are this worker's to delete. Downloaded voices (pageturner-voices),
// the HQ model (transformers-cache, kokoro-voices) and shared files are not
// tied to a build and must survive updates.
const OWN_VERSIONED = /^pageturner-(cache|runtime)-v\d+$/;
const isEngineAsset = (url) => url.includes('/vendor/') && /\.(wasm|data|onnx|bin)(\?|$)/.test(url);
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/main.css',
  './js/app.js',
  './js/audio-focus.js',
  './js/backup.js',
  './js/book-parser.js',
  './js/cbr.js',
  './js/db.js',
  './js/detect.js',
  './js/importer.js',
  './js/library.js',
  './js/metadata.js',
  './js/player.js',
  './js/reader.js',
  './js/reader-pdf.js',
  './js/reader-text.js',
  './js/sw-register.js',
  './js/tts.js',
  './js/tts-engines.js',
  './js/tts-foliate.js',
  './js/tts-voices.js',
  './js/util.js',
  './js/version.js',
  './js/zip.js',
  './vendor/foliate/view.js',
  './vendor/foliate/paginator.js',
  './vendor/foliate/epub.js',
  './vendor/foliate/mobi.js',
  './vendor/foliate/fb2.js',
  './vendor/foliate/comic-book.js',
  './vendor/foliate/fixed-layout.js',
  './vendor/foliate/epubcfi.js',
  './vendor/foliate/overlayer.js',
  './vendor/foliate/progress.js',
  './vendor/foliate/text-walker.js',
  './vendor/foliate/search.js',
  './vendor/foliate/footnotes.js',
  './vendor/foliate/tts.js',
  './vendor/foliate/dict.js',
  './vendor/foliate/opds.js',
  './vendor/foliate/quote-image.js',
  './vendor/foliate/uri-template.js',
  './vendor/foliate/vendor/zip.js',
  './vendor/foliate/vendor/fflate.js',
  './vendor/foliate/ui/menu.js',
  './vendor/foliate/ui/tree.js',
  './vendor/music-metadata.mjs',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/fflate.mjs',
  './vendor/unrar.mjs',
  './vendor/unrar.wasm',
  './icons/apple-touch-icon.png',
  './icons/apple-touch-icon-120.png',
  './icons/apple-touch-icon-152.png',
  './icons/apple-touch-icon-167.png',
  './icons/apple-touch-icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    // cache: "reload" skips the HTTP cache. Without it a new worker could
    // re-cache day-old copies of the app (js/css are served with max-age),
    // so a deploy didn't reach installed apps — or reached them half old,
    // half new.
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(APP_SHELL.map(url => new Request(url, { cache: "reload" }))))
  );
  self.skipWaiting();
});

/**
 * Re-check each cached engine binary against the server. A 304 costs a few
 * hundred bytes; only a binary that actually changed downloads again.
 */
const revalidateEngines = async () => {
  const cache = await caches.open(ENGINE_CACHE);
  for (const req of await cache.keys()) {
    const old = await cache.match(req);
    const headers = {};
    const etag = old && old.headers.get('etag');
    const modified = old && old.headers.get('last-modified');
    if (etag) headers['If-None-Match'] = etag;
    else if (modified) headers['If-Modified-Since'] = modified;
    try {
      const res = await fetch(req.url, { headers, cache: 'no-store' });
      if (res.status === 200) await cache.put(req, res);
      // 304: unchanged. Anything else (offline, 5xx): keep what we have.
    } catch { /* offline — keep it */ }
  }
};

// Activate: retire this app's previous versioned caches — and nothing else.
// It used to delete every cache but the current ones, which threw away the
// downloaded HQ voice and all the engine files on every update.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const engines = await caches.open(ENGINE_CACHE);
    for (const key of await caches.keys()) {
      if (!OWN_VERSIONED.test(key) || key === CACHE_NAME || key === RUNTIME_CACHE) continue;
      // earlier builds kept engine binaries in the per-build runtime cache —
      // carry them over rather than downloading them again
      if (key.startsWith('pageturner-runtime-')) {
        const old = await caches.open(key);
        for (const req of await old.keys()) {
          if (isEngineAsset(req.url) && !(await engines.match(req))) {
            const res = await old.match(req);
            if (res) await engines.put(req, res);
          }
        }
      }
      await caches.delete(key);
    }
    await revalidateEngines();
  })());
  self.clients.claim();
});

// Listen for SKIP_WAITING message from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Web Share Target — receive shared files and redirect to the app
self.addEventListener('fetch', event => {
  if (event.request.method === 'POST' && event.request.url.startsWith(self.location.origin)) {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const files = formData.getAll('files');
        const cache = await caches.open('shared-files');
        for (let i = 0; i < files.length; i++) {
          const response = new Response(files[i], {
            headers: { 'x-file-name': files[i].name || '' }
          });
          await cache.put(`shared-file-${i}`, response);
        }
        return Response.redirect('./?shared=' + files.length, 303);
      })()
    );
    return;
  }
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      // Runtime cache: vendor files (pdf worker, wasm, voices) fetch lazily —
      // store them so they keep working offline after first use.
      // Revalidate vendor files rather than trusting the HTTP cache (they're
      // served with a 7-day max-age), so a patched library reaches installed
      // apps on the next deploy instead of a week later.
      const req = event.request.url.includes('/vendor/')
        ? new Request(event.request, { cache: 'no-cache' })
        : event.request;
      return fetch(req).then(response => {
        // status 200 only: a 206 partial response can't be cached
        if (response.status === 200 && event.request.url.includes('/vendor/')) {
          const clone = response.clone();
          caches.open(isEngineAsset(event.request.url) ? ENGINE_CACHE : RUNTIME_CACHE)
            .then(c => c.put(event.request, clone))
            .catch(() => {});
        }
        return response;
      });
    })
  );
});
