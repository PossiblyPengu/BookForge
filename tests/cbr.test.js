import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "../docs/vendor/fflate.mjs";
import { cbrToCbz } from "../docs/js/cbr.js";

const { files } = vi.hoisted(() => ({ files: [] }));
vi.mock("../docs/vendor/unrar.mjs", () => ({ createExtractorFromData: async () => ({ extract: () => ({ files }) }) }));
vi.mock("../docs/js/util.js", () => ({ toast: vi.fn(), fmtBytes: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); files.length = 0; });

describe("CBR conversion", () => {
  it("preserves duplicate page basenames in different archive directories", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
    for (const [name, byte] of [["chapter-1/001.png", 1], ["chapter-2\\001.png", 2]])
      files.push({ fileHeader: { name, flags: {} }, extraction: new Uint8Array([byte]) });
    const cbz = await cbrToCbz(new File(["rar"], "comic.cbr"));
    const pages = unzipSync(new Uint8Array(await cbz.arrayBuffer()));
    expect(Object.keys(pages)).toEqual(["chapter-1/001.png", "chapter-2/001.png"]);
    expect(pages["chapter-1/001.png"][0]).toBe(1);
    expect(pages["chapter-2/001.png"][0]).toBe(2);
  });

  it("reports an unavailable converter before trying to extract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    await expect(cbrToCbz(new File(["rar"], "comic.cbr"))).rejects.toThrow("HTTP 503");
  });
});
