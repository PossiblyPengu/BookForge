import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

let db, open, transaction, request, store, connection;

beforeEach(async () => {
  vi.resetModules();
  request = {};
  store = { put: vi.fn(() => request), get: vi.fn(() => request), delete: vi.fn() };
  transaction = { objectStore: vi.fn(() => store), abort: vi.fn() };
  connection = { transaction: vi.fn(() => transaction), close: vi.fn() };
  open = {};
  vi.stubGlobal("indexedDB", { open: vi.fn(() => open) });
  db = await import("../docs/js/db.js");
});

afterEach(() => vi.unstubAllGlobals());

const connect = async () => {
  open.result = connection;
  open.onsuccess();
  await Promise.resolve();
};

describe("IndexedDB writes", () => {
  for (const [name, args] of [
    ["putBook", [{ id: "book" }]],
    ["putFile", ["file", new Blob(["book"])]],
    ["kvSet", ["setting", true]],
  ]) {
    it(`${name} waits for the transaction to commit`, async () => {
      const resolved = vi.fn();
      const writing = db[name](...args).then(resolved);
      await connect();
      request.result = "key";
      request.onsuccess();
      await Promise.resolve();
      expect(resolved).not.toHaveBeenCalled();
      transaction.oncomplete();
      await writing;
      expect(resolved).toHaveBeenCalledWith("key");
    });

    it(`${name} rejects an abort after request success`, async () => {
      const writing = db[name](...args);
      const rejected = expect(writing).rejects.toThrow("quota");
      await connect();
      request.onsuccess();
      transaction.error = new Error("quota");
      transaction.onabort();
      await rejected;
    });
  }

  it("deleteFiles rejects explicit aborts even without a transaction error", async () => {
    const writing = db.deleteFiles(["file"]);
    const rejected = expect(writing).rejects.toThrow("aborted");
    await connect();
    transaction.onabort();
    await rejected;
  });

  it("deleteBook rejects explicit aborts after scheduling its deletions", async () => {
    const writing = db.deleteBook("book");
    const rejected = expect(writing).rejects.toThrow("aborted");
    await connect();
    request.result = { id: "book", fileKey: "file:book" };
    request.onsuccess();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.delete).toHaveBeenCalledWith("book");
    expect(store.delete).toHaveBeenCalledWith("file:book");
    transaction.onabort();
    await rejected;
  });
});

describe("kvUpdate", () => {
  it("reads and writes in the same readwrite transaction and waits for commit", async () => {
    const writing = db.kvUpdate("queue", (q) => [...q, "new"], []);
    await connect();
    request.result = { k: "queue", v: ["old"] };
    request.onsuccess();
    expect(connection.transaction).toHaveBeenCalledExactlyOnceWith("kv", "readwrite");
    expect(store.put).toHaveBeenCalledWith({ k: "queue", v: ["old", "new"] });
    transaction.oncomplete();
    await expect(writing).resolves.toEqual(["old", "new"]);
  });

  it("uses the fallback when the key is missing", async () => {
    const writing = db.kvUpdate("queue", (q) => [...q, "new"], []);
    await connect();
    request.onsuccess();
    transaction.oncomplete();
    await expect(writing).resolves.toEqual(["new"]);
  });

  it("aborts when the updater throws", async () => {
    const writing = db.kvUpdate("queue", () => { throw new Error("bad update"); });
    const rejected = expect(writing).rejects.toThrow("bad update");
    await connect();
    request.onsuccess();
    await rejected;
    expect(transaction.abort).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });
});

it("retries opening the database after a transient open failure", async () => {
  const first = db.kvGet("key");
  const rejected = expect(first).rejects.toThrow("unavailable");
  open.error = new Error("unavailable");
  open.onerror();
  await rejected;
  const retry = db.kvGet("key");
  expect(indexedDB.open).toHaveBeenCalledTimes(2);
  await connect();
  request.onsuccess();
  await expect(retry).resolves.toBeNull();
});
