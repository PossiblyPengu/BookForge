/**
 * patch-foliate.js — fixes applied to the vendored foliate-js:
 *
 *   1. TOCProgress.getProgress(): a file whose TOC anchors don't resolve in
 *      the rendered document fell through its whole item list and answered
 *      with the LAST item in the group — a five-chapter file labelled every
 *      page "Chapter 5". With no anchor to place the range against, the
 *      fallback now interpolates the within-section fraction across the
 *      group's items (roughly right instead of pinned to the last), and
 *      when there is no previous group to inherit it answers with the
 *      group's own first item rather than nothing.
 *      (view.js: the within-section fraction is passed in for that
 *      interpolation.)
 *
 * Run by build-vendor.js; also runnable on its own:
 *   node scripts/patch-foliate.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "__ptAnchored";

const PROGRESS_FROM = `    getProgress(index, range) {
        if (!this.ids) return
        const id = this.ids[index]
        const obj = this.map.get(id)
        if (!obj) return null
        const { prev, items } = obj
        if (!items) return prev
        if (!range || items.length === 1 && !items[0].fragment) return items[0].item

        const doc = range.startContainer.getRootNode()
        for (const [i, { fragment }] of items.entries()) {
            const el = this.getFragment(doc, fragment)
            if (!el) continue
            if (range.comparePoint(el, 0) > 0)
                return (items[i - 1]?.item ?? prev)
        }
        return items[items.length - 1].item
    }`;

const PROGRESS_TO = `    getProgress(index, range, fraction = 0) {
        if (!this.ids) return
        const id = this.ids[index]
        const obj = this.map.get(id)
        if (!obj) return null
        const { prev, items } = obj
        if (!items) return prev
        if (!range || items.length === 1 && !items[0].fragment) return items[0].item

        const doc = range.startContainer.getRootNode()
        // Pageturner patch (scripts/patch-foliate.js, ${MARK}): when no
        // anchor resolves, position the label by how far through the section
        // the page sits instead of answering with the group's LAST item —
        // dead anchors used to label every page with the file's final
        // chapter ("Chapter 5" throughout a five-chapter file). And when the
        // range sits before the first anchor with no previous group to
        // inherit, the group's own first item is better than nothing.
        let ${MARK} = false
        for (const [i, { fragment }] of items.entries()) {
            const el = this.getFragment(doc, fragment)
            if (!el) continue
            ${MARK} = true
            if (range.comparePoint(el, 0) > 0)
                return (items[i - 1]?.item ?? prev ?? items[0].item)
        }
        return ${MARK}
            ? items[items.length - 1].item
            : items[Math.min(items.length - 1, Math.max(0,
                Math.round((Number.isFinite(fraction) ? fraction : 0) * (items.length - 1))))].item
    }`;

const VIEW_FROM = "        const tocItem = this.#tocProgress?.getProgress(index, range)\n";
const VIEW_TO = "        const tocItem = this.#tocProgress?.getProgress(index, range, fraction)\n";

const PATCHES = [
  {
    file: "progress.js",
    mark: MARK,
    apply: (s, file) => {
      const a = s.indexOf(PROGRESS_FROM);
      if (a < 0)
        throw new Error(`patch-foliate: getProgress not found in ${file} — upstream changed?`);
      return s.slice(0, a) + PROGRESS_TO + s.slice(a + PROGRESS_FROM.length);
    },
  },
  {
    file: "view.js",
    mark: "getProgress(index, range, fraction)",
    apply: (s, file) => {
      const a = s.indexOf(VIEW_FROM);
      if (a < 0)
        throw new Error(`patch-foliate: relocate tocItem call not found in ${file} — upstream changed?`);
      return s.slice(0, a) + VIEW_TO + s.slice(a + VIEW_FROM.length);
    },
  },
];

export const patchFoliate = (dir) => {
  const applied = [];
  for (const p of PATCHES) {
    const file = path.join(dir, p.file);
    let s = fs.readFileSync(file, "utf8");
    if (s.includes(p.mark)) continue;
    s = p.apply(s, file);
    fs.writeFileSync(file, s);
    applied.push(`${p.file}: toc fallback`);
  }
  return applied;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = fileURLToPath(new URL("../docs/vendor/foliate", import.meta.url));
  const applied = patchFoliate(dir);
  console.log(applied.length ? `patched: ${applied.join(", ")}` : "already patched", dir);
}
