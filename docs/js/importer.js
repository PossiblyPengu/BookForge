/**
 * importer.js — file import pipeline.
 *
 * Audio files imported together become ONE audiobook with per-file
 * (or embedded) chapters. Each other file becomes one library book.
 * After import, metadata auto-lookup runs; books with no confident
 * match are flagged `needsMeta` for manual selection.
 */

import { detectFormat, AUDIO_EXTS, TEXT_EXTS, FOLIATE_EXTS } from "./detect.js";
import { putBook, putFile, getBook } from "./db.js";
import { uid, toast } from "./util.js";
import { inferBook, extractSortKey } from "./book-parser.js";
import { searchMetadata, fetchCoverBlob, metaConfident } from "./metadata.js";
import { cbrToCbz } from "./cbr.js";

const foliate = () => import("../vendor/foliate/view.js");
const loadMM = async () => (await import("../vendor/music-metadata.mjs")).default;

const SUPPORTED_EXT = new Set([...AUDIO_EXTS, ...TEXT_EXTS, ...FOLIATE_EXTS, "pdf", "cbr"]);

const str = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") return str(v.name ?? v.value ?? Object.values(v)[0]);
  return String(v);
};

// ---------------------------------------------------------------------------
// Per-format metadata extraction
// ---------------------------------------------------------------------------

const parseEbook = async (file, format) => {
  const { makeBook } = await foliate();
  if (format === "CBR") file = await cbrToCbz(file);
  const book = await makeBook(file); // throws UnsupportedTypeError on failure
  const m = book.metadata || {};
  let coverBlob = null;
  try { coverBlob = (await book.getCover?.()) || null; } catch { /* no cover */ }
  return {
    title: str(m.title),
    author: str(m.author),
    desc: str(m.description),
    year: str(m.published).slice(0, 4),
    coverBlob,
  };
};

const parsePdf = async (file) => {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: "./vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "./vendor/pdfjs/standard_fonts/",
  }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info || {};
  // Cover: render page 1
  let coverBlob = null;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = 320 / viewport.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    coverBlob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  } catch { /* cover optional */ }
  return {
    title: info.Title || file.name.replace(/\.[^.]+$/, ""),
    author: info.Author || "",
    desc: info.Subject || "",
    year: (info.CreationDate || "").replace(/^D:/, "").slice(0, 4),
    coverBlob,
    pageCount: doc.numPages,
  };
};

// A document usually names itself better than its filename does: a Markdown
// file's first "# heading", an HTML file's <title>.
const parseText = async (file) => {
  const fromName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  let title = "";
  try {
    const head = await file.slice(0, 8192).text();
    if (/\.(md|markdown)$/i.test(file.name)) title = head.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] || "";
    else if (/\.html?$/i.test(file.name))
      title = new DOMParser().parseFromString(head, "text/html").title || "";
  } catch { /* fall back to the filename */ }
  return { title: title.trim() || fromName, author: "", desc: "", year: "", coverBlob: null };
};

