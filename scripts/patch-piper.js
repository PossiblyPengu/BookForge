/**
 * patch-piper.js — fixes applied to the vendored piper-tts-web:
 *   1. reuse one phonemizer per session (below)
 *   2. let the phonemizer's main() run more than once (further down)
 *   3. TtsSession.release(), to free a voice's memory (further down)
 *   4. keep downloaded voices in the Cache API (further down)
 *
 * Upstream piper-tts-web creates a fresh phonemizer (a WebAssembly module
 * that loads espeak-ng's 18 MB data file into its own memory) for every
 * sentence it synthesises. None of that is on the JS heap, and iOS reclaims
 * it slowly, so a few minutes of read-aloud grew memory until iOS killed
 * the page. One instance, called repeatedly, produces identical phoneme ids
 * (once patch 2 is in). An instance that fails anyway is dropped, so the
 * next sentence gets a fresh one instead of every later sentence failing.
 *
 * Run by build-vendor.js; also runnable on its own:
 *   node scripts/patch-piper.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "  const phonemeIds = await new Promise(async (resolve) => {";
const END = "\n  const speakerId = 0;";
const MARK = "__ptPhonemizer";

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
  const phonemizer = this.${MARK};
  const { module, sink } = await phonemizer;
  sink.out = sink.err = null;
  let phonemeIds;
  try {
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
    phonemeIds = JSON.parse(sink.out).phoneme_ids;
  } catch (e) {
    if (this.${MARK} === phonemizer) this.${MARK} = null;
    throw e;
  }`;

// ---------------------------------------------------------------------------
// The phonemizer's callMain(): put the stack back afterwards
// ---------------------------------------------------------------------------
//
// Emscripten's callMain() pushes argv and each argument string (the sentence
// included) onto the WebAssembly stack and never pops them; it's meant to run
// once. Called per sentence that lost ~300 bytes of a fixed stack each time,
// and after ~100 sentences main() ran off the end of it: "RuntimeError: null
// function", or memory quietly overwritten. That is the read-aloud crash on
// iPhone ("A problem repeatedly occurred"). The build exports no
// stackSave/stackRestore, but stackAlloc(n) moves the stack pointer down by
// n, so a negative n moves it back up.

const GLUE_START = "    function callMain(args = []) {";
const GLUE_END = "    function run(args = arguments_) {";
const GLUE_MARK = "__ptStackTop";

const GLUE_REPLACEMENT = `    function callMain(args = []) {
      // Pageturner patch (scripts/patch-piper.js): restore the stack pointer
      // after main(), so callMain() can run once per sentence.
      var ${GLUE_MARK} = stackAlloc(0);
      var entryFunction = _main;
      args.unshift(thisProgram);
      var argc = args.length;
      var argv = stackAlloc((argc + 1) * 4);
      var argv_ptr = argv;
      args.forEach((arg) => {
        HEAPU32[argv_ptr >> 2] = stringToUTF8OnStack(arg);
        argv_ptr += 4;
      });
      HEAPU32[argv_ptr >> 2] = 0;
      try {
        var ret = entryFunction(argc, argv);
        exitJS(ret, true);
        return ret;
      } catch (e) {
        return handleException(e);
      } finally {
        stackAlloc(stackAlloc(0) - ${GLUE_MARK});
      }
    }
`;

// ---------------------------------------------------------------------------
// TtsSession.release(): give a voice's memory back
// ---------------------------------------------------------------------------
//
// ONNX Runtime keeps a model's weights in its WebAssembly memory until the
// InferenceSession is released. Upstream never releases one, and dropping
// the TtsSession gives nothing back, so every voice loaded in a visit (voice
// previews included) stayed resident, ~60–110 MB each, in memory that never
// shrinks.

const RELEASE_START = "  static async create(options) {";
const RELEASE_END = "  async init() {";
const RELEASE_MARK = "__ptRelease";

const RELEASE_REPLACEMENT = `  static async create(options) {
    const session = new _TtsSession(options);
    await session.waitReady;
    return session;
  }
  // Pageturner patch (scripts/patch-piper.js, ${RELEASE_MARK}): free the voice
  // model inside ONNX Runtime. The session can't synthesise afterwards.
  async release() {
    if (_TtsSession._instance === this) _TtsSession._instance = null;
    const ortSession = __privateGet(this, _ortSession);
    __privateSet(this, _ortSession, null);
    await (ortSession == null ? void 0 : ortSession.release());
  }
`;

// ---------------------------------------------------------------------------
// Voice storage: Cache API instead of OPFS
// ---------------------------------------------------------------------------
//
// Upstream saves each downloaded voice to OPFS with createWritable(), which
// Safari doesn't support on the main thread. On iPhone and iPad the save
// threw, the error was swallowed, and every session downloaded the ~60 MB
// voice again. The Cache API works everywhere, survives app updates (the
// service worker leaves this cache alone), and can be listed and sized.
// Voices that earlier builds did manage to save to OPFS (Chrome, Firefox)
// are still read, and copied across the first time they're used.

const STORE_MARK = "__ptVoiceCache";

const STORE_FUNCTIONS = `// Pageturner patch (scripts/patch-piper.js): voices live in the Cache API.
const ${STORE_MARK} = "pageturner-voices";
async function __ptOpfsDir() {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle("piper");
  } catch {
    return null;
  }
}
async function writeBlob(url, blob) {
  if (!url.match("https://huggingface.co")) return;
  try {
    const cache = await caches.open(${STORE_MARK});
    await cache.put(url, new Response(blob, {
      headers: {
        "content-type": blob.type || "application/octet-stream",
        "content-length": String(blob.size)
      }
    }));
  } catch (e) {
    console.error(e);
  }
}
async function removeBlob(url) {
  try {
    await (await caches.open(${STORE_MARK})).delete(url);
  } catch (e) {
    console.error(e);
  }
  try {
    await (await __ptOpfsDir())?.removeEntry(url.split("/").at(-1));
  } catch {
  }
}
async function readBlob(url) {
  if (!url.match("https://huggingface.co")) return;
  try {
    const hit = await (await caches.open(${STORE_MARK})).match(url);
    if (hit) return await hit.blob();
  } catch {
  }
  try {
    const dir = await __ptOpfsDir();
    const file = dir && await dir.getFileHandle(url.split("/").at(-1));
    const blob = file && await file.getFile();
    if (blob) {
      await writeBlob(url, blob);
      return blob;
    }
  } catch {
  }
  return void 0;
}
`;

// download() also stops returning before the voice is saved: upstream called
// writeBlob() without awaiting it
const STORE_EXPORTS = `async function download(voiceId, callback) {
  const path = PATH_MAP[voiceId];
  const urls = [\`\${HF_BASE}/\${path}\`, \`\${HF_BASE}/\${path}.json\`];
  await Promise.all(urls.map(async (url) => {
    await writeBlob(url, await fetchBlob(url, url.endsWith(".onnx") ? callback : void 0));
  }));
}
async function remove(voiceId) {
  const path = PATH_MAP[voiceId];
  const urls = [\`\${HF_BASE}/\${path}\`, \`\${HF_BASE}/\${path}.json\`];
  await Promise.all(urls.map((url) => removeBlob(url)));
}
async function stored() {
  const result = new Set();
  const add = (name) => {
    const key = name.split(".")[0];
    if (name.endsWith(".onnx") && key in PATH_MAP) result.add(key);
  };
  try {
    for (const req of await (await caches.open(${STORE_MARK})).keys()) add(req.url.split("/").at(-1));
  } catch {
  }
  try {
    const dir = await __ptOpfsDir();
    if (dir) for await (const name of dir.keys()) add(name);
  } catch {
  }
  return [...result];
}
async function flush() {
  try {
    await caches.delete(${STORE_MARK});
  } catch (e) {
    console.error(e);
  }
  try {
    await (await navigator.storage.getDirectory()).removeEntry("piper", { recursive: true });
  } catch {
  }
}
`;

/** Replace [from, to) in `s`, where `to` is the start of the next function. */
const replaceSpan = (s, from, to, text, what, file) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`patch-piper: ${what} not found in ${file} — upstream changed?`);
  return s.slice(0, a) + text + s.slice(b);
};

