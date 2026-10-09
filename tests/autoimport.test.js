import { describe, it, expect, beforeEach } from "vitest";

// --- in-memory IndexedDB: db.js is lazy, so the stub only has to exist
// before the first kvGet/kvSet/allBooks call
const stores = {};
const store = (name) => (stores[name] ??= new Map());
const tick = () => Promise.resolve();
const req = (result) => {
  const r = { result };
  tick().then(() => r.onsuccess?.());
  return r;
};
const objStore = (name, keyPath) => ({
  get: (k) => req(store(name).get(k)),
  getAll: () => req([...store(name).values()]),
  put: (v) => { store(name).set(v[keyPath], v); return req(v); },
  delete: (k) => { store(name).delete(k); return req(undefined); },
});
const oss = {
  kv: objStore("kv", "k"),
  books: objStore("books", "id"),
  files: objStore("files", "key"),
};
globalThis.indexedDB = {
  open: () => {
    const r = {};
    tick().then(() => {
      r.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => ({ objectStore: (n) => oss[n] }),
      };
      r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};

const {
  autoImportSupported, diffNew, watchFolder, unwatchFolder, listWatched,
  scanWatched, grantFolder,
} = await import("../docs/js/autoimport.js");
const { putBook } = await import("../docs/js/db.js");

// --- fake File System Access handles
const fileHandle = (name, size = 10, mtime = 1) => {
  const h = {
    kind: "file",
    name,
    isSameEntry: async (o) => o === h,
    getFile: async () => new File(["x".repeat(size)], name, { lastModified: mtime }),
  };
  return h;
};
const dirHandle = (name, children = [], { permission = "granted" } = {}) => {
  const h = {
    kind: "directory",
    name,
    perm: permission,
    isSameEntry: async (o) => o === h,
    queryPermission: async () => h.perm,
    requestPermission: async () => (h.perm = "granted"),
    values: async function* () { yield* children; },
  };
  return h;
};

const pick = (handle) => {
  globalThis.window = { showDirectoryPicker: async () => handle };
};

describe("autoImportSupported", () => {
  it("is false without showDirectoryPicker and true with it", () => {
    globalThis.window = {};
    expect(autoImportSupported()).toBe(false);
    globalThis.window = { showDirectoryPicker: async () => ({}) };
    expect(autoImportSupported()).toBe(true);
    delete globalThis.window;
    expect(autoImportSupported()).toBe(false);
  });
});

describe("diffNew", () => {
  const found = [
    { rel: "Lib/a.epub", file: { size: 5, lastModified: 1 } },
    { rel: "Lib/b.epub", file: { size: 6, lastModified: 1 } },
  ];

  it("returns everything when nothing is seen", () => {
    expect(diffNew("id1", found, {})).toHaveLength(2);
  });

  it("drops files whose signature was already recorded", () => {
    const seen = { "id1#Lib/a.epub#5#1": 1 };
    expect(diffNew("id1", found, seen).map((f) => f.rel)).toEqual(["Lib/b.epub"]);
  });

  it("treats a changed size or mtime as new", () => {
    const seen = { "id1#Lib/a.epub#5#1": 1, "id1#Lib/b.epub#6#1": 1 };
    const changed = [
      { rel: "Lib/a.epub", file: { size: 5, lastModified: 1 } },
      { rel: "Lib/b.epub", file: { size: 9, lastModified: 1 } },
    ];
    expect(diffNew("id1", changed, seen).map((f) => f.rel)).toEqual(["Lib/b.epub"]);
  });

  it("keeps same-named folders separate by id", () => {
    const seen = { "id1#Lib/a.epub#5#1": 1 };
    expect(diffNew("id2", found.slice(0, 1), seen)).toHaveLength(1);
  });
});

describe("watch/unwatch", () => {
  beforeEach(() => { store("kv").clear(); });

  it("persists the folder and refuses duplicates by handle", async () => {
    const dir = dirHandle("Books");
    pick(dir);
    expect((await watchFolder()).added).toBe(true);
    expect((await watchFolder()).added).toBe(false);
    expect(await listWatched()).toHaveLength(1);
  });

  it("unwatch removes only the matching folder", async () => {
    const a = dirHandle("Books"), b = dirHandle("Books"); // same name!
    store("kv").set("watch:folders", { k: "watch:folders", v: [
      { id: "a", name: "Books", handle: a },
      { id: "b", name: "Books", handle: b },
    ] });
    await unwatchFolder({ id: "a", name: "Books", handle: a });
    const left = await listWatched();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe("b");
  });
});

describe("scanWatched", () => {
  beforeEach(() => {
    store("kv").clear();
    store("books").clear();
  });

  it("returns nothing with no watched folders", async () => {
    pick(dirHandle("x"));
    expect(await scanWatched()).toEqual({ folders: 0, files: [], blocked: [] });
  });

  it("finds new files once, then stays quiet", async () => {
    const dir = dirHandle("Lib", [
      fileHandle("one.epub"),
      dirHandle("sub", [fileHandle("two.m4b")]),
    ]);
    store("kv").set("watch:folders", { k: "watch:folders", v: [{ id: "f1", name: "Lib", handle: dir }] });
    globalThis.window = { showDirectoryPicker: async () => dir };

    const first = await scanWatched();
    expect(first.files).toHaveLength(2);
    expect(first.files.map((f) => f.name).sort()).toEqual(["Lib/one.epub", "Lib/sub/two.m4b"]);

    expect((await scanWatched()).files).toHaveLength(0); // all seen now
  });

  it("imports a file added later without re-offering old ones", async () => {
    const kids = [fileHandle("one.epub")];
    const dir = dirHandle("Lib", kids);
    store("kv").set("watch:folders", { k: "watch:folders", v: [{ id: "f1", name: "Lib", handle: dir }] });
    globalThis.window = { showDirectoryPicker: async () => dir };
    await scanWatched();

    kids.push(fileHandle("two.epub"));
    const next = await scanWatched();
    expect(next.files.map((f) => f.name)).toEqual(["Lib/two.epub"]);
  });

  it("skips files already in the library by basename+size", async () => {
    const dir = dirHandle("Lib", [fileHandle("have.epub", 42), fileHandle("new.epub", 7)]);
    store("kv").set("watch:folders", { k: "watch:folders", v: [{ id: "f1", name: "Lib", handle: dir }] });
    globalThis.window = { showDirectoryPicker: async () => dir };
    await putBook({ id: "b1", fileName: "have.epub", fileSize: 42 });

    const r = await scanWatched();
    expect(r.files.map((f) => f.name)).toEqual(["Lib/new.epub"]);
  });

  it("skips rel-path fileNames written by a previous auto-import", async () => {
    const dir = dirHandle("Lib", [dirHandle("A", [fileHandle("b.epub", 42)])]);
    store("kv").set("watch:folders", { k: "watch:folders", v: [{ id: "f1", name: "Lib", handle: dir }] });
    globalThis.window = { showDirectoryPicker: async () => dir };
    await putBook({ id: "b1", fileName: "Lib/A/b.epub", fileSize: 42 });
    expect((await scanWatched()).files).toHaveLength(0);
  });

  it("lists ungranted folders as blocked without scanning", async () => {
    const dir = dirHandle("Lib", [fileHandle("a.epub")], { permission: "prompt" });
    store("kv").set("watch:folders", { k: "watch:folders", v: [{ id: "f1", name: "Lib", handle: dir }] });
    globalThis.window = { showDirectoryPicker: async () => dir };

    const r = await scanWatched();
    expect(r.files).toHaveLength(0);
    expect(r.blocked).toEqual(["Lib"]);
    expect(await dir.queryPermission()).toBe("prompt"); // no silent prompt
  });

  it("a thrown scan lands the folder in blocked, not the whole run", async () => {
    const bad = dirHandle("Bad");
    bad.values = () => { throw new Error("denied"); };
    const good = dirHandle("Good", [fileHandle("a.epub")]);
    store("kv").set("watch:folders", { k: "watch:folders", v: [
      { id: "b1", name: "Bad", handle: bad },
      { id: "g1", name: "Good", handle: good },
    ] });
    globalThis.window = { showDirectoryPicker: async () => good };

    const r = await scanWatched();
    expect(r.blocked).toEqual(["Bad"]);
    expect(r.files.map((f) => f.name)).toEqual(["Good/a.epub"]);
  });

  it("re-offers files after unwatch+rewatch (fresh folder id)", async () => {
    const dir = dirHandle("Lib", [fileHandle("a.epub")]);
    pick(dir);
    await watchFolder();
    await scanWatched();
    expect((await scanWatched()).files).toHaveLength(0);

    await unwatchFolder((await listWatched())[0]);
    await watchFolder(); // same folder → new id, seen keys pruned
    expect((await scanWatched()).files).toHaveLength(1);
  });
});

describe("grantFolder", () => {
  it("requests permission through the handle", async () => {
    const dir = dirHandle("Lib", [], { permission: "prompt" });
    expect(await grantFolder(dir)).toBe("granted");
    expect(await dir.queryPermission()).toBe("granted");
  });
});
