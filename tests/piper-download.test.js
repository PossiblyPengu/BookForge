import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { download, stored } from "../docs/vendor/piper/piper-tts-web.js";

const voice = "en_US-lessac-medium";
const config = JSON.stringify({ audio: { sample_rate: 22050 }, phoneme_id_map: { _: [0] } });
let entries;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new Error("No OPFS"); } } });
  vi.stubGlobal("caches", { open: async () => ({
    put: vi.fn(async (url, response) => { entries.set(url, response.clone()); }),
    delete: async (url) => entries.delete(url),
    match: async (url) => entries.get(url)?.clone(),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  }) });
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(url.endsWith(".json") ? config : "model")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("voice download integrity", () => {
  it("reports a voice stored only after model and config commit", async () => {
    await download(voice);
    expect(await stored()).toContain(voice);
    const config = [...entries.keys()].find((url) => url.endsWith(".json"));
    entries.delete(config);
    expect(await stored()).not.toContain(voice);
  });

  it.each([404, 503])("rejects HTTP %s and removes partial files", async (status) => {
    fetch.mockImplementation(async (url) => new Response(url.endsWith(".json") ? "bad" : "model", { status: url.endsWith(".json") ? status : 200 }));
    await expect(download(voice)).rejects.toThrow(`HTTP ${status}`);
    expect(entries.size).toBe(0);
    expect(await stored()).not.toContain(voice);
  });

  it("waits for sibling writes before cleaning up a failed download", async () => {
    let complete;
    const model = new Promise((resolve) => { complete = resolve; });
    fetch.mockImplementation((url) => url.endsWith(".json") ? Promise.resolve(new Response("bad", { status: 503 })) : model);
    const pending = download(voice);
    complete(new Response("model"));
    await expect(pending).rejects.toThrow("HTTP 503");
    expect(entries.size).toBe(0);
  });

  it("surfaces storage quota failures instead of claiming a download succeeded", async () => {
    const cache = await caches.open();
    cache.put.mockRejectedValue(new Error("quota exceeded"));
    caches.open = async () => cache;
    await expect(download(voice)).rejects.toThrow("quota exceeded");
    expect(entries.size).toBe(0);
  });

  it.each(["", "not JSON", "null", "{}", "[]"])("rejects an empty or invalid config %j", async (config) => {
    fetch.mockImplementation(async (url) => new Response(url.endsWith(".json") ? config : "model"));
    await expect(download(voice)).rejects.toThrow();
    expect(entries.size).toBe(0);
  });

  it("rejects truncated response bodies", async () => {
    fetch.mockImplementation(async () => new Response("partial", { headers: { "Content-Length": "999" } }));
    await expect(download(voice)).rejects.toThrow("incomplete");
    expect(entries.size).toBe(0);
  });

  it("does not compare compressed transfer length with decoded bytes", async () => {
    fetch.mockImplementation(async (url) => new Response(url.endsWith(".json") ? config : "model", { headers: { "Content-Length": "99", "Content-Encoding": "gzip" } }));
    await expect(download(voice)).resolves.toBeUndefined();
    expect(await stored()).toContain(voice);
  });

  it("rejects HTTP-200 HTML error pages in place of a model", async () => {
    fetch.mockImplementation(async (url) => url.endsWith(".json")
      ? new Response(config)
      : new Response("<html>Error</html>", { headers: { "Content-Type": "text/html" } }));
    await expect(download(voice)).rejects.toThrow("instead of a model");
    expect(entries.size).toBe(0);
  });

  it("accepts decoded CORS bodies when the encoding header is hidden", async () => {
    fetch.mockImplementation(async (url) => {
      const response = new Response(url.endsWith(".json") ? config : "model", { headers: { "Content-Length": "3" } });
      Object.defineProperty(response, "type", { value: "cors" });
      return response;
    });
    await expect(download(voice)).resolves.toBeUndefined();
    expect(await stored()).toContain(voice);
  });
});
