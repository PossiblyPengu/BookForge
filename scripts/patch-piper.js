/**
 * patch-piper.js — reuse one phonemizer per Piper session.
 *
 * Upstream piper-tts-web creates a fresh phonemizer (a WebAssembly module
 * that loads espeak-ng's 18 MB data file into its own memory) for every
 * sentence it synthesises. None of that is on the JS heap, and iOS reclaims
 * it slowly, so a few minutes of read-aloud grew memory until iOS killed
 * the page. One instance, called repeatedly, produces identical phoneme ids.
 *
 * Run by build-vendor.js; also runnable on its own:
 *   node scripts/patch-piper.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "  const phonemeIds = await new Promise(async (resolve) => {";
const END = "\n  const speakerId = 0;";
const MARK = "__pageturnerPhonemizer";

const REPLACEMENT = `  // Pageturner patch (scripts/patch-piper.js): one phonemizer per session,
  // reused for every sentence, instead of a new 18 MB WASM instance each.
  if (!this.${MARK}) {
    const sink = { out: null, err: null };
    this.${MARK} = __privateGet(this, _createPiperPhonemize).call(this, {
      print: (data) => { sink.out ??= data; },
      printErr: (message) => { sink.err ??= message; },
      locateFile: (url) => {
        if (url.endsWith(".wasm")) return __privateGet(this, _wasmPaths).piperWasm;
        if (url.endsWith(".data")) return __privateGet(this, _wasmPaths).piperData;
        return url;
      }
    }).then((module) => ({ module, sink }));
    this.${MARK}.catch(() => { this.${MARK} = null; });
  }
  const { module, sink } = await this.${MARK};
  sink.out = sink.err = null;
  module.callMain([
    "-l",
    __privateGet(this, _modelConfig).espeak.voice,
    "--input",
    input,
    "--espeak_data",
    "/espeak-ng-data"
  ]);
  // callMain runs synchronously, so its output (or error) is in by now
  if (sink.out == null) throw new Error(sink.err || "phonemizer produced no output");
  const phonemeIds = JSON.parse(sink.out).phoneme_ids;`;

export const patchPiper = (file) => {
  let s = fs.readFileSync(file, "utf8");
  if (s.includes(MARK)) return false; // already patched
  const a = s.indexOf(START);
  const b = s.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error(`patch-piper: phonemizer call not found in ${file} — upstream changed?`);
  s = s.slice(0, a) + REPLACEMENT + s.slice(b);
  fs.writeFileSync(file, s);
  return true;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = fileURLToPath(new URL("../docs/vendor/piper/piper-tts-web.js", import.meta.url));
  console.log(patchPiper(file) ? "patched" : "already patched", file);
}
