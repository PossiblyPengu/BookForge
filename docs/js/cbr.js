/**
 * cbr.js — CBR (RAR comic archive) → in-memory CBZ conversion.
 *
 * Foliate's comic reader only understands zip containers, so CBR files
 * are extracted with the vendored unrar WASM and repacked with fflate.
 */

const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

export const cbrToCbz = async (file) => {
  const [{ createExtractorFromData }, { zipSync }] = await Promise.all([
    import("../vendor/unrar.mjs"),
    import("../vendor/fflate.mjs"),
  ]);
  const wasmBinary = await (await fetch("./vendor/unrar.wasm")).arrayBuffer();
  const extractor = await createExtractorFromData({
    wasmBinary, data: await file.arrayBuffer(),
  });
  const out = {};
  for (const f of extractor.extract().files) {
    if (f.fileHeader.flags.directory) continue;
    if (!IMG_RE.test(f.fileHeader.name)) continue;
    const name = f.fileHeader.name.replace(/\\/g, "/").split("/").pop();
    if (name && f.extraction?.length) out[name] = f.extraction;
  }
  if (!Object.keys(out).length) throw new Error("No images found in CBR");
  return new File([zipSync(out)],
    file.name.replace(/\.cbr$/i, "") + ".cbz",
    { type: "application/vnd.comicbook+zip" });
};
