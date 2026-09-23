/**
 * reader.js — ebook reader host.
 *
 * Dispatches to one of three renderers:
 *   foliate-view  — EPUB, MOBI/AZW3/KFX, FB2/FBZ, CBZ
 *   pdf renderer  — pdf.js canvases in a swipeable strip
 *   text renderer — TXT/MD/HTML in a styled scroll view
 *
 * Owns the reader chrome (top bar, progress bar, appearance sheet,
 * TOC sheet, TTS bar) and persists reading position.
 */

import { $, debounce, listSheet, openSheet, toast, coverUrl } from "./util.js";
import { getFile, putBook, kvGet, kvSet } from "./db.js";
import { openTextReader } from "./reader-text.js";
import { openPdfReader } from "./reader-pdf.js";
import { cbrToCbz } from "./cbr.js";
import { Overlayer } from "../vendor/foliate/overlayer.js";
import { rangeForChunk, extractBlocks } from "./util.js";
import { ttsController, pickTtsSleep } from "./tts.js";

let view = null;          // <foliate-view> instance (ebook kind)
let activeBook = null;
let activeRenderer = null; // { getText?(): AsyncIterable<string>, getProgress(), goTo(progress), destroy() }
let onClose = () => {};

const FOLIATE_KIND = "ebook";

// ---------- appearance ----------
const readerSettings = { theme: "dark", flow: "paginated", fontSize: 100, font: "sans" };
const readerSettingsKey = "reader-settings";
let settingsLoaded = false;

const loadReaderSettings = async () => {
  if (settingsLoaded) return;
  Object.assign(readerSettings, (await kvGet(readerSettingsKey, {})));
  settingsLoaded = true;
};
const saveReaderSettings = () => kvSet(readerSettingsKey, { ...readerSettings });

