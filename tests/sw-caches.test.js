/**
 * What survives an app update. The service worker used to delete every cache
 * except the current build's, which threw away downloaded voices, the HQ
 * voice model and ~30 MB of engine files on every deploy. This runs the real
 * sw.js against an in-memory Cache Storage and fires `activate`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW = readFileSync(new URL("../docs/sw.js", import.meta.url), "utf8");
const CURRENT = SW.match(/CACHE_NAME = '(pageturner-cache-v\d+)'/)[1];
const RUNTIME = SW.match(/RUNTIME_CACHE = '(pageturner-runtime-v\d+)'/)[1];
const ORIGIN = "https://app.example";
const u = (path) => `${ORIGIN}${path}`;

/** Minimal Cache Storage: name → Map(url → Response). */
const makeCaches = () => {
  const store = new Map();
  const key = (req) => (typeof req === "string" ? req : req.url);
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      keys: async () => [...m.keys()].map((url) => ({ url })),
      match: async (req) => m.get(key(req))?.clone(),
      put: async (req, res) => { m.set(key(req), res); },
      delete: async (req) => m.delete(key(req)),
      addAll: async () => {},
    };
  };
  return {
    store,
    api: {
      keys: async () => [...store.keys()],
      open,
      delete: async (name) => store.delete(name),
      match: async () => undefined,
    },
  };
};

const runActivate = async ({ caches, fetch }) => {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    location: { origin: ORIGIN },
  };
  vm.runInNewContext(SW, { self, caches, fetch, Request, Response, URL, console });
  let pending;
  listeners.activate({ waitUntil: (p) => { pending = p; } });
  await pending;
};

let caches;
beforeEach(async () => {
  caches = makeCaches();
  const put = async (name, url, body, headers = {}) =>
    (await caches.api.open(name)).put(url, new Response(body, { headers }));
  // an install from an older build, with downloads made along the way
  await put("pageturner-cache-v30", u("/index.html"), "old shell");
  await put("pageturner-runtime-v30", u("/vendor/ort/ort-wasm-simd.wasm"), "engine", { etag: '"e1"' });
  await put("pageturner-runtime-v30", u("/vendor/piper/piper_phonemize.data"), "espeak", { etag: '"d1"' });
  await put("pageturner-runtime-v30", u("/vendor/pdfjs/pdf.worker.min.mjs"), "js");
  await put("pageturner-voices", "https://huggingface.co/x/en_US-lessac-medium.onnx", "voice model");
  await put("transformers-cache", "https://huggingface.co/kokoro/model.onnx", "hq model");
  await put("kokoro-voices", "https://huggingface.co/kokoro/af_heart.bin", "hq voice");
  await put("shared-files", "shared-file-0", "a shared book");
  await put(CURRENT, u("/index.html"), "new shell");
  await put(RUNTIME, u("/vendor/foliate/view.js"), "js");
});

describe("service worker activate", () => {
  it("retires only this app's older versioned caches", async () => {
    await runActivate({ caches: caches.api, fetch: async () => new Response(null, { status: 304 }) });
    const left = [...caches.store.keys()].sort();
    expect(left).not.toContain("pageturner-cache-v30");
    expect(left).not.toContain("pageturner-runtime-v30");
    for (const kept of [CURRENT, RUNTIME, "pageturner-voices", "transformers-cache",
      "kokoro-voices", "shared-files", "pageturner-engines"])
      expect(left).toContain(kept);
  });

  it("keeps downloaded voices byte-for-byte", async () => {
    await runActivate({ caches: caches.api, fetch: async () => new Response(null, { status: 304 }) });
    const voice = caches.store.get("pageturner-voices").get("https://huggingface.co/x/en_US-lessac-medium.onnx");
    expect(await voice.text()).toBe("voice model");
    expect(await caches.store.get("transformers-cache").get("https://huggingface.co/kokoro/model.onnx").text())
      .toBe("hq model");
  });

  it("carries engine binaries over from the old runtime cache instead of re-downloading", async () => {
    let fetched = 0;
    await runActivate({ caches: caches.api, fetch: async () => { fetched++; return new Response(null, { status: 304 }); } });
    const engines = caches.store.get("pageturner-engines");
    expect([...engines.keys()].sort()).toEqual([
      u("/vendor/ort/ort-wasm-simd.wasm"),
      u("/vendor/piper/piper_phonemize.data"),
    ]);
    expect(await engines.get(u("/vendor/ort/ort-wasm-simd.wasm")).text()).toBe("engine");
    // JavaScript isn't an engine binary — it stays per-build, so a patched
    // library can't be served stale
    expect(engines.has(u("/vendor/pdfjs/pdf.worker.min.mjs"))).toBe(false);
    // one conditional check per binary, not a download
    expect(fetched).toBe(2);
  });

  it("re-checks engines with a conditional request, replacing only what changed", async () => {
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url, inm: init?.headers?.["If-None-Match"] });
      return url.endsWith(".wasm")
        ? new Response("engine v2", { status: 200, headers: { etag: '"e2"' } })
        : new Response(null, { status: 304 });
    };
    await runActivate({ caches: caches.api, fetch });
    expect(sent.map((s) => s.inm).sort()).toEqual(['"d1"', '"e1"']);
    const engines = caches.store.get("pageturner-engines");
    expect(await engines.get(u("/vendor/ort/ort-wasm-simd.wasm")).text()).toBe("engine v2");
    expect(await engines.get(u("/vendor/piper/piper_phonemize.data")).text()).toBe("espeak");
  });

  it("keeps engines when offline during an update", async () => {
    await runActivate({ caches: caches.api, fetch: async () => { throw new TypeError("offline"); } });
    const engines = caches.store.get("pageturner-engines");
    expect(await engines.get(u("/vendor/ort/ort-wasm-simd.wasm")).text()).toBe("engine");
  });
});
