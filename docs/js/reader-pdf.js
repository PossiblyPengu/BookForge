/**
 * reader-pdf.js — PDF renderer on pdf.js.
 * Pages are canvases in a horizontal scroll-snap strip; rendered lazily
 * when near the viewport and released when far away (iOS memory).
 */

import { debounce } from "./util.js";

let pdfjsLib = null;
const loadPdfjs = async () => {
  if (!pdfjsLib) {
    pdfjsLib = await import("../vendor/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
  }
  return pdfjsLib;
};

const KEEP = 3; // pages rendered either side of view

export const openPdfReader = async (stage, book, { updateProgressUI, saveProgress }) => {
  const pdfjs = await loadPdfjs();
  const fileBlob = await (await import("./db.js")).getFile(book.fileKey);
  const doc = await pdfjs.getDocument({
    data: await fileBlob.arrayBuffer(),
    cMapUrl: "./vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "./vendor/pdfjs/standard_fonts/",
  }).promise;

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
      current = Math.min(Math.max(idx, 0), total - 1);
      renderAround(current);
      updateProgressUI((current + 1) / total, `Page ${current + 1} of ${total}`);
      saveProgress();
    }
  }, 150);
  strip.addEventListener("scroll", onScroll, { passive: true });

  // Build page shells for layout, then jump to the saved page
  for (let i = 0; i < total; i++) pageForIndex(i);
  requestAnimationFrame(() => setCurrent(current));

  return {
    getProgress: () => ({ fraction: (current + 1) / total, page: current + 1 }),
    seekFraction: (f) => setCurrent(Math.round(f * (total - 1)), { smooth: true }),
    bookmark: () => ({ page: current + 1 }),
    gotoBookmark: (t) => setCurrent((t.page || 1) - 1, { smooth: true }),
    turn: (dir) => setCurrent(current + (dir === "next" ? 1 : -1), { smooth: true }),
    async *textBlocks() {
      const pageIndex = current; // pin the page: scrolling must not retarget mid-read
      const page = await doc.getPage(pageIndex + 1);
      const tc = await page.getTextContent();
      let items = [];
      let text = "";
      // NB: the buffers have to be cleared on *every* flush, not only the
      // empty ones — leaving them meant each block repeated the whole page
      // read so far, and the 240-char cap then fired on every item.
      const flush = () => {
        const t = text.trim();
        const block = t && items.length ? { items, text: t, pageIndex } : null;
        items = []; text = "";
        return block;
      };
      for (const item of tc.items) {
        if (!item.str.trim()) { if (item.hasEOL) { const b = flush(); if (b) yield b; } continue; }
        items.push(item);
        text += item.str + (item.hasEOL ? "\n" : " ");
        if (item.hasEOL || text.length > 240) { const b = flush(); if (b) yield b; }
      }
      const b = flush();
      if (b) yield b;
    },
    highlight: (block) => {
      for (const q of pages) if (q?.hl) q.hl.textContent = "";
      const p = pages[block?.pageIndex];
      if (!p || !block?.items?.length || !p.viewport) return;
      // canvas is letterboxed inside .pdf-page — offset layer onto the canvas box
      const scale = p.canvas.clientWidth / p.viewport.width || 1;
      p.hl.style.left = `${p.canvas.offsetLeft}px`;
      p.hl.style.top = `${p.canvas.offsetTop}px`;
      p.hl.style.width = `${p.canvas.clientWidth}px`;
      p.hl.style.height = `${p.canvas.clientHeight}px`;
      for (const item of block.items) {
        const tx = pdfjs.Util.transform(p.viewport.transform, item.transform);
        const fontH = Math.hypot(tx[2], tx[3]);
        const d = document.createElement("div");
        d.className = "tts-hl";
        d.style.left = `${tx[4] * scale}px`;
        d.style.top = `${(tx[5] - fontH) * scale}px`;
        d.style.width = `${Math.max(item.width * p.viewport.scale * scale, 2)}px`;
        d.style.height = `${fontH * scale}px`;
        p.hl.appendChild(d);
      }
    },
    clearHighlight: () => {
      for (const p of pages) if (p?.hl) p.hl.textContent = "";
    },
    advance: () => {
      if (current >= total - 1) return false;
      setCurrent(current + 1, { smooth: true });
      return true;
    },
    destroy: () => { strip.remove(); doc.destroy(); },
  };
};
