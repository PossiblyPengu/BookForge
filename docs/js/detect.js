/**
 * detect.js — file format detection.
 *
 * kind: "ebook" (foliate-rendered) | "pdf" | "text" | "audio"
 */

export const AUDIO_EXTS = new Set(["m4b", "m4a", "mp3", "aac", "flac", "ogg", "oga", "opus", "wav"]);
export const TEXT_EXTS = new Set(["txt", "md", "markdown", "html", "htm"]);
export const FOLIATE_EXTS = new Set(["epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz", "kfx"]);

const ext = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

const headBytes = async (file, n = 512) =>
  new Uint8Array(await file.slice(0, n).arrayBuffer());

const isZip = async (file) => {
  const b = await headBytes(file, 4);
  return b[0] === 0x50 && b[1] === 0x4b; // PK
};

const isPdf = async (file) => {
  const b = await headBytes(file, 5);
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
};

const isRar = async (file) => {
  const b = await headBytes(file, 7);
  // RAR1.5-4.x: "Rar!\x1A\x07\x00", RAR5+: "Rar!\x1A\x07\x01"
  return b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 &&
         b[4] === 0x1a && b[5] === 0x07 && (b[6] === 0x00 || b[6] === 0x01);
};

const isMobi = async (file) => {
  if (file.size < 68) return false;
  const b = new Uint8Array(await file.slice(60, 68).arrayBuffer());
  const tag = String.fromCharCode(...b);
  return tag === "BOOKMOBI" || tag === "TEXtREAd";
};

const isFb2Xml = async (file) => {
  const text = new TextDecoder().decode(await headBytes(file, 2048));
  return /<FictionBook[\s>]/i.test(text);
};

/**
 * Detect book kind + concrete format label.
 * Returns { kind, format } — format is an uppercase display label.
 */
export const detectFormat = async (file) => {
  const e = ext(file.name || "");

  if (AUDIO_EXTS.has(e) || file.type?.startsWith("audio/"))
    return { kind: "audio", format: (e || "audio").toUpperCase() };
  if (e === "pdf" || (await isPdf(file))) return { kind: "pdf", format: "PDF" };
  if (TEXT_EXTS.has(e) || file.type === "text/plain")
    return { kind: "text", format: e === "md" || e === "markdown" ? "Markdown" : e.startsWith("htm") ? "HTML" : "TXT" };
  if (e === "epub") return { kind: "ebook", format: "EPUB" };
  if (e === "cbz") return { kind: "ebook", format: "CBZ" };
  if (e === "cbr" || (await isRar(file))) return { kind: "ebook", format: "CBR" };
  if (e === "fbz") return { kind: "ebook", format: "FBZ" };
  if (e === "fb2" || (await isFb2Xml(file))) return { kind: "ebook", format: "FB2" };
  if (["mobi", "azw", "azw3", "kfx"].includes(e) || (await isMobi(file)))
    return { kind: "ebook", format: e.toUpperCase() || "MOBI" };
  if (await isZip(file)) {
    // zip container — EPUB or CBZ; let foliate decide, label generically
    return { kind: "ebook", format: "EPUB" };
  }
  return { kind: "unknown", format: e.toUpperCase() || "FILE" };
};
