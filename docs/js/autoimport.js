/**
 * autoimport.js — watched folders: books land in the library on their own.
 *
 * File System Access API only (Chromium on desktop/Android). iOS Safari has
 * no directory handles — `showDirectoryPicker` doesn't exist — so the UI
 * hides entirely rather than offer a dead feature.
 *
 * Directory handles persist in IndexedDB (structured-cloneable). Every
 * launch re-scans folders whose read permission survived, diffs files by
 * path+size+mtime against a seen-map, and imports what's new. Scanned
 * files are re-wrapped with their folder-relative path as the name so
 * audiobooks still group by directory. Import is one-way: deleting a file
 * from the folder never deletes the book.
 */

import { kvGet, kvSet, allBooks } from "./db.js";

const FOLDERS_KEY = "watch:folders"; // [{ id, name, handle }]
const SEEN_KEY = "watch:seen";       // { "id#rel/path#size#mtime": 1 }

export const autoImportSupported = () =>
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

export const listWatched = () => kvGet(FOLDERS_KEY, []);

/** Two watched folders can share a name — the id keeps their signatures apart. */
const sig = (id, rel, file) => `${id}#${rel}#${file.size}#${file.lastModified}`;

/** Split found files into new vs already-seen. Pure — exported for tests. */
export const diffNew = (id, found, seen) =>
  found.filter(({ rel, file }) => !seen[sig(id, rel, file)]);

export const markSeen = async (id, found, seen = null) => {
  const map = seen || (await kvGet(SEEN_KEY, {}));
  for (const { rel, file } of found) map[sig(id, rel, file)] = 1;
  await kvSet(SEEN_KEY, map);
  return map;
};

/** Pick a folder and start watching it. Throws AbortError when cancelled. */
export const watchFolder = async () => {
  const handle = await window.showDirectoryPicker({ mode: "read" });
  const folders = await listWatched();
  for (const f of folders) {
    if (await f.handle.isSameEntry(handle)) return { name: handle.name, added: false };
  }
  folders.push({ id: crypto.randomUUID(), name: handle.name, handle });
  await kvSet(FOLDERS_KEY, folders);
  return { name: handle.name, added: true };
};

/**
 * Stop watching — matches by handle so same-named folders survive. The
 * folder's seen-signatures go too: re-adding it later re-offers the books,
 * and existingSigs() still skips what's already in the library.
 */
export const unwatchFolder = async (target) => {
  const keep = [];
  for (const f of await listWatched()) {
    if (!(await f.handle.isSameEntry(target.handle))) keep.push(f);
  }
  await kvSet(FOLDERS_KEY, keep);
  const seen = await kvGet(SEEN_KEY, {});
  const prefix = `${target.id || target.name}#`;
  let dirty = false;
  for (const k of Object.keys(seen)) {
    if (k.startsWith(prefix)) { delete seen[k]; dirty = true; }
  }
  if (dirty) await kvSet(SEEN_KEY, seen);
};

const collect = async (dir, prefix, out) => {
  for await (const entry of dir.values()) {
    if (entry.kind === "directory") await collect(entry, `${prefix}${entry.name}/`, out);
    else out.push({ rel: `${prefix}${entry.name}`, file: await entry.getFile() });
  }
};

/**
 * Basename+size already in the library — the manual-import path never wrote
 * seen signatures, so without this a watched folder would re-import books
 * that were dragged in by hand. Per-file sizes aren't stored on multi-file
 * audio books, so those only dedup through the seen-map.
 */
const existingSigs = async () => {
  const s = new Set();
  for (const b of await allBooks()) {
    if (b.fileSize == null || !b.fileName) continue;
    for (const n of String(b.fileName).split(", ")) s.add(`${n}#${b.fileSize}`);
  }
  return s;
};

/**
 * Scan every watched folder and return fresh File[] for the caller to run
 * through doImport (which owns progress UI + library refresh). Files are
 * re-wrapped with the folder-relative path as the name — that's what
 * dirOf() groups audiobook folders by.
 * Returns { folders, files, blocked:[names] } — blocked folders are
 * ungranted handles that need a tap to re-permit (requestPermission
 * requires a gesture, so a boot-time scan can't ask).
 */
export const scanWatched = async () => {
  if (!autoImportSupported()) return { folders: 0, files: [], blocked: [] };
  const folders = await listWatched();
  if (!folders.length) return { folders: 0, files: [], blocked: [] };

  const seen = await kvGet(SEEN_KEY, {});
  const known = await existingSigs();
  const blocked = [];
  const files = [];

  for (const { id, name, handle } of folders) {
    const fid = id || name; // records written before ids existed key on name
    try {
      if ((await handle.queryPermission({ mode: "read" })) !== "granted") {
        blocked.push(name);
        continue;
      }
      const found = [];
      await collect(handle, `${name}/`, found);
      // known check runs on the raw file (basename) AND the rel path —
      // a book imported through this feature stores the rel path as its
      // fileName, a manual import stores the basename
      const fresh = diffNew(fid, found, seen)
        .filter(({ rel, file }) =>
          !known.has(`${file.name}#${file.size}`) && !known.has(`${rel}#${file.size}`));
      // attempted files are marked seen either way — a file that can't
      // import (quota, corrupt) must not retry forever on every launch
      for (const { rel, file } of fresh) seen[sig(fid, rel, file)] = 1;
      for (const { rel, file } of fresh)
        files.push(new File([file], rel, { type: file.type, lastModified: file.lastModified }));
    } catch (err) {
      console.warn(`Watched folder "${name}" scan failed:`, err);
      blocked.push(name);
    }
  }
  await kvSet(SEEN_KEY, seen);
  return { folders: folders.length, files, blocked };
};

/** Re-grant a watched folder's read access — needs a user gesture. */
export const grantFolder = (handle) => handle.requestPermission({ mode: "read" });