// `file`: "main" is piper-tts-web.js; "glue" is the phonemizer's Emscripten
// loader beside it (a content-hashed name, found by what it contains)
const PATCHES = [
  {
    name: "one phonemizer per session",
    file: "main",
    mark: MARK,
    apply: (s, file) => replaceSpan(s, START, END, REPLACEMENT, "phonemizer call", file),
  },
  {
    name: "phonemizer callMain restores the stack",
    file: "glue",
    mark: GLUE_MARK,
    apply: (s, file) => replaceSpan(s, GLUE_START, GLUE_END, GLUE_REPLACEMENT, "callMain", file),
  },
  {
    name: "TtsSession.release()",
    file: "main",
    mark: RELEASE_MARK,
    apply: (s, file) => replaceSpan(s, RELEASE_START, RELEASE_END, RELEASE_REPLACEMENT, "TtsSession.create", file),
  },
  {
    name: "voices in the Cache API",
    file: "main",
    mark: STORE_MARK,
    apply: (s, file) => {
      s = replaceSpan(s, "async function writeBlob(url, blob) {", "async function fetchBlob(url, callback) {",
        STORE_FUNCTIONS, "voice storage functions", file);
      return replaceSpan(s, "async function download(voiceId, callback) {", "async function voices() {",
        STORE_EXPORTS, "voice download/list functions", file);
    },
  },
];

const findGlue = (dir) => {
  const hits = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.readFileSync(f, "utf8").includes(GLUE_START));
  if (hits.length !== 1) throw new Error(`patch-piper: expected one phonemizer loader in ${dir}, found ${hits.length}`);
  return hits[0];
};

/**
 * Apply every patch not already present to piper-tts-web.js (`file`) and the
 * phonemizer loader beside it. Returns the names applied.
 */
export const patchPiper = (file) => {
  const files = { main: file, glue: findGlue(path.dirname(file)) };
  const applied = [];
  for (const [which, target] of Object.entries(files)) {
    let s = fs.readFileSync(target, "utf8");
    let changed = false;
    for (const p of PATCHES.filter((x) => x.file === which)) {
      if (s.includes(p.mark)) continue;
      s = p.apply(s, target);
      applied.push(p.name);
      changed = true;
    }
    if (changed) fs.writeFileSync(target, s);
  }
  return applied;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = fileURLToPath(new URL("../docs/vendor/piper/piper-tts-web.js", import.meta.url));
  const applied = patchPiper(file);
  console.log(applied.length ? `patched: ${applied.join(", ")}` : "already patched", file);
}
