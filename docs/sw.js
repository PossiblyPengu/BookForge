
const CACHE_NAME = 'pageturner-cache-v30';
const RUNTIME_CACHE = 'pageturner-runtime-v30';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/main.css',
  './js/app.js',
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(key => key !== CACHE_NAME && key !== RUNTIME_CACHE && key !== 'shared-files')
        .map(key => caches.delete(key)))
    )
  );
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
      return fetch(event.request).then(response => {
        if (response.ok && event.request.url.includes('/vendor/')) {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
