/**
 * session.js
 *
 * IndexedDB-backed session persistence for BookForge.
 * Stores tracks (with MP3 blobs), cover art, form fields,
 * wizard step, and inferred book info.
 */

const DB_NAME = "bookforge";
const DB_VERSION = 1;
const STORE = "session";
const SESSION_KEY = "session";

const openDB = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Save the current session state to IndexedDB.
 * @param {object} state
 * @param {string} state.currentStep
 * @param {object} state.formFields
 * @param {object|null} state.inferredBook
 * @param {Blob|null} state.coverBlob
 * @param {Array} state.tracks - [{ blob, fileName, fileType, fileLastModified, chapterName, meta }]
 */
export const saveSession = async (state) => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      id: SESSION_KEY,
      version: 1,
      savedAt: Date.now(),
      ...state,
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("Session save failed:", err);
  }
};

/**
 * Load the saved session from IndexedDB.
 * @returns {Promise<object|null>} The session state, or null if none exists.
 */
export const loadSession = async () => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(SESSION_KEY);
    const result = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch (err) {
    console.warn("Session load failed:", err);
    return null;
  }
};

/**
 * Delete the saved session from IndexedDB.
 */
export const clearSession = async () => {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(SESSION_KEY);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("Session clear failed:", err);
  }
};