const THEMES = {
  light: "html{background:#fbf8f2;color:#1d1a14}",
  sepia: "html{background:#f4ecd9;color:#3a2f1d}",
  dark: "html{background:#131311;color:#e8e4da}",
};
const FONTS = {
  sans: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`,
  serif: `Georgia,"Times New Roman",serif`,
};

const applyStyles = () => {
  const stage = $("reader-stage");
  stage.className = "reader-stage reader-theme-" + readerSettings.theme;
  const themeCss = THEMES[readerSettings.theme];
  const css = `${themeCss} body,p,div,span,li,td,blockquote{font-family:${FONTS[readerSettings.font]} !important} html{font-size:${readerSettings.fontSize}%}`;
  if (view?.renderer?.setStyles) view.renderer.setStyles(css);
  if (view?.renderer && activeRenderer?.setFlow)
    view.renderer.setAttribute("flow", readerSettings.flow);
  const textEl = stage.querySelector(".text-reader");
  if (textEl) {
    textEl.style.setProperty("--reader-font-size", `${18 * readerSettings.fontSize / 100}px`);
    textEl.style.fontFamily = FONTS[readerSettings.font];
  }
};

// ---------- progress persistence ----------
const saveProgress = debounce(async () => {
  if (!activeBook || !activeRenderer) return;
  const p = activeRenderer.getProgress?.();
  if (!p) return;
  activeBook.progress = p;
  activeBook.lastOpenedAt = Date.now();
  await putBook(activeBook);
}, 1200);

const updateProgressUI = (fraction, label) => {
  $("reader-slider").value = Math.round((fraction || 0) * 1000);
  $("reader-pct").textContent = `${Math.round((fraction || 0) * 100)}%`;
  $("reader-loc-label").textContent = label || "";
};

// ---------- foliate renderer ----------
const openFoliate = async (book, file) => {
  await import("../vendor/foliate/view.js");
  view = document.createElement("foliate-view");
  view.style.cssText = "display:block;width:100%;height:100%";
  $("reader-stage").appendChild(view);
  await view.open(file);
  await view.init({ lastLocation: book.progress?.cfi || null });
  // Read-aloud state, reset by beginTts() at the start of every session.
  // Keyed on the section document rather than its index: fixed-layout books
  // report no index, and re-navigating to a section yields a fresh document,
  // which is exactly when it should become speakable again.
  let spokenDocs = new WeakSet();
  let ttsFromLoc = true; // first pass starts at the visible position

  // Block ends entirely before the visible range begins → it sits above the
  // current page, so read-aloud should skip past it and start at the top of
  // what the reader can actually see.
  //
  // START_TO_END compares THIS range's end against the SOURCE range's start
  // (DOM spec §compareBoundaryPoints). END_TO_START is the mirror image — it
  // asks whether the block starts before the page ends, which is true of
  // nearly every block on the page, so it skipped the whole visible page and
  // started one page ahead.
  const endsBeforeLoc = (el, doc) => {
    const loc = view.lastLocation?.range;
    if (!loc || loc.startContainer?.ownerDocument !== doc) return false;
    const er = doc.createRange();
    er.selectNodeContents(el);
    return er.compareBoundaryPoints(Range.START_TO_END, loc) < 0;
  };

  const renderer = {
    view,
    getProgress: () => ({
      fraction: view.lastLocation?.fraction ?? 0,
      cfi: view.lastLocation?.cfi,
    }),
    beginTts() { spokenDocs = new WeakSet(); ttsFromLoc = true; },
    async *textBlocks() {
      // yield {doc, el, text} per block in the currently loaded section docs.
      // The controller recreates this generator after every advance(), so
      // documents already spoken this session are skipped — otherwise the
      // same section would be read on repeat forever.
      for (const { doc } of view.renderer?.getContents?.() ?? []) {
        if (!doc || spokenDocs.has(doc)) continue;
        spokenDocs.add(doc);
        const fromLoc = ttsFromLoc;
        ttsFromLoc = false;
        for (const b of extractBlocks(doc)) {
          if (fromLoc && endsBeforeLoc(b.el, doc)) continue;
          yield b;
        }
      }
    },
    // textBlocks() speaks a whole section at a time, so advancing has to step
    // by section too — view.next() turns a single page, which left the reader
    // silently flipping through the rest of the chapter it had just read.
    advance: async () => {
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
    highlight: (block, chunkText, searchFrom) => foliateHighlight(block, chunkText, searchFrom),
    clearHighlight: () => foliateClear(),
    bookmark: () => ({ cfi: view.lastLocation?.cfi }),
    gotoBookmark: (t) => view.goTo(t.cfi),
    destroy: () => { view.remove(); view = null; },
    setFlow: true,
  };

  view.addEventListener("relocate", (e) => {
    const { fraction, tocItem } = e.detail;
    updateProgressUI(fraction, tocItem?.label || "");
    saveProgress();
    syncBookmarkBtn();
  });
  // draw user annotations as soft highlights
  view.addEventListener("draw-annotation", (e) =>
    e.detail.draw(Overlayer.highlight, { color: "#e8c46a", padding: 1 }));
  // tapping an existing highlight offers removal
  view.addEventListener("show-annotation", (e) => {
    const { value } = e.detail;
    showChip("Remove highlight", e.detail.range, async () => {
      await view.deleteAnnotation({ value });
      activeBook.highlights = (activeBook.highlights || []).filter((h) => h.value !== value);
      await putBook(activeBook);
      toast("Highlight removed");
    });
  });
  view.addEventListener("load", (e) => {
    const { doc, index } = e.detail;
    if (!doc) return;
    doc.addEventListener("click", (ev) => zoneTap(ev, doc));
    wireSelection(doc, index);
    // re-apply saved highlights whenever a section (re)loads
    for (const h of activeBook?.highlights || []) view.addAnnotation(h).catch(() => {});
  });
  applyStyles();
  return renderer;
};

// ---------- TTS read-aloud highlight (foliate) ----------
let hlOverlayer = null;
const HL_OPTS = { color: "#f0a040", padding: 1 };

const foliateHighlight = (block, chunkText, searchFrom = 0) => {
  if (!block?.el || !view) return null;
  const c = (view.renderer.getContents?.() ?? []).find((c) => c.doc === block.doc);
  const overlayer = c?.overlayer;
  if (!overlayer) return null;
  hlOverlayer = overlayer;

  const found = rangeForChunk(block.el, chunkText, searchFrom);
  const range = found?.range ?? block.doc.createRange();
  if (!found) range.selectNodeContents(block.el);
  overlayer.add("tts", range, Overlayer.highlight, HL_OPTS);
  // Follow the narration. scrollToAnchor snaps to a page boundary and fires
  // relocate, so the progress bar and the saved position keep up; a raw
  // scrollIntoView leaves the paginator's idea of the location behind.
  try {
    if (view.renderer?.scrollToAnchor) view.renderer.scrollToAnchor(range);
    else block.el.scrollIntoView({ inline: "nearest", block: "nearest" });
  } catch { /* ok */ }
  return { start: found?.start ?? searchFrom, end: found?.end ?? searchFrom };
};

const foliateClear = () => { try { hlOverlayer?.remove("tts"); } catch { /* ok */ } hlOverlayer = null; };

// ---------- selection → highlight chip (foliate docs) ----------
let selChip = null;
const killChip = () => { selChip?.remove(); selChip = null; };

const showChip = (label, range, onTap) => {
  const rect = [...(range?.getClientRects?.() || [])].pop();
  killChip();
  if (!rect) return;
  const doc = range.startContainer?.ownerDocument;
  const frect = doc?.defaultView?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
  selChip = document.createElement("button");
  selChip.className = "sel-chip";
  selChip.textContent = label;
  selChip.style.left = `${frect.left + rect.left + rect.width / 2}px`;
  selChip.style.top = `${Math.max(8, frect.top + rect.top - 46)}px`;
  selChip.addEventListener("click", async () => { killChip(); await onTap(); });
  document.body.appendChild(selChip);
};

const wireSelection = (doc, index) => {
  const check = () => {
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    showChip("Highlight", range, async () => {
      const cfi = view.getCFI(index, range);
      const text = sel.toString().trim().slice(0, 300);
      activeBook.highlights = [...(activeBook.highlights || []), { value: cfi, text, at: Date.now() }];
      await putBook(activeBook);
      await view.addAnnotation({ value: cfi });
      sel.removeAllRanges();
      toast("Highlighted");
    });
  };
  doc.addEventListener("mouseup", () => setTimeout(check, 10));
  doc.addEventListener("touchend", () => setTimeout(check, 300));
};

// tap zones inside rendered book docs: left prev / center chrome / right next
const zoneTap = (ev, doc) => {
  if (ev.target.closest("a")) return;
  const sel = doc.getSelection?.();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return; // text selection in progress
  killChip();
  const w = doc.defaultView?.innerWidth || doc.documentElement.clientWidth;
  const x = ev.clientX;
  if (x < w * 0.25) turn("prev");
  else if (x > w * 0.75) turn("next");
  else toggleChrome();
};

const turn = (dir) => {
  if (view) (dir === "next" ? view.next() : view.prev());
  else if (activeRenderer?.turn) activeRenderer.turn(dir);
};

const toggleChrome = () => $("view-reader").classList.toggle("chrome-hidden");

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export const openReader = async (book, hooks = {}) => {
  onClose = hooks.onClose || (() => {});
  activeBook = book;
  book.lastOpenedAt = Date.now();
  await putBook(book);

  $("reader-title").textContent = book.title;
  $("view-reader").hidden = false;
  $("view-reader").classList.remove("chrome-hidden");
  updateProgressUI(book.progress?.fraction || 0, "");
  $("tts-bar").hidden = true;

  const stage = $("reader-stage");
  stage.textContent = "";
  stage.style.opacity = "0";

  try {
    const file = await getFile(book.fileKey);
    if (!file) throw new Error("Book file missing from storage");

    if (book.kind === FOLIATE_KIND) {
      let openFile = new File([file], book.fileName, { type: file.type });
      if (book.format === "CBR") openFile = await cbrToCbz(openFile);
      activeRenderer = await openFoliate(book, openFile);
    } else if (book.kind === "pdf") {
      activeRenderer = await openPdfReader(stage, book, { updateProgressUI, saveProgress });
    } else {
      activeRenderer = await openTextReader(stage, book, file, { updateProgressUI, saveProgress });
    }
    stage.style.opacity = "";
    $("reader-toc-btn").style.visibility = "visible"; // now lists bookmarks/highlights too
    applyStyles();
    syncBookmarkBtn();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't open book", { error: true });
    closeReader();
  }
};

export const closeReader = async () => {
  ttsController.stop();
  killChip();
  const p = activeRenderer?.getProgress?.();
  if (activeBook && p) { activeBook.progress = p; await putBook(activeBook); }
  if (activeRenderer?.destroy) activeRenderer.destroy();
  activeRenderer = null;
  activeBook = null;
  view = null;
  $("reader-stage").textContent = "";
  $("view-reader").hidden = true;
  const cb = onClose;
  onClose = () => {};
  cb();
};

// ---------------------------------------------------------------------------
// Sheets: TOC + bookmarks + appearance
// ---------------------------------------------------------------------------

/** The live renderer for the open book — used by the smoke test. */
export const currentRenderer = () => activeRenderer;

const bookmarkTarget = () => activeRenderer?.bookmark?.();
const bookmarkEquals = (a, b) => {
  if (!a || !b) return false;
  // scroll fractions are floats — compare with epsilon so toggling works
  if (a.fraction != null && b.fraction != null)
    return Math.abs(a.fraction - b.fraction) < 0.005;
  return JSON.stringify(a) === JSON.stringify(b);
};

const syncBookmarkBtn = () => {
  const cur = bookmarkTarget();
  const on = !!cur && (activeBook?.bookmarks || []).some((b) => bookmarkEquals(b.target, cur));
  $("reader-bmk-btn").classList.toggle("on", on);
};

const toggleBookmark = async () => {
  const cur = bookmarkTarget();
  if (!activeBook || !cur) return;
  const list = activeBook.bookmarks || [];
  const i = list.findIndex((b) => bookmarkEquals(b.target, cur));
  if (i >= 0) {
    list.splice(i, 1);
    toast("Bookmark removed");
  } else {
    const label = $("reader-loc-label").textContent
      || `Page ${Math.round((activeRenderer.getProgress?.().fraction || 0) * 100)}%`;
    list.push({ target: cur, label, at: Date.now() });
    toast("Bookmarked");
  }
  activeBook.bookmarks = list;
  await putBook(activeBook);
  syncBookmarkBtn();
};

const openToc = () => {
  const items = [];
  for (const [i, b] of (activeBook?.bookmarks || []).entries())
    items.push({ title: `★ ${b.label || "Bookmark"}`, sub: "Bookmark", value: { bm: i } });
  for (const [i, h] of (activeBook?.highlights || []).entries())
    items.push({ title: `✎ ${h.text || "Highlight"}`, sub: "Highlight", value: { hl: i } });
  if (view?.book?.toc) {
    const flat = [];
    const walk = (arr, depth) => {
      for (const it of arr || []) {
        flat.push({ label: it.label || it.href, href: it.href, depth });
        walk(it.subitems, depth + 1);
      }
    };
    walk(view.book.toc, 0);
    for (const it of flat)
      items.push({ title: "  ".repeat(it.depth) + (it.label || "—"), value: { href: it.href } });
  }
  if (!items.length) { toast("No contents for this book"); return; }
  listSheet("Contents", items, async (v) => {
    if (v.bm != null) {
      const b = activeBook.bookmarks[v.bm];
      if (b) activeRenderer?.gotoBookmark?.(b.target);
    } else if (v.hl != null) {
      const h = activeBook.highlights[v.hl];
      if (h && view) await view.showAnnotation(h);
    } else if (v.href) {
      view?.goTo(v.href);
    }
  }, { search: true });
};

const initAppearance = () => {
  const seg = (id, key) => {
    const el = $(id);
    const setActive = () => [...el.querySelectorAll("button")].forEach((b) =>
      b.classList.toggle("active", b.dataset.val === readerSettings[key]));
    el.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        readerSettings[key] = b.dataset.val;
        applyStyles(); saveReaderSettings(); setActive();
      }));
    setActive();
  };
  seg("reader-theme-seg", "theme");
  seg("reader-flow-seg", "flow");
  seg("reader-font-seg", "font");
  $("font-minus").addEventListener("click", () => {
    readerSettings.fontSize = Math.max(60, readerSettings.fontSize - 10);
    $("font-size-val").textContent = readerSettings.fontSize + "%";
    applyStyles(); saveReaderSettings();
  });
  $("font-plus").addEventListener("click", () => {
    readerSettings.fontSize = Math.min(250, readerSettings.fontSize + 10);
    $("font-size-val").textContent = readerSettings.fontSize + "%";
    applyStyles(); saveReaderSettings();
  });
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export const initReader = async () => {
  await loadReaderSettings();
  $("font-size-val").textContent = readerSettings.fontSize + "%";
  initAppearance();
  $("reader-close").addEventListener("click", closeReader);
  $("reader-toc-btn").addEventListener("click", openToc);
  $("reader-aa-btn").addEventListener("click", () => openSheet("sheet-appearance"));
  $("reader-slider").addEventListener("input", (e) => {
    const frac = e.target.value / 1000;
    if (view) view.goToFraction(frac);
    else activeRenderer?.seekFraction?.(frac);
  });
  // stage taps outside foliate docs (margins) toggle chrome
  $("reader-stage").addEventListener("click", (e) => {
    if (e.target === $("reader-stage")) toggleChrome();
  });
  // TTS
  $("reader-tts-btn").addEventListener("click", () => {
    const bar = $("tts-bar");
    if (bar.hidden) {
      bar.hidden = false;
      ttsController.start(() => activeRenderer, {
        title: activeBook?.title,
        author: activeBook?.author,
        cover: coverUrl(activeBook),
      });
    } else {
      ttsController.toggle();
    }
  });
  $("reader-bmk-btn").addEventListener("click", toggleBookmark);
  $("tts-play").addEventListener("click", () => ttsController.toggle());
  $("tts-prev").addEventListener("click", () => ttsController.skip(-1));
  $("tts-next").addEventListener("click", () => ttsController.skip(1));
  $("tts-sleep").addEventListener("click", pickTtsSleep);
  $("tts-stop").addEventListener("click", () => {
    ttsController.stop();
    $("tts-bar").hidden = true;
  });
  ttsController.onStateChange = (playing) => {
    $("tts-play").innerHTML = playing
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  };
};
