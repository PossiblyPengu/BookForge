import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("vendored PDF.js compatibility", () => {
  it.each(["pdf.min.mjs", "pdf.worker.min.mjs"])("ships the upstream legacy %s build", (file) => {
    const shipped = readFileSync(new URL(`../docs/vendor/pdfjs/${file}`, import.meta.url));
    const upstream = readFileSync(new URL(`../node_modules/pdfjs-dist/legacy/build/${file}`, import.meta.url));
    expect(shipped.equals(upstream)).toBe(true);
  });
});
