/**
 * build-vendor.js
 *
 * Copies/bundles runtime dependencies from node_modules into docs/vendor/
 * so the app is fully self-hosted (no CDN — works offline under a strict CSP).
 *
 * Usage:
 *   node scripts/build-vendor.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(__filename), "..");
const NM = path.join(ROOT, "node_modules");
const VENDOR = path.join(ROOT, "docs", "vendor");

const cp = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
};
const out = (rel) => path.join(VENDOR, rel);
const nm = (rel) => path.join(NM, rel);

// --- foliate-js: runtime modules only ---
const FOLIATE_SKIP = new Set([
  "eslint.config.js", "rollup.config.js", "reader.js", "reader.html",
]);
fs.rmSync(out("foliate"), { recursive: true, force: true });
for (const f of fs.readdirSync(nm("foliate-js"))) {
  if (FOLIATE_SKIP.has(f) || f === "tests" || f === "rollup") continue;
  const src = nm(path.join("foliate-js", f));
  if (fs.statSync(src).isDirectory() || f.endsWith(".js") || f.endsWith(".html"))
    cp(src, out(path.join("foliate", f)));
}

// --- pdfjs ---
fs.rmSync(out("pdfjs"), { recursive: true, force: true });
cp(nm("pdfjs-dist/build/pdf.min.mjs"), out("pdfjs/pdf.min.mjs"));
cp(nm("pdfjs-dist/build/pdf.worker.min.mjs"), out("pdfjs/pdf.worker.min.mjs"));
cp(nm("pdfjs-dist/standard_fonts"), out("pdfjs/standard_fonts"));
cp(nm("pdfjs-dist/cmaps"), out("pdfjs/cmaps"));

// --- onnxruntime-web: non-threaded wasm only (no SharedArrayBuffer here) ---
fs.rmSync(out("ort"), { recursive: true, force: true });
for (const f of ["ort.wasm.min.js", "ort-wasm-simd.wasm", "ort-wasm.wasm"])
  cp(nm(path.join("onnxruntime-web/dist", f)), out(path.join("ort", f)));
// The bundle declares `var ort=...` which is module-scoped under ESM —
// append an explicit export so it can be imported.
fs.appendFileSync(out("ort/ort.wasm.min.js"), "\n;export default ort;\n");
// ESM shim around the bundle (piper imports "onnxruntime-web/wasm")
fs.writeFileSync(out("ort/wasm.js"), `import ort from "./ort.wasm.min.js";
export default ort;
export const env = ort.env;
export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;
`);

// --- piper-tts-web ---
fs.rmSync(out("piper"), { recursive: true, force: true });
const piperDist = nm("@mintplex-labs/piper-tts-web/dist");
for (const f of fs.readdirSync(piperDist))
  if (f.endsWith(".js")) cp(path.join(piperDist, f), out(path.join("piper", f)));
// Redirect the bare "onnxruntime-web/wasm" import to our vendored UMD shim —
// keeps the CSP clean (no inline importmap needed).
const piperMain = out("piper/piper-tts-web.js");
fs.writeFileSync(piperMain, fs.readFileSync(piperMain, "utf8")
  .replace('import("onnxruntime-web/wasm")', 'import("../ort/wasm.js")'));

// piper phonemize wasm+data live in a separate CDN package; keep local copies
for (const ext of ["wasm", "data"]) {
  const dest = out(`piper/piper_phonemize.${ext}`);
  if (!fs.existsSync(dest))
    execFileSync("curl", ["-sL", "-o", dest,
      `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.${ext}`]);
}

// --- music-metadata: CJS → single-file ESM bundle ---
execFileSync("npx", ["-y", "esbuild",
  nm("music-metadata-browser/lib/index.js"),
  "--bundle", "--format=esm", "--platform=browser",
  "--outfile=" + out("music-metadata.mjs")], { stdio: "inherit", shell: true });

// --- node-unrar-js: extensionless ESM → bundled ESM + wasm binary (CBR support) ---
execFileSync("npx", ["-y", "esbuild",
  nm("node-unrar-js/esm/index.esm.js"),
  "--bundle", "--format=esm", "--platform=browser",
  "--outfile=" + out("unrar.mjs")], { stdio: "inherit", shell: true });
cp(nm("node-unrar-js/esm/js/unrar.wasm"), out("unrar.wasm"));

// --- fflate: full ESM build for zip writing (CBR→CBZ repack) ---
cp(nm("fflate/esm/browser.js"), out("fflate.mjs"));

// --- kokoro-js: high-quality neural voice (WebGPU only; see tts-engines.js) ---
// kokoro.web.js inlines transformers.js, which otherwise fetches its ONNX
// runtime from jsdelivr. Ship the runtime it was built against (transformers
// is pinned to that version in package.json) and point env.wasmPaths here.
fs.rmSync(out("kokoro"), { recursive: true, force: true });
cp(nm("kokoro-js/dist/kokoro.web.js"), out("kokoro/kokoro.web.js"));
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"])
  cp(nm(path.join("@huggingface/transformers/dist", f)), out(path.join("kokoro", f)));

console.log("\nVendor build complete → docs/vendor/");
