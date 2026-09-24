import { describe, it, expect } from "vitest";
import { detectFormat } from "../docs/js/detect.js";
import { metaMatches } from "../docs/js/metadata.js";

const makeFile = (name, bytes, type = "") => {
  const f = new File([bytes], name, { type });
  return f;
};

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]); // %PDF-1.
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(508).fill(0)]);
const FB2_HEAD = new TextEncoder().encode('<?xml version="1.0"?><FictionBook xmlns="x">');
const RAR_HEAD = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]); // Rar! v4
const RAR5_HEAD = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]); // Rar! v5

describe("detectFormat", () => {
  it("detects audio by extension", async () => {
    expect((await detectFormat(makeFile("book.m4b", new Uint8Array(10)))).kind).toBe("audio");
    expect((await detectFormat(makeFile("t.mp3", new Uint8Array(10)))).kind).toBe("audio");
  });

  it("detects pdf by magic bytes", async () => {
    const f = makeFile("noext", PDF_HEAD);
    expect((await detectFormat(f)).kind).toBe("pdf");
  });

  it("detects pdf by extension", async () => {
    expect((await detectFormat(makeFile("doc.pdf", new Uint8Array(10)))).kind).toBe("pdf");
  });

  it("detects text formats", async () => {
    expect((await detectFormat(makeFile("notes.txt", new Uint8Array(10)))).kind).toBe("text");
    expect((await detectFormat(makeFile("book.md", new Uint8Array(10)))).format).toBe("Markdown");
    expect((await detectFormat(makeFile("page.html", new Uint8Array(10)))).format).toBe("HTML");
  });

  it("detects epub/cbz/fbz by extension", async () => {
    expect((await detectFormat(makeFile("a.epub", new Uint8Array(10)))).kind).toBe("ebook");
    expect((await detectFormat(makeFile("a.cbz", new Uint8Array(10)))).format).toBe("CBZ");
    expect((await detectFormat(makeFile("a.fbz", new Uint8Array(10)))).format).toBe("FBZ");
  });

  it("detects fb2 by xml content", async () => {
    expect((await detectFormat(makeFile("book.xml", FB2_HEAD))).format).toBe("FB2");
  });

  it("detects mobi/azw3 by extension", async () => {
    expect((await detectFormat(makeFile("a.mobi", new Uint8Array(10)))).kind).toBe("ebook");
    expect((await detectFormat(makeFile("a.azw3", new Uint8Array(10)))).kind).toBe("ebook");
  });

  it("detects cbr by extension and rar magic", async () => {
    expect((await detectFormat(makeFile("a.cbr", new Uint8Array(10)))).format).toBe("CBR");
    expect((await detectFormat(makeFile("noext", RAR_HEAD))).format).toBe("CBR");
    expect((await detectFormat(makeFile("noext", RAR5_HEAD))).format).toBe("CBR");
  });

  it("detects generic zip as ebook", async () => {
    expect((await detectFormat(makeFile("weird.bin", ZIP_HEAD))).kind).toBe("ebook");
  });

  it("returns unknown for unrecognised files", async () => {
    const f = makeFile("data.xyz", new Uint8Array([1, 2, 3, 4, 5]));
    expect((await detectFormat(f)).kind).toBe("unknown");
  });

  // KFX is a DRM container foliate-js can't read. Reporting it as an ebook
  // meant the import failed with a generic "couldn't import" and no reason.
  it("flags DRM-locked Kindle formats as unsupported, with a reason", async () => {
    const d = await detectFormat(makeFile("book.kfx", new Uint8Array(80)));
    expect(d.kind).toBe("unsupported");
    expect(d.format).toBe("KFX");
    expect(d.reason).toMatch(/DRM/i);
  });

  it("still detects the Kindle formats it can open", async () => {
    for (const ext of ["mobi", "azw", "azw3"]) {
      const d = await detectFormat(makeFile(`book.${ext}`, new Uint8Array(80)));
      expect(d.kind).toBe("ebook");
    }
  });
});

describe("metaMatches", () => {
  const c = { title: "The Hobbit", author: "J.R.R. Tolkien" };
  it("matches when title and author align", () => {
    expect(metaMatches(c, { title: "The Hobbit", author: "Tolkien" })).toBe(true);
  });
  it("matches on title alone when author missing", () => {
    expect(metaMatches(c, { title: "Hobbit", author: "" })).toBe(true);
  });
  it("rejects wrong author", () => {
    expect(metaMatches(c, { title: "The Hobbit", author: "Brandon Sanderson" })).toBe(false);
  });
  it("rejects wrong title", () => {
    expect(metaMatches(c, { title: "Dune", author: "Tolkien" })).toBe(false);
  });
});
