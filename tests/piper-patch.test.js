import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { patchPiper } from "../scripts/patch-piper.js";

const root = path.resolve(import.meta.dirname, "..");
const vendored = path.join(root, "docs/vendor/piper");
const upstream = path.join(root, "node_modules/@mintplex-labs/piper-tts-web/dist");

describe("patch-piper", () => {
  it.skipIf(!fs.existsSync(upstream))("reproduces the vendored files from upstream, once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-"));
    try {
      for (const f of fs.readdirSync(upstream))
        if (f.endsWith(".js")) fs.copyFileSync(path.join(upstream, f), path.join(dir, f));
      // what build-vendor.js does before patching
      const main = path.join(dir, "piper-tts-web.js");
      fs.writeFileSync(main, fs.readFileSync(main, "utf8")
        .replace('import("onnxruntime-web/wasm")', 'import("../ort/wasm.js")'));

      expect(patchPiper(main)).toHaveLength(5);
      expect(patchPiper(main)).toEqual([]); // idempotent
      for (const f of fs.readdirSync(dir))
        expect(fs.readFileSync(path.join(dir, f), "utf8"), f)
          .toBe(fs.readFileSync(path.join(vendored, f), "utf8"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The read-aloud crash on iPhone, again: ONNX Runtime's memory grows to fit
// the longest clip generated and never shrinks, so one long sentence in one
// inference held ~400 MB. Pieces of at most 100 characters keep it bounded.
describe("vendored splitIntoChunks", () => {
  let split;
  beforeAll(async () => {
    ({ splitIntoChunks: split } = await import(pathToFileURL(path.join(vendored, "piper-tts-web.js")).href));
  });
  const words = (s) => s.split(/\s+/).filter(Boolean);

  it("leaves a sentence that fits alone", () => {
    expect(split("  The harbour was quiet.  ")).toEqual(["The harbour was quiet."]);
  });

  it("splits a long sentence at its clause breaks, keeping every word", () => {
    const text = "It was the best of times, it was the worst of times, it was the age of wisdom, "
      + "it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, "
      + "it was the season of Light.";
    const pieces = split(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100);
    for (const p of pieces.slice(0, -1)) expect(p).toMatch(/,$/);
    expect(words(pieces.join(" "))).toEqual(words(text));
  });

  it("breaks at a dash, else between words, never inside one", () => {
    expect(split("He paused\u2014just for a moment\u2014and then, without another word to anyone "
      + "in the crowded room, turned and walked out into the rain.")[0]).toMatch(/,$/);
    const run = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const pieces = split(run);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100);
    expect(words(pieces.join(" "))).toEqual(words(run));
  });

  it("cuts text with no spaces at the limit", () => {
    expect(split("x".repeat(250)).map((p) => p.length)).toEqual([100, 100, 50]);
  });
});

// The read-aloud crash on iPhone: callMain() leaked each sentence's arguments
// off the phonemizer's stack until main() overran it, ~100 sentences in.
describe("vendored phonemizer", () => {
  const saved = {};
  let createPiperPhonemize;
  beforeAll(async () => {
    // the Emscripten loader's Node path is CommonJS-flavoured
    for (const k of ["require", "__dirname"]) saved[k] = globalThis[k];
    globalThis.require = createRequire(import.meta.url);
    globalThis.__dirname = vendored;
    const glue = fs.readdirSync(vendored).find((f) => /^piper-\w+\.js$/.test(f) && f !== "piper-tts-web.js");
    ({ createPiperPhonemize } = await import(pathToFileURL(path.join(vendored, glue)).href));
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  const make = async () => {
    const sink = { out: null, err: null };
    const module = await createPiperPhonemize({
      print: (d) => { sink.out ??= d; },
      printErr: (e) => { sink.err ??= e; },
      locateFile: (u) => path.join(vendored, u.split("/").at(-1)),
    });
    return (text) => {
      sink.out = sink.err = null;
      module.callMain(["-l", "en-us", "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
      if (sink.out == null) throw new Error(sink.err || "no output");
      return JSON.parse(sink.out).phoneme_ids;
    };
  };

  it("phonemizes hundreds of sentences on one instance, same as a fresh one", async () => {
    const phonemize = await make();
    const sentence = (i) => `Sentence ${i}: the harbour was quiet in the early hours, `
      + "and the boats lay still against the grey water while somewhere a bell rang twice.";
    let last;
    for (let i = 1; i <= 400; i++) last = phonemize(sentence(i));
    expect(last).toEqual((await make())(sentence(400)));
  }, 60000);
});
