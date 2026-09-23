/**
 * tts-foliate.js — read-aloud adapter for a <foliate-view>.
 *
 * Gives the TTS controller what it needs from an EPUB/MOBI/FB2 view:
 *   beginTts()      forget what a previous session spoke
 *   textBlocks()    blocks of the loaded section, from the page on screen
 *   advance()       move to the next section
 *   highlight()     mark the sentence/word being read, turning the page
 *                   when it leaves the screen
 *   clearHighlight()
 */

import { Overlayer } from "../vendor/foliate/overlayer.js";
import { rangeForChunk, extractBlocks, resumePoint } from "./util.js";

const HL_OPTS = { color: "#f0a040", padding: 1 };

// START_TO_END compares THIS range's end against the SOURCE range's start
// (DOM spec §compareBoundaryPoints). END_TO_START is the mirror image — it
// asks whether a block starts before the page ends, which is true of nearly
// every block on the page, and using it once made read-aloud start a page
// ahead.
const endsBefore = (range, loc) => range.compareBoundaryPoints(Range.START_TO_END, loc) < 0;
const startsBefore = (range, loc) => range.compareBoundaryPoints(Range.START_TO_START, loc) < 0;

export const foliateTts = (view) => {
  // Keyed on the section document rather than its index: fixed-layout books
  // report no index, and re-navigating to a section yields a fresh document,
  // which is exactly when it should become speakable again.
  let spokenDocs = new WeakSet();
  let fromLoc = true; // the first section starts at the visible position
  let hlOverlayer = null;

  const visibleRange = (doc) => {
    const loc = view.lastLocation?.range;
    return loc && loc.startContainer?.ownerDocument === doc ? loc : null;
  };

  // Does `range` begin inside the page on screen?
  const onPage = (range) => {
    const loc = view.lastLocation?.range;
    if (!loc || loc.startContainer?.ownerDocument !== range.startContainer?.ownerDocument) return false;
    return range.compareBoundaryPoints(Range.START_TO_START, loc) >= 0 &&
      range.compareBoundaryPoints(Range.END_TO_START, loc) < 0;
  };

  return {
    beginTts() { spokenDocs = new WeakSet(); fromLoc = true; },

    // {doc, el, text} per block of the loaded section documents. The
    // controller asks again after every advance(), so documents already
    // spoken this session are skipped — otherwise one section would repeat.
    async *textBlocks() {
      for (const { doc } of view.renderer?.getContents?.() ?? []) {
        if (!doc || spokenDocs.has(doc)) continue;
        spokenDocs.add(doc);
        let loc = fromLoc ? visibleRange(doc) : null;
        fromLoc = false;
        for (const b of extractBlocks(doc)) {
          if (loc) {
            const er = doc.createRange();
            er.selectNodeContents(b.el);
            if (endsBefore(er, loc)) continue; // above the page on screen
            // The page opens mid-paragraph: start at the sentence it opens
            // on, not the top of a paragraph mostly on the page before.
            if (startsBefore(er, loc)) {
              const at = resumePoint(b.el, b.text, (r) => endsBefore(r, loc));
              if (!at) continue;
              loc = null;
              yield { ...b, ...at };
              continue;
            }
            loc = null; // this block and everything after is on or past the page
          }
          yield b;
        }
      }
    },

    // textBlocks() covers a whole section, so advancing steps by section —
    // view.next() turns a single page, which left the reader silently
    // flipping through the chapter it had just read.
    async advance() {
      const r = view?.renderer;
      if (!r) return false;
      const docs = () => (r.getContents?.() ?? []).map((c) => c.doc);
      const before = docs();
      const moved = () => {
        const now = docs();
        return now.length !== before.length || now.some((d, i) => d !== before[i]);
      };
      for (let tries = 0; tries < 3; tries++) {
        if (tries) await new Promise((res) => setTimeout(res, 200));
        if (r.nextSection) await r.nextSection();
        else await view.next();
        if (moved()) return true;
      }
      return false; // last section — end of book
    },

    highlight(block, chunkText, searchFrom = 0) {
      if (!block?.el || !view.renderer) return null;
      const c = (view.renderer.getContents?.() ?? []).find((c) => c.doc === block.doc);
      const overlayer = c?.overlayer;
      if (!overlayer) return null;
      hlOverlayer = overlayer;
      const found = rangeForChunk(block.el, chunkText, searchFrom);
      const range = found?.range ?? block.doc.createRange();
      if (!found) range.selectNodeContents(block.el);
      overlayer.add("tts", range, Overlayer.highlight, HL_OPTS);
      // Follow the narration. scrollToAnchor snaps to a page boundary and
      // fires relocate, so progress and the saved position keep up. Only turn
      // when the text has left the page — this runs for every word.
      try {
        if (!onPage(range)) {
          if (view.renderer.scrollToAnchor) view.renderer.scrollToAnchor(range);
          else block.el.scrollIntoView({ inline: "nearest", block: "nearest" });
        }
      } catch { /* ok */ }
      return { start: found?.start ?? searchFrom, end: found?.end ?? searchFrom };
    },

    clearHighlight() {
      try { hlOverlayer?.remove("tts"); } catch { /* ok */ }
      hlOverlayer = null;
    },
  };
};
