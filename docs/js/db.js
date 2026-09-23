/**
 * db.js — IndexedDB persistence.
 *
 * Stores:
 *   books  — book metadata records (keyPath: id)
 *   files  — binary payloads (book files) keyed by string key
 *   kv     — settings and per-book extras (keyPath: k)
 */

const DB_NAME = "pageturner";
const DB_VERSION = 1;

let dbPromise;
const db = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("books"))
          d.createObjectStore("books", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files"))
          d.createObjectStore("files", { keyPath: "key" });
        if (!d.objectStoreNames.contains("kv"))
          d.createObjectStore("kv", { keyPath: "k" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
};

const reqToPromise = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// ---------- books ----------
export const putBook = async (book) => {
  const d = await db();
  return reqToPromise(
    d.transaction("books", "readwrite").objectStore("books").put(book)
  );
};

export const getBook = async (id) => {
  const d = await db();
  return reqToPromise(d.transaction("books").objectStore("books").get(id));
};

export const allBooks = async () => {
  const d = await db();
  const list = await reqToPromise(
    d.transaction("books").objectStore("books").getAll()
  );
  return list.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
};

export const deleteBook = async (id) => {
  const d = await db();
  const book = await getBook(id);
  const t = d.transaction(["books", "files"], "readwrite");
  t.objectStore("books").delete(id);
  for (const key of book?.fileKeys || (book?.fileKey ? [book.fileKey] : []))
    t.objectStore("files").delete(key);
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
};

// ---------- files ----------
export const putFile = async (key, blob, meta = {}) => {
  const d = await db();
  return reqToPromise(
    d.transaction("files", "readwrite").objectStore("files").put({ key, blob, ...meta })
  );
};

export const getFile = async (key) => {
  const d = await db();
  const rec = await reqToPromise(d.transaction("files").objectStore("files").get(key));
  return rec?.blob || null;
};

export const allFiles = async () => {
  const d = await db();
  return reqToPromise(d.transaction("files").objectStore("files").getAll());
};

// ---------- kv ----------
export const kvGet = async (k, fallback = null) => {
  const d = await db();
  const rec = await reqToPromise(d.transaction("kv").objectStore("kv").get(k));
  return rec ? rec.v : fallback;
};

export const kvSet = async (k, v) => {
  const d = await db();
  return reqToPromise(
    d.transaction("kv", "readwrite").objectStore("kv").put({ k, v })
  );
};

export const allKv = async () => {
  const d = await db();
  return reqToPromise(d.transaction("kv").objectStore("kv").getAll());
};

export const storageEstimate = async () => {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
};
