/**
 * backup.js — export/restore the whole library as a single zip.
 *
 * Layout inside the archive:
 *   data.json      { v, books (coverBlob stripped → hasCover), kv, fileMeta }
 *   files/<key>    raw book payloads
 *   covers/<id>    cover image blobs
 *
 * Entries are stored, not compressed: books and audio already are, and the
 * archive is assembled by reference from the Blobs IndexedDB hands back
 * (zip.js), so exporting a multi-gigabyte audiobook library never copies it
 * into memory. The old exporter did — every file as a Uint8Array, plus the
 * compressed output, in one synchronous call — and ran out of memory on
 * exactly the libraries a backup matters most for. Backups it produced
 * (deflated) still restore.
 */

import { allBooks, allFiles, allKv, putBook, putFile, kvSet } from "./db.js";
import { exportBlob, toast, dropCoverUrl, shrinkCover } from "./util.js";
import { writeZip, readZip } from "./zip.js";

const pct = (done, total) => (total ? Math.min(100, Math.floor((done / total) * 100)) : 100);

export const exportLibrary = async (onMsg = () => {}) => {
  onMsg("Collecting library…");
  const [books, files, kv] = await Promise.all([allBooks(), allFiles(), allKv()]);

  const fileMeta = {};
  const entries = [];
  const bookRecs = [];
  const covers = [];
  for (const b of books) {
    const { coverBlob, ...rec } = b;
    rec.hasCover = !!coverBlob;
    bookRecs.push(rec);
    if (coverBlob) covers.push({ name: `covers/${b.id}`, blob: coverBlob });
  }
  for (const f of files) {
    if (!f.blob) continue;
    fileMeta[f.key] = { name: f.name || "", size: f.size ?? f.blob.size, type: f.blob.type || "" };
    entries.push({ name: `files/${encodeURIComponent(f.key)}`, blob: f.blob });
  }
  const kvMap = {};
  for (const { k, v } of kv) kvMap[k] = v;
  const data = JSON.stringify({
    v: 1, app: "pageturner", exportedAt: Date.now(), books: bookRecs, kv: kvMap, fileMeta,
  });

  // data.json first, so a person unzipping by hand finds the index at the top
  const zip = await writeZip(
    [{ name: "data.json", blob: new Blob([data], { type: "application/json" }) }, ...entries, ...covers],
    { onProgress: ({ done, total }) => onMsg(`Preparing backup… ${pct(done, total)}%`) },
  );
  const date = new Date().toISOString().slice(0, 10);
  return { blob: zip, name: `pageturner-backup-${date}.zip`, books: bookRecs.length };
};

export const deliverBackup = async (onMsg = () => {}) => {
  const { blob, name, books } = await exportLibrary(onMsg);
  onMsg("Saving…");
  await exportBlob(blob, name);
  toast(`Backup of ${books} book${books === 1 ? "" : "s"} exported`);
};

export const restoreBackup = async (file, onMsg = () => {}) => {
  onMsg("Reading backup…");
  // Only old, deflated backups need an inflater, so fflate loads for them
  // alone. The closure looks it up when an entry is actually read, which is
  // after the directory has shown whether it's needed.
  let inflateSync = null;
  const entries = await readZip(file, {
    inflate: (bytes, out) => inflateSync(bytes, out),
  }).catch((err) => {
    throw new Error(/zip/i.test(err.message) ? "That file isn't a Pageturner backup (not a zip)." : err.message);
  });
  if (entries.some((e) => e.method === 8))
    ({ inflateSync } = await import("../vendor/fflate.mjs"));

  const byName = new Map(entries.map((e) => [e.name, e]));
  const dataEntry = byName.get("data.json");
  if (!dataEntry) throw new Error("Not a Pageturner backup (missing data.json)");
  const data = JSON.parse(await (await dataEntry.blob()).text());
  if (data.app !== "pageturner") throw new Error("That zip isn't a Pageturner backup.");
  if (typeof data.v !== "number" || data.v > 1)
    throw new Error("This backup was made by a newer version of Pageturner.");
  if (!Array.isArray(data.books)) throw new Error("Invalid backup format");

  const prefix = "files/";
  const fileEntries = entries.filter((e) => e.name.startsWith(prefix));
  const totalBytes = fileEntries.reduce((n, e) => n + e.size, 0) || 1;
  let doneBytes = 0;
  const restored = new Set();
  for (const e of fileEntries) {
    const key = decodeURIComponent(e.name.slice(prefix.length));
    const meta = data.fileMeta?.[key] || {};
    onMsg(`Restoring files… ${pct(doneBytes, totalBytes)}%`);
    try {
      // a stored entry is a slice of the backup file: wrapping it sets the
      // type without copying it
      const blob = new Blob([await e.blob()], { type: meta.type || "application/octet-stream" });
      await putFile(key, blob, { name: meta.name, size: meta.size ?? blob.size });
      restored.add(key);
    } catch (err) {
      console.warn(`restore: skipping damaged file entry ${key}`, err);
    }
    doneBytes += e.size;
  }

  onMsg("Restoring books…");
  let restoredBooks = 0;
  let skipped = 0;
  for (const rec of data.books) {
    // a book whose payload didn't restore would open to a broken file —
    // leave it out instead of writing a zombie record
    const keys = rec.fileKeys || (rec.fileKey ? [rec.fileKey] : []);
    if (keys.length && !keys.every((k) => restored.has(k))) { skipped++; continue; }
    const coverEntry = byName.get(`covers/${rec.id}`);
    const book = { ...rec };
    delete book.hasCover;
    if (coverEntry) {
      book.coverBlob = await shrinkCover(new Blob([await coverEntry.blob()]));
      dropCoverUrl(rec.id); // an existing same-id book's cached URL is stale now
    }
    await putBook(book);
    restoredBooks++;
  }
  for (const [k, v] of Object.entries(data.kv || {})) await kvSet(k, v);
  return { books: restoredBooks, skipped };
};
