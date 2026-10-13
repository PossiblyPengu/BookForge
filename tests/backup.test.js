import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { restoreBackup, exportLibrary } from "../docs/js/backup.js";
import { writeZip } from "../docs/js/zip.js";
import { allBooks, allFiles, allKv, putBook, putFile, kvSet } from "../docs/js/db.js";
import { dropCoverUrl } from "../docs/js/util.js";

vi.mock("../docs/js/db.js", () => ({
  allBooks: vi.fn(), allFiles: vi.fn(), allKv: vi.fn(),
  putBook: vi.fn(), putFile: vi.fn(), kvSet: vi.fn(),
}));

vi.mock("../docs/js/util.js", () => ({
  exportBlob: vi.fn(), toast: vi.fn(), dropCoverUrl: vi.fn(), shrinkCover: vi.fn(async (blob) => blob),
}));

const book = (extra = {}) => ({ id: "book", title: "Dune", kind: "ebook", format: "EPUB", fileKey: "file:book", ...extra });
const archive = (data, entries = []) => writeZip([
  { name: "data.json", blob: new Blob([JSON.stringify(data)]) }, ...entries,
]);
const index = (books = [book()], extra = {}) => ({ app: "pageturner", v: 1, books, ...extra });
const payload = (key = "file:book") => ({ name: `files/${encodeURIComponent(key)}`, blob: new Blob(["book bytes"]) });

beforeEach(() => {
  vi.clearAllMocks();
  putFile.mockResolvedValue(undefined);
  putBook.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("restoreBackup", () => {
  it("does not export device-local watched-folder capabilities or signatures", async () => {
    allBooks.mockResolvedValue([]);
    allFiles.mockResolvedValue([]);
    allKv.mockResolvedValue([{ k: "watch:folders", v: [{ handle: {} }] }, { k: "watch:seen", v: { old: 1 } }, { k: "reader-font", v: "serif" }]);
    const { blob } = await exportLibrary();
    await restoreBackup(blob);
    expect(kvSet.mock.calls).toEqual([["reader-font", "serif"]]);
  });

  it("keeps this device’s folder handles when restoring an older backup", async () => {
    await restoreBackup(await archive(index([], { kv: { "watch:folders": [{}], "watch:seen": {}, "reader-font": "serif" } })));
    expect(kvSet.mock.calls).toEqual([["reader-font", "serif"]]);
  });
  it("round-trips book payloads, covers and settings", async () => {
    const cover = new Blob(["cover bytes"]);
    allBooks.mockResolvedValue([book({ coverBlob: cover, progress: { fraction: 0.4 } })]);
    allFiles.mockResolvedValue([{ key: "file:book", blob: payload().blob, name: "Dune.epub" }]);
    allKv.mockResolvedValue([{ k: "reader-font", v: "serif" }]);
    const backup = await exportLibrary();
    await expect(restoreBackup(backup.blob)).resolves.toEqual({ books: 1, skipped: 0 });
    expect(putFile.mock.calls[0][0]).toBe("file:book");
    expect(await putFile.mock.calls[0][1].text()).toBe("book bytes");
    expect(putBook.mock.calls[0][0].progress.fraction).toBe(0.4);
    expect(await putBook.mock.calls[0][0].coverBlob.text()).toBe("cover bytes");
    expect(kvSet).toHaveBeenCalledWith("reader-font", "serif");
  });

  it("skips malformed book records without stopping valid books", async () => {
    const file = await archive(index([
      null, "invalid", book({ id: "bad", fileKeys: "file:book" }),
      book({ id: "empty", fileKey: undefined }), book(),
    ]), [payload()]);
    await expect(restoreBackup(file)).resolves.toEqual({ books: 1, skipped: 4 });
    expect(putBook).toHaveBeenCalledOnce();
    expect(putBook.mock.calls[0][0].id).toBe("book");
  });

  it("skips a malformed percent-encoded entry without losing valid files", async () => {
    const file = await archive(index(), [
      { name: "files/bad%key", blob: new Blob(["bad"]) }, payload(),
    ]);
    await expect(restoreBackup(file)).resolves.toEqual({ books: 1, skipped: 0 });
    expect(putFile).toHaveBeenCalledOnce();
  });

  it("restores a book without its corrupt cover and continues", async () => {
    const zip = await archive(index([book(), book({ id: "second" })]), [
      payload(), { name: "covers/book", blob: new Blob(["cover bytes"]) },
    ]);
    // Damage the local file header signature: the directory still lists the cover.
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const name = new TextEncoder().encode("covers/book");
    const start = bytes.findIndex((_, i) => name.every((b, j) => bytes[i + j] === b));
    expect(start).toBeGreaterThanOrEqual(30);
    bytes[start - 30] = 0;
    await expect(restoreBackup(new Blob([bytes]))).resolves.toEqual({ books: 2, skipped: 0 });
    expect(putBook.mock.calls[0][0].coverBlob).toBeUndefined();
  });

  it("skips a book when any audiobook track is missing", async () => {
    const file = await archive(index([book({ fileKeys: ["one", "two"] })]), [payload("one")]);
    await expect(restoreBackup(file)).resolves.toEqual({ books: 0, skipped: 1 });
    expect(putBook).not.toHaveBeenCalled();
  });

  it("surfaces storage errors instead of reporting a successful partial restore", async () => {
    putFile.mockRejectedValueOnce(new Error("quota exceeded"));
    const file = await archive(index(), [payload()]);
    await expect(restoreBackup(file)).rejects.toThrow("quota exceeded");
    expect(putBook).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("invalidates an existing cover URL even when the restored book has no cover", async () => {
    await restoreBackup(await archive(index(), [payload()]));
    expect(dropCoverUrl).toHaveBeenCalledWith("book");
  });

  it.each([null, 0, -1, "1"])("rejects an invalid index version %s before writing", async (v) => {
    await expect(restoreBackup(await archive(index([], { v })))).rejects.toThrow(/Invalid backup/);
    expect(putFile).not.toHaveBeenCalled();
    expect(putBook).not.toHaveBeenCalled();
  });

  it("rejects a future version before writing", async () => {
    await expect(restoreBackup(await archive(index([], { v: 2 })))).rejects.toThrow(/newer version/);
    expect(putBook).not.toHaveBeenCalled();
  });

  it("reports a null index as an invalid backup", async () => {
    await expect(restoreBackup(await archive(null))).rejects.toThrow(/Invalid backup/);
  });
});
