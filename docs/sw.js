/**
 * sw.js — BookForge PWA service worker
 *
 * Caches the app shell for offline use. Works alongside coi-serviceworker.js
 * (which handles COEP/COOP headers for SharedArrayBuffer support).
 */

const CACHE_NAME = "bookforge-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/main.css",
  "./js/app.js",
  "./js/book-lookup.js",
  "./js/book-parser.js",
  "./js/compiler.js",
  "./js/drive-ui.js",
  "./js/gdrive.js",
  "./js/history.js",
  "./js/metadata.js",
  "./js/session.js",
  "./js/waveform.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only cache same-origin requests (don't interfere with API calls)
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML, cache-first for assets
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});
