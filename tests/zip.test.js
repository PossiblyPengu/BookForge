import { describe, it, expect } from "vitest";
import { writeZip, readZip, crc32, crc32Bytes } from "../docs/js/zip.js";
import { zipSync, unzipSync, inflateSync, strToU8, strFromU8 } from "../docs/vendor/fflate.mjs";

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const text = async (blob) => new TextDecoder().decode(await bytesOf(blob));

// pseudo-random binary, so a test would notice bytes shifted or dropped
const noise = (n, seed = 1) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
};

const sample = () => [
  { name: "data.json", blob: new Blob([JSON.stringify({ v: 1, books: [] })]) },
  { name: "files/file%3Aabc", blob: new Blob([noise(70000, 7)]) },
  { name: "covers/über-ümlaut.jpg", blob: new Blob([noise(1234, 3)]) },
  { name: "files/empty", blob: new Blob([]) },
];

describe("crc32", () => {
  it("matches the standard check value", async () => {
    // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926
    expect(crc32Bytes(strToU8("123456789"))).toBe(0xcbf43926);
    expect(await crc32(new Blob(["123456789"]))).toBe(0xcbf43926);
  });

  it("gives the same answer across chunk boundaries", async () => {
    const data = noise(9 * 1024 * 1024 + 17, 11); // spans several 4 MiB reads
    expect(await crc32(new Blob([data]))).toBe(crc32Bytes(data));
  });
});

describe("writeZip / readZip", () => {
  it("round-trips names, sizes and bytes", async () => {
    const entries = sample();
    const zip = await writeZip(entries);
    const read = await readZip(zip);
    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (const [i, e] of read.entries()) {
      const want = await bytesOf(entries[i].blob);
      expect(e.size).toBe(want.length);
      expect(e.crc).toBe(crc32Bytes(want));
      expect(await bytesOf(await e.blob())).toEqual(want);
    }
  });

  it("stores rather than copies: the archive is the sum of its parts", async () => {
    const entries = sample();
    const payload = entries.reduce((n, e) => n + e.blob.size, 0);
    const zip = await writeZip(entries);
    // headers only on top of the payload — no compression, no duplication
    expect(zip.size - payload).toBeLessThan(600);
  });

  it("is readable by an independent implementation (fflate)", async () => {
    const entries = sample();
    const files = unzipSync(await bytesOf(await writeZip(entries)));
    for (const e of entries) expect(files[e.name]).toEqual(await bytesOf(e.blob));
  });

  it("reads archives written by fflate — the old backup format, deflated", async () => {
    const payload = noise(50000, 5);
    const old = zipSync({
      "data.json": strToU8('{"v":1}'),
      "files/a": payload,
    }, { level: 4 });
    const read = await readZip(new Blob([old]), { inflate: inflateSync });
    const byName = Object.fromEntries(read.map((e) => [e.name, e]));
    expect(await text(await byName["data.json"].blob())).toBe('{"v":1}');
    expect(await bytesOf(await byName["files/a"].blob())).toEqual(payload);
  });

  it("refuses a deflated entry when no inflater is supplied", async () => {
    const old = zipSync({ "a.txt": strToU8("x".repeat(500)) }, { level: 6 });
    const [entry] = await readZip(new Blob([old]));
    await expect(entry.blob()).rejects.toThrow(/compression/);
  });

  it("reports progress up to the total", async () => {
    const seen = [];
    await writeZip(sample(), { onProgress: (p) => seen.push(p) });
    const last = seen.at(-1);
    expect(last.done).toBe(last.total);
  });
});

// A 4 GiB Blob isn't practical in a test, so drop the ZIP64 threshold and
// check every overflow path — per-entry sizes, offsets, and the end records.
describe("ZIP64", () => {
  it("round-trips when sizes and offsets overflow", async () => {
    const entries = sample();
    const zip = await writeZip(entries, { limit: 10 });
    const read = await readZip(zip);
    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (const [i, e] of read.entries())
      expect(await bytesOf(await e.blob())).toEqual(await bytesOf(entries[i].blob));
  });

  it("forces ZIP64 end records past 65535 entries' worth of threshold", async () => {
    // limit below the directory size and offset triggers the ZIP64 EOCD
    const zip = await writeZip([{ name: "a", blob: new Blob(["hello"]) }], { limit: 1 });
    const bytes = await bytesOf(zip);
    const has = (sig) => {
      for (let i = 0; i + 4 <= bytes.length; i++)
        if (new DataView(bytes.buffer).getUint32(i, true) === sig) return true;
      return false;
    };
    expect(has(0x06064b50)).toBe(true); // ZIP64 end of central directory
    expect(has(0x07064b50)).toBe(true); // ZIP64 locator
    const [e] = await readZip(zip);
    expect(await text(await e.blob())).toBe("hello");
  });
});

describe("damaged input", () => {
  it("says so plainly for something that isn't a zip", async () => {
    await expect(readZip(new Blob(["definitely not a zip file"]))).rejects.toThrow(/Not a zip/);
  });

  it("rejects a truncated archive rather than returning partial data", async () => {
    const zip = await writeZip(sample());
    const cut = zip.slice(0, zip.size - 30); // loses the end record
    await expect(readZip(cut)).rejects.toThrow();
  });

  it("names round-trip as UTF-8 through fflate too", async () => {
    const zip = await writeZip([{ name: "Café/Ωmega.txt", blob: new Blob(["ok"]) }]);
    const files = unzipSync(await bytesOf(zip));
    expect(Object.keys(files)).toEqual(["Café/Ωmega.txt"]);
    expect(strFromU8(files["Café/Ωmega.txt"])).toBe("ok");
  });
});
