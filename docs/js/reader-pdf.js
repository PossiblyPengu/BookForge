/**
 * reader-pdf.js — PDF renderer on pdf.js.
 * Pages are canvases in a horizontal scroll-snap strip; rendered lazily
 * when near the viewport and released when far away (iOS memory).
 */

import { debounce, findText, findAllText, excerptAround } from "./util.js";

let pdfjsLib = null;
const loadPdfjs = async () => {
  if (!pdfjsLib) {
    pdfjsLib = await import("../vendor/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
  }
  return pdfjsLib;
};

const KEEP = 3; // pages rendered either side of view

// ---------- text layer → speech blocks ----------

const SENT_END = /[.!?…:]["'”’)\]]*$/;
// a line that is nothing but a page number ("12", "xiv", "Page 3 of 90")
const PAGE_NO = /^(?:page\s*)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

const lineText = (l) => l.parts.map((p) => p.sep + p.s).join("");

/**
 * Group pdf.js text items into paragraph blocks.
 *
 * pdf.js hands back one item per text run, with hasEOL at line ends.
 * Speaking each line on its own chops sentences at every line break, so
 * lines are rejoined into paragraphs — split on vertical gaps, font-size
 * changes and short sentence-final lines — with end-of-line hyphenation
 * undone. Bare page numbers at the head/foot of the page are dropped.
 *
 * Returns [{ text, spans: [{ item, start, end }] }]; spans map each item to
 * its characters in `text`, for highlighting the words being read.
 * `top`/`bottom` are the page's y bounds in PDF units (y grows upwards).
 */
export const pdfBlocks = (items, { top = Infinity, bottom = -Infinity } = {}) => {
  const lines = [];
  let line = null;
  let gapSpace = false; // a whitespace-only item sat between two runs
  const endLine = () => { if (line?.parts.length) lines.push(line); line = null; gapSpace = false; };
  for (const it of items) {
    if (typeof it.str !== "string") continue; // marked-content markers
    const str = it.str;
    if (!str.trim()) {
      gapSpace = true;
      if (it.hasEOL) endLine();
      continue;
    }
    const [, , c, d, x, y] = it.transform || [1, 0, 0, 1, 0, 0];
    const h = Math.hypot(c, d) || it.height || 10;
    // a jump in baseline without an EOL flag is still a new line
    if (line && Math.abs(y - line.y) > h * 0.5) endLine();
    if (!line) line = { parts: [], y, h, x0: x, x1: x };
    const prev = line.parts[line.parts.length - 1];
    const sep = prev && !/\s$/.test(prev.s) && !/^\s/.test(str) &&
      (gapSpace || x - line.x1 > h * 0.15) ? " " : "";
    line.parts.push({ item: it, s: str, sep });
    line.h = Math.max(line.h, h);
    line.x1 = x + (it.width || 0);
    gapSpace = false;
    if (it.hasEOL) endLine();
  }
  endLine();

  const margin = Number.isFinite(top - bottom) ? (top - bottom) * 0.08 : 0;
  const body = lines.filter((l) => {
    const edge = l.y > top - margin || l.y < bottom + margin;
    return !(edge && PAGE_NO.test(lineText(l).trim()));
  });
  const right = Math.max(...body.map((l) => l.x1));
  const left = Math.min(...body.map((l) => l.x0));

  const paras = [];
  let cur = null;
  for (const l of body) {
    const prev = cur?.[cur.length - 1];
    let brk = !prev;
    if (prev) {
      const drop = prev.y - l.y;
      const lh = Math.max(prev.h, l.h);
      brk =
        drop > lh * 1.7 || drop < -lh * 0.5 ||             // gap, or a new column
        Math.abs(l.h - prev.h) > prev.h * 0.2 ||           // heading ↔ body
        (SENT_END.test(lineText(prev).trim()) &&
          (prev.x1 < right - lh * 2 || l.x0 > left + lh)); // short last line / indent
    }
    if (brk) paras.push((cur = []));
    cur.push(l);
  }

  return paras.map((ls) => {
    let text = "";
    const spans = [];
    ls.forEach((l, li) => {
      if (li) {
        // "infor-" + "mation" → "information"; any other line break is a space
        if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.parts[0].s)) {
          text = text.slice(0, -1);
          const last = spans[spans.length - 1];
          last.end = Math.min(last.end, text.length);
        } else if (!/\s$/.test(text)) text += " ";
      }
      for (const p of l.parts) {
        text += p.sep;
        const start = text.length;
        text += p.s;
        spans.push({ item: p.item, start, end: text.length });
      }
    });
    return { text, spans };
  }).filter((b) => b.text.trim().length > 1);
};

