/**
 * backup.js — export/restore the whole library as a single zip.
 *
 * Layout inside the archive:
 *   data.json      { v, books (coverBlob stripped → hasCover), kv, fileMeta }
 *   files/<key>    raw book payloads
 *   covers/<id>    cover image blobs
 */

import { allBooks, allFiles, allKv, putBook, putFile, kvSet } from "./db.js";
import { exportBlob, toast } from "./util.js";

const encoder = new TextEncoder();

export const exportLibrary = async (onMsg = () => {}) => {
  const { zipSync } = await import("../vendor/fflate.mjs");
  onMsg("Collecting library…");
  const [books, files, kv] = await Promise.all([allBooks(), allFiles(), allKv()]);

  const entries = {};
  const fileMeta = {};
  for (const f of files) {
    fileMeta[f.key] = { name: f.name || "", size: f.size ?? f.blob?.size ?? 0, type: f.blob?.type || "" };
    entries[`files/${encodeURIComponent(f.key)}`] = new Uint8Array(await f.blob.arrayBuffer());
  }
  const bookRecs = [];
  for (const b of books) {
    const { coverBlob, ...rec } = b;
    rec.hasCover = !!coverBlob;
    bookRecs.push(rec);
    if (coverBlob) entries[`covers/${b.id}`] = new Uint8Array(await coverBlob.arrayBuffer());
  }
  const kvMap = {};
  for (const { k, v } of kv) kvMap[k] = v;
  entries["data.json"] = encoder.encode(JSON.stringify({ v: 1, app: "pageturner", exportedAt: Date.now(), books: bookRecs, kv: kvMap, fileMeta }));

  onMsg("Compressing…");
  const zipped = zipSync(entries, { level: 4 });
  const date = new Date().toISOString().slice(0, 10);
  return { blob: new Blob([zipped], { type: "application/zip" }), name: `pageturner-backup-${date}.zip` };
};

export const deliverBackup = async (onMsg = () => {}) => {
  const { blob, name } = await exportLibrary(onMsg);
  await exportBlob(blob, name);
  toast("Backup exported");
};

export const restoreBackup = async (file, onMsg = () => {}) => {
  const { unzipSync } = await import("../vendor/fflate.mjs");
  onMsg("Reading backup…");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const dataEntry = entries["data.json"];
  if (!dataEntry) throw new Error("Not a Pageturner backup (missing data.json)");
  const data = JSON.parse(new TextDecoder().decode(dataEntry));
  if (!Array.isArray(data.books)) throw new Error("Invalid backup format");

  onMsg("Restoring files…");
  const prefix = "files/";
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith(prefix)) continue;
    const key = decodeURIComponent(path.slice(prefix.length));
    const meta = data.fileMeta?.[key] || {};
    await putFile(key, new Blob([bytes], { type: meta.type || "application/octet-stream" }), { name: meta.name, size: meta.size });
  }

  onMsg("Restoring books…");
  for (const rec of data.books) {
    const coverEntry = entries[`covers/${rec.id}`];
    const book = { ...rec };
    delete book.hasCover;
    if (coverEntry) book.coverBlob = new Blob([coverEntry]);
    await putBook(book);
  }
  for (const [k, v] of Object.entries(data.kv || {})) await kvSet(k, v);
  return data.books.length;
};
