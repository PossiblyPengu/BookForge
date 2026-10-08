import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchFoliate } from "../scripts/patch-foliate.js";
import { TOCProgress } from "../docs/vendor/foliate/progress.js";

const root = path.resolve(import.meta.dirname, "..");
const vendoredDir = path.join(root, "docs/vendor/foliate");
const upstreamDir = path.join(root, "node_modules/foliate-js");
const vendored = path.join(vendoredDir, "progress.js");
const upstream = path.join(upstreamDir, "progress.js");

describe("patch-foliate", () => {
  it("is applied to the vendored copy", () => {
    expect(fs.readFileSync(vendored, "utf8")).toContain("__ptAnchored");
  });

  it.skipIf(!fs.existsSync(upstream))(
    "reproduces the vendored files from upstream, once", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foliate-"));
      try {
        for (const f of ["progress.js", "view.js"])
          fs.copyFileSync(path.join(upstreamDir, f), path.join(dir, f));
        expect(patchFoliate(dir)).toHaveLength(2);
        expect(patchFoliate(dir)).toEqual([]); // idempotent
        for (const f of ["progress.js", "view.js"])
          expect(fs.readFileSync(path.join(dir, f), "utf8"), f)
            .toBe(fs.readFileSync(path.join(vendoredDir, f), "utf8"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
});

// TOCProgress maps the visible range to a TOC item. ids are section ids,
// splitHref splits "path#fragment", getFragment resolves the fragment to an
// element in the rendered doc — the same hooks the epub loader provides.
const tocProgress = async (toc, { ids = ["a.xhtml"], getFragment = () => null } = {}) => {
  const tp = new TOCProgress();
  await tp.init({ toc, ids, splitHref: async (h) => h.split("#"), getFragment });
  return tp;
};

// A stand-in for the paginator's visible range: comparePoint answers how the
// anchor element sits against the page — -1 above it, 0 inside, +1 below.
const rangeTo = (comparePoint) => ({
  startContainer: { getRootNode: () => ({}) },
  comparePoint,
});

describe("TOCProgress.getProgress", () => {
  const five = () => [1, 2, 3, 4, 5]
    .map((n) => ({ label: `Chapter ${n}`, href: `a.xhtml#c${n}` }));

  it("interpolates the label by page position when anchors are dead", async () => {
    // The reported bug: a file packing several chapters whose TOC anchors
    // don't resolve used to answer with the group's LAST item — every page
    // in chapter one read "Chapter 5". Now the within-section fraction picks
    // the item — the top of the file is Chapter 1, the end is Chapter 5.
    const tp = await tocProgress(five());
    expect(tp.getProgress(0, rangeTo(() => 1), 0)?.label).toBe("Chapter 1");
    expect(tp.getProgress(0, rangeTo(() => 1), 0.5)?.label).toBe("Chapter 3");
    expect(tp.getProgress(0, rangeTo(() => 1), 1)?.label).toBe("Chapter 5");
  });

  it("still tracks position when anchors do resolve", async () => {
    const els = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`c${n}`, {}]));
    const tp = await tocProgress(five(), { getFragment: (doc, f) => els[f] });
    // c1 and c2 above the page, c3 below → we're inside chapter 2
    const range = rangeTo((el) => (el === els.c1 || el === els.c2 ? -1 : 1));
    expect(tp.getProgress(0, range)?.label).toBe("Chapter 2");
    // every anchor above → the file's last chapter is what's on screen
    expect(tp.getProgress(0, rangeTo(() => -1))?.label).toBe("Chapter 5");
  });

  it("returns the previous item above a chapter's first anchor", async () => {
    const tp = await tocProgress(
      [
        { label: "Dedication", href: "a.xhtml" },
        { label: "Chapter 1", href: "b.xhtml#c1" },
      ],
      { ids: ["a.xhtml", "b.xhtml"], getFragment: (doc, f) => (f === "c1" ? {} : null) },
    );
    // the c1 anchor sits below the visible range — the page top is still the
    // previous entry's tail matter
    expect(tp.getProgress(1, rangeTo(() => 1))?.label).toBe("Dedication");
  });

  it("answers with its own first item when nothing precedes the group", async () => {
    const tp = await tocProgress(five(), { getFragment: (doc, f) => (f === "c1" ? {} : null) });
    // before the very first anchor, with no previous entry — upstream
    // answered `undefined` here, showing the bare book title
    expect(tp.getProgress(0, rangeTo(() => 1))?.label).toBe("Chapter 1");
  });
});
