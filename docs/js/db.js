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
      req.onsuccess = () => {
        const d = req.result;
        // A schema upgrade in another tab closes this connection; without the
        // close + reopen, every following write throws InvalidStateError
        d.onversionchange = () => { d.close(); dbPromise = null; };
        resolve(d);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => console.warn("IndexedDB upgrade blocked by another open tab");
    });
  }
  return dbPromise;
};

const reqToPromise = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const transactionDone = (t) => new Promise((resolve, reject) => {
  t.oncomplete = resolve;
  t.onabort = t.onerror = () => reject(t.error || new Error("Storage transaction aborted"));
});

const writeResult = async (t, request) => {
  const [result] = await Promise.all([reqToPromise(request), transactionDone(t)]);
  return result;
};

// ---------- books ----------
export const putBook = async (book) => {
  const d = await db();
  const t = d.transaction("books", "readwrite");
  return writeResult(t, t.objectStore("books").put(book));
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
  return transactionDone(t);
};

// ---------- files ----------
export const putFile = async (key, blob, meta = {}) => {
  const d = await db();
  const t = d.transaction("files", "readwrite");
  return writeResult(t, t.objectStore("files").put({ key, blob, ...meta }));
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

/**
 * File records no book points at — interrupted restores and old delete bugs
 * leave them behind, and on a phone's quota that's real storage gone.
 */
export const orphanedFiles = async () => {
  const [books, files] = await Promise.all([allBooks(), allFiles()]);
  const used = new Set();
  for (const b of books)
    for (const k of b.fileKeys || (b.fileKey ? [b.fileKey] : [])) used.add(k);
  return files.filter((f) => !used.has(f.key));
};

export const deleteFiles = async (keys) => {
  const d = await db();
  const t = d.transaction("files", "readwrite");
  for (const k of keys) t.objectStore("files").delete(k);
  return transactionDone(t);
};

// ---------- kv ----------
export const kvGet = async (k, fallback = null) => {
  const d = await db();
  const rec = await reqToPromise(d.transaction("kv").objectStore("kv").get(k));
  return rec ? rec.v : fallback;
};

export const kvSet = async (k, v) => {
  const d = await db();
  const t = d.transaction("kv", "readwrite");
  return writeResult(t, t.objectStore("kv").put({ k, v }));
};

/** Read-modify-write in one transaction, so concurrent tabs cannot lose updates. */
export const kvUpdate = async (k, update, fallback = null) => {
  const d = await db();
  const t = d.transaction("kv", "readwrite");
  const store = t.objectStore("kv");
  return new Promise((resolve, reject) => {
    let value;
    t.oncomplete = () => resolve(value);
    t.onabort = t.onerror = () => reject(t.error || new Error("Storage transaction aborted"));
    const request = store.get(k);
    request.onsuccess = () => {
      try {
        value = update(request.result ? request.result.v : fallback);
        store.put({ k, v: value });
      } catch (err) {
        reject(err);
        t.abort();
      }
    };
  });
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
