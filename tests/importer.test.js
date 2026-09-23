import { describe, it, expect } from "vitest";
import { zipSync } from "../docs/vendor/fflate.mjs";
import { expandZip } from "../docs/js/importer.js";

const enc = new TextEncoder();
const zipFile = (entries, name = "bundle.zip") =>
  new File([zipSync(entries)], name, { type: "application/zip" });

describe("expandZip", () => {
  it("unpacks supported files, preserving folder paths in names", async () => {
    const f = zipFile({
      "Alpha Book/ch1.mp3": new Uint8Array([1, 2, 3]),
      "Alpha Book/ch2.mp3": new Uint8Array([4, 5]),
      "notes.txt": enc.encode("hello"),
      "junk.exe": new Uint8Array([9]),
      ".DS_Store": new Uint8Array([0]),
      "empty/": new Uint8Array(0),
    });
    const out = await expandZip(f);
    const names = out.map((x) => x.name).sort();
    expect(names).toEqual(["Alpha Book/ch1.mp3", "Alpha Book/ch2.mp3", "notes.txt"]);
  });

  it("returns null for epub zips (mimetype entry present)", async () => {
    const f = zipFile({
      "mimetype": enc.encode("application/epub+zip"),
      "OEBPS/ch1.xhtml": enc.encode("<html/>"),
      "META-INF/container.xml": enc.encode("<xml/>"),
    });
    expect(await expandZip(f)).toBeNull();
  });

  it("returns null for image-only zips (cbz by another name)", async () => {
    const f = zipFile({
      "page1.jpg": new Uint8Array([1]),
      "page2.png": new Uint8Array([2]),
    });
    expect(await expandZip(f)).toBeNull();
  });

  it("returns null when nothing inside is supported", async () => {
    const f = zipFile({
      "a.exe": new Uint8Array([1]),
      "b.dll": new Uint8Array([2]),
    });
    expect(await expandZip(f)).toBeNull();
  });
});