const parseAudioFile = async (file) => {
  const mm = await loadMM();
  const meta = await mm.parseBlob(file, { duration: true }).catch(() => null);
  const c = meta?.common || {};
  const pic = Array.isArray(c.picture) ? c.picture[0] : null;
  return {
    title: c.title || null,
    artist: c.artist || c.albumartist || null,
    album: c.album || null,
    description: (Array.isArray(c.description) ? c.description[0] : c.description) || null,
    isbn: c.isbn || null,
    duration: meta?.format?.duration || 0,
    chapters: (c.chapters || c.chapter || [])
      .map((ch) => ({ title: ch.title || null, start: ch.startTime ?? ch.start ?? null }))
      .filter((ch) => ch.start != null)
      .sort((a, b) => a.start - b.start),
    coverBlob: pic ? new Blob([pic.data], { type: pic.format || "image/jpeg" }) : null,
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import files. Returns array of created book records.
 * onProgress(msg) optional.
 */
export const importFiles = async (fileList, onProgress) => {
  const queue = [...fileList].filter((f) => f.size > 0).map((file) => ({ file, depth: 0 }));
  if (!queue.length) return [];

  const audio = [];
  const others = [];
  while (queue.length) {
    const { file, depth } = queue.shift();
    const d = await detectFormat(file).catch(() => ({ kind: "unknown" }));
    // a .zip that isn't itself a book (epub/cbz are also zips) is a bulk
    // container — unpack it and queue its supported contents
    if (d.kind === "ebook" && depth < 2 && /\.zip$/i.test(file.name || "")) {
      const inner = await expandZip(file).catch(() => null);
      if (inner?.length) {
        onProgress?.(`Unpacking ${file.name}…`);
        queue.push(...inner.map((f) => ({ file: f, depth: depth + 1 })));
        continue;
      }
    }
    (d.kind === "audio" ? audio : others).push({ file, ...d });
  }

  const created = [];
  // audio groups by folder: a zip/folder drop with per-book subdirectories
  // produces one audiobook each; a flat batch stays a single book
  const groups = new Map();
  for (const a of audio) {
    const dir = dirOf(a.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(a);
  }
  for (const items of groups.values()) {
    onProgress?.("Importing audiobook…");
    const book = await importAudiobook(items);
    if (book) created.push(book);
  }
  for (const { file, kind, format, reason } of others) {
    onProgress?.(`Importing ${file.name}…`);
    try {
      created.push(await importOne(file, kind, format, reason));
    } catch (err) {
      console.warn("Import failed:", file.name, err);
      // say why where we know — "couldn't import" alone leaves people
      // re-trying a file that can never work
      const why = reasonFor(err);
      toast(`Couldn’t import ${file.name}${why ? ` — ${why}` : ""}`, { error: true, ms: 6000 });
    }
  }
  return created;
};

/**
 * Turn a thrown error into something worth reading. A full library is the
 * common real-world failure and the browser's own wording for it ("Failed to
 * execute 'put' on 'IDBObjectStore'…") tells nobody anything.
 */
const reasonFor = (err) => {
  const name = err?.name || "";
  if (name === "QuotaExceededError" || /quota/i.test(err?.message || ""))
    return "there's no room left on this device. Free up space, or remove a few books.";
  if (name === "NotReadableError" || name === "NotFoundError")
    return "the file couldn't be read — it may have moved or been deleted.";
  return err?.message || "";
};

/** Folder portion of a dropped/picked file — for audiobook grouping. */
const dirOf = (file) => {
  const rel = file.webkitRelativePath || file.name || "";
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

/**
 * Unpack a .zip bulk container. Returns File[] (folder paths kept in names)
 * or null when the zip is actually a book (epub mimetype / image-only cbz).
 */
export const expandZip = async (file) => {
  const { unzipSync } = await import("../vendor/fflate.mjs");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  const isEpub = names.some((n) => n.split("/").pop() === "mimetype");
  const onlyImages = names.length &&
    names.every((n) => /\.(jpe?g|png|gif|webp|avif|bmp|xml)$/i.test(n));
  if (isEpub || onlyImages) return null;
  const files = [];
  for (const n of names) {
    const base = n.split("/").pop() || "";
    const e = (base.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    if (!SUPPORTED_EXT.has(e) || base.startsWith(".")) continue;
    files.push(new File([entries[n]], n, { type: "" }));
  }
  return files.length ? files : null;
};

const importOne = async (file, kind, format, reason) => {
  let meta = { title: "", author: "", desc: "", year: "", coverBlob: null };
  if (kind === "ebook") meta = await parseEbook(file, format);
  else if (kind === "pdf") meta = await parsePdf(file);
  else if (kind === "text") meta = await parseText(file);
  else if (kind === "unsupported") throw new Error(reason || `${format} isn’t supported.`);
  else if (kind === "unknown") throw new Error("Pageturner doesn’t recognise this file type.");

  const id = uid();
  const fileKey = `file:${id}`;
  await putFile(fileKey, file, { name: file.name, size: file.size, type: file.type });

  const book = {
    id, kind, format,
    title: meta.title || file.name,
    author: meta.author || "",
    desc: meta.desc || "",
    year: meta.year || "",
    coverBlob: meta.coverBlob,
    fileKey,
    fileName: file.name,
    fileSize: file.size,
    pageCount: meta.pageCount || null,
    progress: { fraction: 0 },
    addedAt: Date.now(),
    lastOpenedAt: null,
    needsMeta: !meta.title || !meta.author,
  };
  await putBook(book);
  autoMeta(book);
  return book;
};

const importAudiobook = async (items) => {
  const sorted = [...items].sort((a, b) =>
    extractSortKey(a.file.name) - extractSortKey(b.file.name));
  const parsed = [];
  for (const { file } of sorted) {
    try { parsed.push(await parseAudioFile(file)); }
    catch { parsed.push({ title: null, duration: 0, chapters: [] }); }
  }

  const files = sorted.map(({ file }) => file);
  const inferred = inferBook(files, parsed);
  // grouped-by-folder import (zip/webkitdirectory): folder name is the title fallback
  const folderTitle = dirOf(files[0])?.split("/").pop() || "";
  const id = uid();
  const fileKeys = [];
  const chapters = [];
  let offset = 0;

  for (let i = 0; i < sorted.length; i++) {
    const key = `file:${id}:${i}`;
    await putFile(key, files[i], { name: files[i].name, size: files[i].size });
    fileKeys.push(key);
    const p = parsed[i];
    const dur = p.duration || 0;
    if (p.chapters?.length) {
      // embedded chapter offsets within this file
      for (let j = 0; j < p.chapters.length; j++) {
        const ch = p.chapters[j];
        const nextStart = p.chapters[j + 1]?.start ?? dur;
        chapters.push({ title: ch.title || `Chapter ${chapters.length + 1}`, fileIndex: i, start: ch.start, end: nextStart });
      }
    } else {
      chapters.push({ title: inferred.chapters[i] || `Chapter ${i + 1}`, fileIndex: i, start: 0, end: dur });
    }
    offset += dur;
  }

  const book = {
    id, kind: "audio", format: sorted[0].format,
    title: inferred.title || folderTitle || files[0].name.replace(/\.[^.]+$/, ""),
    author: inferred.author || "",
    desc: inferred.description || "",
    year: "",
    coverBlob: parsed.find((p) => p.coverBlob)?.coverBlob || null,
    fileKey: fileKeys[0],
    fileKeys,
    fileName: files.map((f) => f.name).join(", "),
    fileSize: files.reduce((s, f) => s + f.size, 0),
    audio: { chapters, durationSec: offset },
    progress: { fraction: 0, positionSec: 0 },
    addedAt: Date.now(),
    lastOpenedAt: null,
    needsMeta: !inferred.title || !inferred.author,
  };
  await putBook(book);
  autoMeta(book);
  return book;
};

/** Silent metadata lookup on import; applies confident matches only. */
const autoMeta = async (book) => {
  try {
    const cands = await searchMetadata(book.title, book.author);
    const match = cands.find((c) => metaConfident(c, book));
    if (!match) return;
    // merge into a fresh record — the user may have opened/read the book
    // while the lookup was in flight; never regress progress or edits
    const cur = (await getBook(book.id)) || book;
    if (!cur.coverBlob && match.cover)
      cur.coverBlob = (await fetchCoverBlob(match.cover)) || cur.coverBlob;
    if (!cur.desc && match.desc) cur.desc = match.desc;
    if (!cur.year && match.year) cur.year = match.year;
    if (!cur.author && match.author) cur.author = match.author;
    if (!cur.title && match.title) cur.title = match.title;
    cur.identifiers = { ...(cur.identifiers || {}), ...match.identifiers };
    cur.needsMeta = false;
    cur.metaSource = match.source;
    await putBook(cur);
  } catch { /* background fill — ignore */ }
};