export const openPdfReader = async (stage, book, { updateProgressUI, saveProgress, userMoved = () => {} }) => {
  const pdfjs = await loadPdfjs();
  const fileBlob = await (await import("./db.js")).getFile(book.fileKey);
  const task = pdfjs.getDocument({
    data: await fileBlob.arrayBuffer(),
    cMapUrl: "./vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "./vendor/pdfjs/standard_fonts/",
  });
  const doc = await task.promise;

  const strip = document.createElement("div");
  strip.className = "pdf-reader";
  stage.appendChild(strip);

  const total = doc.numPages;
  const pages = []; // {div, canvas, rendered, page}

  const clearPage = (p) => {
    if (p.rendered && p.canvas) {
      p.canvas.width = 0;
      p.canvas.height = 0;
      p.rendered = false;
    }
  };

  const renderPage = async (p) => {
    if (p.rendered || p.rendering) return;
    p.rendering = true;
    try {
      const page = await doc.getPage(p.index + 1);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(
        (strip.clientWidth - 16) / base.width,
        (strip.clientHeight - 120) / base.height
      ) * (window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: Math.max(fit, 0.4) });
      p.viewport = vp;
      p.canvas.width = vp.width;
      p.canvas.height = vp.height;
      await page.render({ canvasContext: p.canvas.getContext("2d"), viewport: vp }).promise;
      p.rendered = true;
    } finally {
      p.rendering = false;
    }
  };

  let current = Math.min(Math.max((book.progress?.page || 1) - 1, 0), total - 1);

  const pageForIndex = (i) => {
    if (!pages[i]) {
      const div = document.createElement("div");
      div.className = "pdf-page";
      const canvas = document.createElement("canvas");
      div.appendChild(canvas);
      const hl = document.createElement("div");
      hl.className = "pdf-hl-layer";
      div.appendChild(hl);
      strip.appendChild(div);
      pages[i] = { div, canvas, hl, index: i, rendered: false, rendering: false, viewport: null };
    }
    return pages[i];
  };

  const renderAround = (idx) => {
    for (let i = 0; i < total; i++) {
      const near = Math.abs(i - idx) <= KEEP;
      if (near) renderPage(pageForIndex(i));
      else if (pages[i]) clearPage(pages[i]);
    }
  };

  // --- zoom: double-tap toggles fit↔2.5×; while zoomed, drag pans ---
  let zoom = 1, zx = 0, zy = 0, lastTap = { t: 0, x: 0, y: 0 }, panned = false;
  const pageDiv = () => pages[current]?.div;
  const applyZoom = () => {
    const div = pageDiv();
    if (!div) return;
    div.style.transform = zoom === 1 ? "" : `translate(${zx}px, ${zy}px) scale(${zoom})`;
    strip.style.overflowX = zoom > 1 ? "hidden" : "";
    strip.style.touchAction = zoom > 1 ? "none" : "pan-x";
  };
  const resetZoom = () => { zoom = 1; zx = 0; zy = 0; applyZoom(); };
  strip.addEventListener("pointerup", (e) => {
    pan = null;
    if (panned) { panned = false; lastTap.t = 0; return; }
    const now = Date.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      const div = pageDiv();
      if (div) {
        const r = div.getBoundingClientRect();
        div.style.transformOrigin = `${e.clientX - r.left}px ${e.clientY - r.top}px`;
        zoom = zoom > 1 ? 1 : 2.5;
        zx = zy = 0;
        applyZoom();
      }
      lastTap.t = 0;
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  });
  let pan = null;
  strip.addEventListener("pointerdown", (e) => {
    if (zoom <= 1) return;
    pan = { x: e.clientX - zx, y: e.clientY - zy };
    strip.setPointerCapture?.(e.pointerId);
  });
  strip.addEventListener("pointermove", (e) => {
    if (!pan || zoom <= 1) return;
    const div = pageDiv();
    if (!div) return;
    const mx = ((zoom - 1) * div.offsetWidth) / 2;
    const my = ((zoom - 1) * div.offsetHeight) / 2;
    zx = Math.min(mx, Math.max(-mx, e.clientX - pan.x));
    zy = Math.min(my, Math.max(-my, e.clientY - pan.y));
    panned = true;
    applyZoom();
  });
  const endPan = () => { pan = null; };
  strip.addEventListener("pointercancel", endPan);

  const setCurrent = (idx, { smooth = false } = {}) => {
    resetZoom();
    current = Math.min(Math.max(idx, 0), total - 1);
    renderAround(current);
    pageForIndex(current).div.scrollIntoView({ inline: "start", behavior: smooth ? "smooth" : "auto", block: "nearest" });
    updateProgressUI((current + 1) / total, `Page ${current + 1} of ${total}`);
    saveProgress();
  };

  // Track current page from scroll position
  const onScroll = debounce(() => {
    const w = strip.clientWidth;
    if (!w) return;
    const idx = Math.round(strip.scrollLeft / w);
    if (idx !== current) {
      userMoved(); // setCurrent() updates current first, so this was a swipe
      current = Math.min(Math.max(idx, 0), total - 1);
      renderAround(current);
      updateProgressUI((current + 1) / total, `Page ${current + 1} of ${total}`);
      saveProgress();
    }
  }, 150);
  strip.addEventListener("scroll", onScroll, { passive: true });

  // A page's canvas is sized from the strip when it renders, and renderPage()
  // skips anything already rendered — so rotating the device left every
  // visible page stuck at the old scale. Throw the bitmaps away and redraw.
  const onResize = debounce(() => {
    if (!strip.isConnected || !strip.clientWidth) return;
    for (const p of pages) if (p) clearPage(p);
    setCurrent(current);
  }, 200);
  window.addEventListener("resize", onResize);

  // Build page shells for layout, then jump to the saved page
  for (let i = 0; i < total; i++) pageForIndex(i);
  requestAnimationFrame(() => setCurrent(current));

  return {
    getProgress: () => ({ fraction: (current + 1) / total, page: current + 1 }),
    seekFraction: (f) => setCurrent(Math.round(f * (total - 1)), { smooth: true }),
    bookmark: () => ({ page: current + 1 }),
    gotoBookmark: (t) => setCurrent((t.page || 1) - 1, { smooth: true }),
    turn: (dir) => setCurrent(current + (dir === "next" ? 1 : -1), { smooth: true }),
    // Text extraction is the slow part (one worker round-trip per page), so
    // results stream out page by page and the caller can stop iterating.
    async *search(query) {
      let found = 0;
      for (let i = 0; i < total; i++) {
        const page = await doc.getPage(i + 1);
        const tc = await page.getTextContent();
        const text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("");
        const hits = findAllText(text, query, 8);
        if (hits.length) {
          found += hits.length;
          yield {
            label: `Page ${i + 1}`,
            items: hits.map((h) => ({
              excerpt: excerptAround(text, h.start, h.end),
              target: { page: i + 1 },
            })),
          };
        }
        yield { progress: (i + 1) / total, found };
      }
    },
    goToSearch: (t) => setCurrent((t.page || 1) - 1, { smooth: true }),
    async *textBlocks() {
      const pageIndex = current; // pin the page: scrolling must not retarget mid-read
      const page = await doc.getPage(pageIndex + 1);
      const tc = await page.getTextContent();
      const [, y0, , y1] = page.view;
      for (const b of pdfBlocks(tc.items, { top: y1, bottom: y0 })) yield { ...b, pageIndex };
    },
    highlight: (block, chunkText, searchFrom = 0) => {
      for (const q of pages) if (q?.hl) q.hl.textContent = "";
      const p = pages[block?.pageIndex];
      if (!p || !block?.spans?.length || !p.viewport) return null;
      // light only the part of each run inside the chunk (or word) being read
      const hit = findText(block.text, chunkText, searchFrom);
      const from = hit?.start ?? 0;
      const to = hit?.end ?? block.text.length;
      // canvas is letterboxed inside .pdf-page — offset layer onto the canvas box
      const scale = p.canvas.clientWidth / p.viewport.width || 1;
      p.hl.style.left = `${p.canvas.offsetLeft}px`;
      p.hl.style.top = `${p.canvas.offsetTop}px`;
      p.hl.style.width = `${p.canvas.clientWidth}px`;
      p.hl.style.height = `${p.canvas.clientHeight}px`;
      for (const { item, start, end } of block.spans) {
        if (end <= from || start >= to) continue;
        const len = Math.max(end - start, 1);
        const a = (Math.max(from, start) - start) / len;
        const z = (Math.min(to, end) - start) / len;
        const tx = pdfjs.Util.transform(p.viewport.transform, item.transform);
        const fontH = Math.hypot(tx[2], tx[3]);
        const w = item.width * p.viewport.scale;
        const d = document.createElement("div");
        d.className = "tts-hl";
        d.style.left = `${(tx[4] + w * a) * scale}px`;
        d.style.top = `${(tx[5] - fontH) * scale}px`;
        d.style.width = `${Math.max(w * (z - a) * scale, 2)}px`;
        d.style.height = `${fontH * scale}px`;
        p.hl.appendChild(d);
      }
      return hit;
    },
    clearHighlight: () => {
      for (const p of pages) if (p?.hl) p.hl.textContent = "";
    },
    advance: () => {
      if (current >= total - 1) return false;
      setCurrent(current + 1, { smooth: true });
      return true;
    },
    // the loading task owns teardown (worker + document) in current pdf.js;
    // PDFDocumentProxy.destroy() is gone, and calling it threw on close
    destroy: () => {
      window.removeEventListener("resize", onResize);
      strip.remove();
      task.destroy();
    },
  };
};
