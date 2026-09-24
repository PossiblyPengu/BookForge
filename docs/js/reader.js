/**
 * reader.js — ebook reader host.
 *
 * Dispatches to one of three renderers:
 *   foliate-view  — EPUB, MOBI/AZW3, FB2/FBZ, CBZ
 *   pdf renderer  — pdf.js canvases in a swipeable strip
 *   text renderer — TXT/MD/HTML in a styled scroll view
 *
 * Owns the reader chrome (top bar, progress bar, appearance sheet,
 * TOC sheet, TTS bar) and persists reading position.
 */

import {
  $, debounce, openSheet, closeSheet, isSheetOpen, toast, coverUrl, onPageHidden,
  copyText,
} from "./util.js";
import { getFile, putBook, kvGet, kvSet } from "./db.js";
import { openTextReader } from "./reader-text.js";
import { openPdfReader } from "./reader-pdf.js";
import { cbrToCbz } from "./cbr.js";
import { Overlayer } from "../vendor/foliate/overlayer.js";
import { FootnoteHandler } from "../vendor/foliate/footnotes.js";
import { foliateTts } from "./tts-foliate.js";
import { ttsController } from "./tts.js";
import { pickTtsSleep } from "./tts-voices.js";

let view = null;          // <foliate-view> instance (ebook kind)
let activeBook = null;
let activeRenderer = null; // { getText?(): AsyncIterable<string>, getProgress(), goTo(progress), destroy() }
let onClose = () => {};

const FOLIATE_KIND = "ebook";

// ---------- appearance ----------
const readerSettings = {
  theme: "dark", flow: "paginated", fontSize: 100,
  font: "original", spacing: "normal", margin: "normal", align: "justify",
};
const readerSettingsKey = "reader-settings";
let settingsLoaded = false;

const loadReaderSettings = async () => {
  if (settingsLoaded) return;
  Object.assign(readerSettings, (await kvGet(readerSettingsKey, {})));
  settingsLoaded = true;
};
const saveReaderSettings = () => kvSet(readerSettingsKey, { ...readerSettings });

// page colours; the chrome takes the same palette (main.css, data-reader-theme)
const THEMES = {
  light: { bg: "#fbf8f2", fg: "#1d1a14", link: "#9a5b12" },
  sepia: { bg: "#f4ecd9", fg: "#3a2f1d", link: "#8a4f10" },
  gray: { bg: "#4b4b4e", fg: "#ecebe7", link: "#f3b766" },
  dark: { bg: "#131311", fg: "#e8e4da", link: "#f0a040" },
  black: { bg: "#000000", fg: "#cfcbc2", link: "#e0973a" },
};
// null → the book's own typeface
const FONTS = {
  original: null,
  serif: `"Iowan Old Style","New York",Georgia,serif`,
  sans: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`,
  charter: `Charter,"Bitstream Charter",Georgia,serif`,
  palatino: `Palatino,"Palatino Linotype","Book Antiqua",serif`,
};
const LINE_HEIGHT = { tight: 1.3, normal: 1.5, loose: 1.8 };
const PAGE_GAP = { narrow: "4%", normal: "7%", wide: "11%" }; // paginator side margins
const TEXT_PAD = { narrow: 14, normal: 22, wide: 36 };        // text reader side padding

// Paragraphs the reader's alignment may override. Marked per section as it
// loads (book CSS has applied by then) — only those the book sets justified
// or left-aligned, so centred scene breaks, epigraphs and headings-as-<p>
// keep their own alignment.
const FLOW_CLASS = "pt-flow";
const markFlowText = (doc) => {
  for (const el of doc.querySelectorAll("p, li, blockquote, div")) {
    const a = doc.defaultView?.getComputedStyle(el).textAlign;
    if (a === "justify" || a === "left" || a === "start") el.classList.add(FLOW_CLASS);
  }
};

const bookCss = () => {
  const s = readerSettings;
  const t = THEMES[s.theme] || THEMES.dark;
  const css = [
    // --theme-bg-color is what the paginator paints around the columns;
    // without it the frame kept the colour the section loaded with
    `html{--theme-bg-color:${t.bg};background:${t.bg} !important;color:${t.fg}}`,
    `a:link,a:visited{color:${t.link}}`,
    `html{font-size:${s.fontSize}%}`,
  ];
  const font = FONTS[s.font];
  if (font) css.push(`body,p,div,span,li,td,blockquote,h1,h2,h3,h4,h5,h6{font-family:${font} !important}`);
  const lh = LINE_HEIGHT[s.spacing];
  if (lh) css.push(`p,li,blockquote,dd,div{line-height:${lh} !important}`);
  if (s.align === "justify")
    css.push(`.${FLOW_CLASS}{text-align:justify !important;-webkit-hyphens:auto;hyphens:auto}`);
  else if (s.align === "left")
    css.push(`.${FLOW_CLASS}{text-align:start !important;-webkit-hyphens:manual;hyphens:manual}`);
  return css.join("\n");
};

const themeMeta = () => document.querySelector('meta[name="theme-color"]');
let appThemeColor = null; // restored when the reader closes

const applyStyles = () => {
  const s = readerSettings;
  const t = THEMES[s.theme] || THEMES.dark;
  document.documentElement.dataset.readerTheme = s.theme in THEMES ? s.theme : "dark";
  appThemeColor ??= themeMeta()?.getAttribute("content");
  themeMeta()?.setAttribute("content", t.bg); // iOS status bar matches the page
  $("font-size-val").textContent = s.fontSize + "%";
  if (view?.renderer) {
    view.renderer.setStyles?.(bookCss());
    view.renderer.setAttribute("flow", s.flow);
    view.renderer.setAttribute("gap", PAGE_GAP[s.margin] || PAGE_GAP.normal);
  }
  const textEl = $("reader-stage").querySelector(".text-reader");
  if (textEl) {
    textEl.style.setProperty("--reader-font-size", `${18 * s.fontSize / 100}px`);
    textEl.style.fontFamily = FONTS[s.font] || "";
    textEl.style.lineHeight = LINE_HEIGHT[s.spacing] || "";
    textEl.style.textAlign = s.align === "justify" ? "justify" : s.align === "left" ? "start" : "";
    textEl.style.hyphens = textEl.style.webkitHyphens = s.align === "justify" ? "auto" : "";
    textEl.style.paddingLeft = textEl.style.paddingRight = `${TEXT_PAD[s.margin] || TEXT_PAD.normal}px`;
  }
};

const clearReaderTheme = () => {
  delete document.documentElement.dataset.readerTheme;
  if (appThemeColor != null) themeMeta()?.setAttribute("content", appThemeColor);
  appThemeColor = null;
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

let lastStatus = { chapter: "", page: "", left: "" };
// where the progress slider is being dragged to, before it's committed —
// the reader mustn't fight the thumb by writing its own position back
let sliderPreview = null;

/**
 * Where the reader is, for the bars and the quiet status line.
 * `label` is the chapter (ebooks) or "Page x of y" (PDF). `status` can give
 * the finer page / pages-left detail when the renderer knows it.
 */
const updateProgressUI = (fraction, label, status = null) => {
  const pct = `${Math.round((fraction || 0) * 100)}%`;
  if (sliderPreview == null) {
    $("reader-slider").value = Math.round((fraction || 0) * 1000);
    $("reader-pct").textContent = status?.page ? `${status.page} · ${pct}` : pct;
  }
  $("reader-loc-label").textContent = label || "";
  lastStatus = status || { chapter: "", page: label || "", left: pct };
  $("reader-chapter").textContent = lastStatus.chapter || "";
  $("reader-status-top").textContent = lastStatus.chapter || activeBook?.title || "";
  $("reader-status-page").textContent = lastStatus.page || "";
  $("reader-status-left").textContent = lastStatus.left || "";
};

// Page-in-chapter detail from the paginator (paginated) or reading time
// left (scrolled).
const foliateStatus = (detail) => {
  const chapter = detail.tocItem?.label?.trim() || "";
  const r = view?.renderer;
  const textPages = r && !r.scrolled ? r.pages - 2 : 0; // paginator pads a page each end
  if (textPages > 0) {
    const page = Math.min(Math.max(r.page, 1), textPages);
    const left = textPages - page;
    return {
      chapter,
      page: `Page ${page} of ${textPages}`,
      left: left ? `${left} page${left === 1 ? "" : "s"} left in chapter` : "Last page in chapter",
    };
  }
  const mins = Math.ceil(detail.time?.section ?? 0);
  return {
    chapter,
    page: `${Math.round((detail.fraction || 0) * 100)}%`,
    left: mins > 0 ? `${mins} min left in chapter` : "",
  };
};

// ---------- foliate renderer ----------
const openFoliate = async (book, file) => {
  await import("../vendor/foliate/view.js");
  view = document.createElement("foliate-view");
  $("reader-stage").appendChild(view);
  await view.open(file);
  // the chrome is kept clear by the view's own inset (main.css), so the
  // paginator only needs a little breathing room above and below the text
  view.renderer?.setAttribute("margin", "16px");
  // NB: every listener below has to be attached before view.init(), which
  // renders the opening section and fires its "load" synchronously. Wiring
  // them afterwards left that one section with no tap handling, no key
  // handling, no text selection and no saved highlights.
  // Comics are all images — nothing for read-aloud to find, and trying
  // would just page through the book in silence.
  const comic = book.format === "CBZ" || book.format === "CBR";

  const renderer = {
    view,
    getProgress: () => ({
      fraction: view.lastLocation?.fraction ?? 0,
      cfi: view.lastLocation?.cfi,
    }),
    ...foliateTts(view),
    bookmark: () => ({ cfi: view.lastLocation?.cfi }),
    gotoBookmark: (t) => view.goTo(t.cfi),
    // foliate scans section by section and draws its own match annotations;
    // normalise its {pre,match,post} excerpts onto the shape the other
    // renderers produce so the results list only knows one format.
    async *search(query) {
      let found = 0;
      for await (const r of view.search({ query })) {
        if (r === "done") return;
        if (r.subitems) {
          found += r.subitems.length;
          yield {
            label: (r.label || "").trim(),
            items: r.subitems.map((s) => ({
              excerpt: {
                // foliate cuts context at a fixed length, often mid-word
                before: (s.excerpt?.pre || "").replace(/^…S*s+/, "…"),
                match: s.excerpt?.match || "",
                after: (s.excerpt?.post || "").replace(/s+S*…$/, "…"),
              },
              target: { cfi: s.cfi },
            })),
          };
        } else if (r.progress != null) {
          yield { progress: r.progress, found };
        }
      }
    },
    goToSearch: (t) => view.goTo(t.cfi),
    clearSearch: () => view.clearSearch(),
    destroy: () => { view.remove(); view = null; },
    setFlow: true,
  };
  if (comic) delete renderer.textBlocks;
  // nothing to search in a book that is only page images
  if (comic) { delete renderer.search; delete renderer.goToSearch; delete renderer.clearSearch; }

  view.addEventListener("relocate", (e) => {
    const { fraction, tocItem } = e.detail;
    updateProgressUI(fraction, tocItem?.label?.trim() || "", foliateStatus(e.detail));
    saveProgress();
    syncBookmarkBtn();
  });
  // Swipe / page turn / manual scroll, as opposed to read-aloud's own
  // follow-along (reason "navigation"). The view's relocate event drops the
  // reason, so listen on the paginator itself.
  view.renderer?.addEventListener("relocate", (e) => {
    const { reason } = e.detail || {};
    if (reason === "snap" || reason === "page" || reason === "scroll") userMoved();
  });
  // user highlights are drawn warm; search hits are drawn by foliate itself,
  // restyled cool via Overlayer.outline above, so the two never look alike
  view.addEventListener("draw-annotation", (e) =>
    e.detail.draw(Overlayer.highlight, { color: "#e8c46a", padding: 1 }));
  // tapping an existing highlight offers removal
  view.addEventListener("show-annotation", (e) => {
    const { value } = e.detail;
    const saved = (activeBook?.highlights || []).find((h) => h.value === value);
    showChip([
      saved?.text && {
        label: "Copy",
        onTap: async () => {
          const ok = await copyText(quoteOf(saved.text));
          toast(ok ? "Copied" : "Couldn’t copy", { error: !ok });
        },
      },
      {
        label: "Remove",
        onTap: async () => {
          await view.deleteAnnotation({ value });
          activeBook.highlights = (activeBook.highlights || []).filter((h) => h.value !== value);
          await putBook(activeBook);
          toast("Highlight removed");
        },
      },
    ], e.detail.range);
  });
  wireLinks();
  view.addEventListener("load", (e) => {
    const { doc, index } = e.detail;
    if (!doc) return;
    markFlowText(doc);
    doc.addEventListener("click", (ev) => zoneTap(ev, doc));
    doc.addEventListener("keydown", readerKey);
    wireSelection(doc, index);
    // re-apply saved highlights whenever a section (re)loads
    for (const h of activeBook?.highlights || []) view.addAnnotation(h).catch(() => {});
  });

  // everything is listening — now render
  await view.init({ lastLocation: book.progress?.cfi || null });
  applyStyles();
  return renderer;
};

// ---------------------------------------------------------------------------
// Links: footnotes in a popover, and a way back from every other jump
// ---------------------------------------------------------------------------

// Following a footnote used to land you in the endnotes with no back button
// anywhere in the reader. Notes now open in place; anything else that jumps
// leaves a "Back" chip behind.
let jumpBack = null;

const showJumpBack = (cfi) => {
  if (!cfi) return;
  jumpBack = cfi;
  const btn = $("reader-back");
  btn.hidden = false;
};

const clearJumpBack = () => {
  jumpBack = null;
  const btn = $("reader-back");
  if (btn) btn.hidden = true;
};

/** Remember where we are, then run a jump that the reader may want undone. */
export const jumpFrom = (go) => {
  const from = view?.lastLocation?.cfi || activeRenderer?.bookmark?.()?.cfi || null;
  const r = go();
  if (from) showJumpBack(from);
  return r;
};

// foliate draws search hits itself, as Overlayer.outline with no options —
// a 3px red box around every match. Search is the only thing that uses
// outline, so restyle it here at runtime (a patch to the vendored file would
// be lost on the next `npm run vendor`).
Overlayer.outline = (rects) => Overlayer.highlight(rects, { color: "#5b9bd5", padding: 1 });

const noteHandler = new FootnoteHandler();

// The note renders into its own <foliate-view>, which the handler creates
// detached. It has to be in the document *before* the render pass or the
// paginator never gets a layout and the load event never fires — that's what
// before-render is for.
noteHandler.addEventListener("before-render", (e) => {
  const v = e.detail.view;
  const body = $("note-body");
  body.textContent = "";
  body.appendChild(v);
  $("note-kind").textContent = "Note";
  $("note-goto").hidden = true;
  openSheet("sheet-note");
  // a short fragment in a small box wants scrolling, not pagination
  v.renderer?.setAttribute?.("flow", "scrolled");
  v.renderer?.setAttribute?.("gap", "4%");
  v.renderer?.setStyles?.(bookCss());
});

noteHandler.addEventListener("render", (e) => {
  const { view: noteView, href, type } = e.detail;
  noteView.renderer?.setAttribute?.("flow", "scrolled");
  noteView.renderer?.setStyles?.(bookCss());
  $("note-kind").textContent = {
    footnote: "Footnote", endnote: "Endnote", note: "Note",
    biblioentry: "Reference", definition: "Definition",
  }[type] || "Note";
  // the popover is for reading in place; this is the escape hatch to the
  // full note, and it leaves a way back
  $("note-goto").hidden = false;
  $("note-goto").onclick = () => {
    closeSheet();
    jumpFrom(() => view?.goTo(href));
  };
});

const wireLinks = () => {
  view.addEventListener("link", (e) => {
    const { href } = e.detail;
    const handled = noteHandler.handle(view.book, e);
    if (handled) {
      // handle() already cancelled the navigation; if rendering the note
      // fails, fall back to going there rather than swallowing the tap
      handled.catch((err) => {
        console.warn("footnote render failed", err);
        jumpFrom(() => view.goTo(href));
      });
      return;
    }
    // a plain cross-reference: foliate navigates, we leave a way back
    showJumpBack(view.lastLocation?.cfi || null);
  });
  view.addEventListener("external-link", (e) => {
    // let it through to a new tab, but don't let a book navigate the app away
    e.preventDefault();
    window.open(e.detail.href, "_blank", "noopener");
  });
};

// ---------- selection → highlight chip (foliate docs) ----------
let selChip = null;
const killChip = () => { selChip?.remove(); selChip = null; };

/**
 * Float a small action bar over `range`. `actions` is [{ label, onTap }] —
 * a selection offers more than one thing to do with it, so this is a row of
 * buttons rather than the single button it started as.
 */
const showChip = (actions, range) => {
  const rect = [...(range?.getClientRects?.() || [])].pop();
  killChip();
  if (!rect) return;
  const doc = range.startContainer?.ownerDocument;
  const frect = doc?.defaultView?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
  selChip = document.createElement("div");
  selChip.className = "sel-chip";
  selChip.style.left = `${frect.left + rect.left + rect.width / 2}px`;
  selChip.style.top = `${Math.max(8, frect.top + rect.top - 46)}px`;
  for (const { label, onTap } of actions.filter(Boolean)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sel-chip-btn";
    btn.textContent = label;
    btn.addEventListener("click", async () => { killChip(); await onTap(); });
    selChip.appendChild(btn);
  }
  document.body.appendChild(selChip);
};

const wireSelection = (doc, index) => {
  const check = () => {
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    const clear = () => sel.removeAllRanges();
    showChip([
      {
        label: "Highlight",
        onTap: async () => {
          const cfi = view.getCFI(index, range);
          activeBook.highlights = [
            ...(activeBook.highlights || []),
            { value: cfi, text: text.slice(0, 300), at: Date.now() },
          ];
          await putBook(activeBook);
          await view.addAnnotation({ value: cfi });
          clear();
          toast("Highlighted");
        },
      },
      {
        label: "Copy",
        onTap: async () => {
          const ok = await copyText(quoteOf(text));
          clear();
          toast(ok ? "Copied" : "Couldn’t copy", { error: !ok });
        },
      },
      navigator.share && {
        label: "Share",
        onTap: async () => {
          try { await navigator.share({ text: quoteOf(text) }); } catch { /* cancelled */ }
          clear();
        },
      },
    ], range);
  };
  doc.addEventListener("mouseup", () => setTimeout(check, 10));
  doc.addEventListener("touchend", () => setTimeout(check, 300));
};

/** A copied passage is more use with the book it came from attached. */
const quoteOf = (text) => {
  const by = [activeBook?.title, activeBook?.author].filter(Boolean).join(" — ");
  return by ? `${text}\n\n— ${by}` : text;
};

// Touch screens turn pages by swiping (the paginator's own drag-and-snap);
// a tap only shows or hides the controls. A mouse has no swipe, so there
// the outer quarters of the page still turn it.
const touchScreen = () => globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;

const zoneTap = (ev, doc) => {
  if (ev.target.closest?.("a")) return;
  const sel = doc.getSelection?.();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return; // text selection in progress
  killChip();
  if (!touchScreen() && view) {
    // clientX is relative to the section's iframe, which lays every page of
    // the chapter side by side (thousands of px wide). Measuring against its
    // innerWidth put nearly every tap in the wrong zone — a tap meant to
    // show the controls turned the page instead. Measure against the view.
    const fr = doc.defaultView?.frameElement?.getBoundingClientRect();
    const vr = view.getBoundingClientRect();
    if (fr && vr.width) {
      const f = (fr.left + ev.clientX - vr.left) / vr.width;
      if (f < 0.25) return turn("prev");
      if (f > 0.75) return turn("next");
    }
  }
  toggleChrome();
};

// Tell read-aloud the reader navigated by hand, so a paused session picks
// up from the new page instead of dragging them back.
const userMoved = () => ttsController.noteUserMove();

const turn = (dir) => {
  userMoved();
  if (view) (dir === "next" ? view.next() : view.prev());
  else if (activeRenderer?.turn) activeRenderer.turn(dir);
};

const toggleChrome = () => $("view-reader").classList.toggle("chrome-hidden");

// ---------- keyboard ----------
// Foliate renders each section in its own iframe and doesn't forward key
// events, so this is bound to the host document *and* to every section
// document as it loads — otherwise the arrow keys die as soon as the reader
// takes focus.
const readerKey = (e) => {
  if ($("view-reader").hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target;
  const typing = target?.matches?.("input, textarea, select, [contenteditable]");

  if (e.key === "Escape") {
    if (isSheetOpen()) closeSheet();
    else if (!typing) closeReader();
    return;
  }
  if (typing || isSheetOpen()) return;

  const act = {
    ArrowRight: () => turn("next"),
    ArrowDown: () => turn("next"),
    PageDown: () => turn("next"),
    ArrowLeft: () => turn("prev"),
    ArrowUp: () => turn("prev"),
    PageUp: () => turn("prev"),
    " ": () => turn("next"),
    f: () => openContents("search"),
    "/": () => openContents("search"),
    t: () => openContents("toc"),
    c: () => openContents("toc"),
    b: () => toggleBookmark(),
    "+": () => stepFontSize(10),
    "=": () => stepFontSize(10),
    "-": () => stepFontSize(-10),
  }[e.key];
  if (!act) return;
  // let the space bar and +/- reach a focused control rather than hijacking it
  if (target?.closest?.("button, a, [role=button]")) return;
  e.preventDefault();
  act();
};

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export const openReader = async (book, hooks = {}) => {
  onClose = hooks.onClose || (() => {});
  activeBook = book;
  book.lastOpenedAt = Date.now();
  await putBook(book);

  resetSearch();
  searchQuery = "";
  clearJumpBack();
  $("contents-search").value = "";
  if (contentsTab === "search") contentsTab = "toc";

  $("reader-title").textContent = book.title;
  applyStyles(); // theme the chrome before the book appears
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
      activeRenderer = await openPdfReader(stage, book, { updateProgressUI, saveProgress, userMoved });
    } else {
      activeRenderer = await openTextReader(stage, book, file, { updateProgressUI, saveProgress, userMoved });
    }
    stage.style.opacity = "";
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
  resetSearch();
  searchQuery = "";
  clearJumpBack();
  const p = activeRenderer?.getProgress?.();
  if (activeBook && p) { activeBook.progress = p; await putBook(activeBook); }
  if (activeRenderer?.destroy) activeRenderer.destroy();
  activeRenderer = null;
  activeBook = null;
  view = null;
  $("reader-stage").textContent = "";
  $("view-reader").hidden = true;
  clearReaderTheme();
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
    const fraction = activeRenderer.getProgress?.().fraction || 0;
    list.push({
      target: cur,
      label: lastStatus.chapter || activeBook.title,
      sub: [lastStatus.chapter ? lastStatus.page : "", `${Math.round(fraction * 100)}%`].filter(Boolean).join(" · "),
      fraction,
      at: Date.now(),
    });
    list.sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0));
    toast("Bookmarked");
  }
  activeBook.bookmarks = list;
  await putBook(activeBook);
  syncBookmarkBtn();
};

// ---------- contents sheet: Contents | Bookmarks | Highlights ----------
let contentsTab = "toc";

const fmtDate = (t) => {
  try { return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
};

const tocEntries = () => {
  const flat = [];
  const walk = (arr, depth) => {
    for (const it of arr || []) {
      flat.push({ label: (it.label || it.href || "—").trim(), href: it.href, depth });
      walk(it.subitems, depth + 1);
    }
  };
  walk(view?.book?.toc, 0);
  return flat;
};

const contentsRow = ({ title, sub, quote, current, depth = 0, onPick, onDelete, mark }) => {
  const row = document.createElement("div");
  row.className = "contents-row";
  if (mark) {
    const m = document.createElement("span");
    m.className = "contents-mark";
    row.appendChild(m);
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "contents-item" + (current ? " current" : "");
  if (depth) btn.style.paddingLeft = `${16 + depth * 16}px`;
  const text = document.createElement("span");
  text.className = "ci-text";
  const t = document.createElement("div");
  t.className = quote ? "ci-quote" : "ci-title";
  t.textContent = quote || title;
  text.appendChild(t);
  if (sub) {
    const s = document.createElement("div");
    s.className = "ci-sub";
    s.textContent = sub;
    text.appendChild(s);
  }
  btn.appendChild(text);
  btn.addEventListener("click", () => { closeSheet(); userMoved(); onPick(); });
  row.appendChild(btn);
  if (onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "contents-del";
    del.setAttribute("aria-label", "Delete");
    del.textContent = "×";
    del.addEventListener("click", onDelete);
    row.appendChild(del);
  }
  return row;
};

// ---------- in-book search ----------
// One scan at a time: `searchRun` is bumped on every new query, on tab
// changes and on close, so a scan still walking a 600-page book notices it
// has been superseded and stops appending.
// Searching a common word can match thousands of times; stop collecting
// past this and say so, rather than building a list nobody can scroll.
const MAX_HITS = 400;

let searchQuery = "";
let searchRun = 0;
let searchGroups = [];
let searchHits = 0;
let searchProgress = 0;
let searchDone = false;
let searchTruncated = false;

const resetSearch = () => {
  searchRun++;
  searchGroups = [];
  searchHits = 0;
  searchProgress = 0;
  searchDone = false;
  searchTruncated = false;
};

const searchable = () => typeof activeRenderer?.search === "function";

const searchStatusText = () => {
  if (!searchable()) return "This format can’t be searched.";
  if (searchQuery.trim().length < 2) return "Type at least two characters.";
  if (!searchDone) return `Searching… ${searchHits} found`;
  if (!searchHits) return `No matches for “${searchQuery.trim()}”.`;
  return searchTruncated
    ? `First ${searchHits} results — narrow the search for more`
    : `${searchHits} result${searchHits === 1 ? "" : "s"}`;
};

const updateSearchStatus = () => {
  const el = $("contents-search-status");
  if (!el) return;
  el.textContent = searchStatusText();
  const bar = $("contents-search-bar");
  if (bar) {
    bar.hidden = searchDone || !searchable() || searchQuery.trim().length < 2;
    bar.firstChild.style.width = `${Math.round(searchProgress * 100)}%`;
  }
};

const searchGroupEl = (group) => {
  const frag = document.createDocumentFragment();
  if (group.label) {
    const h = document.createElement("p");
    h.className = "contents-group";
    h.textContent = group.label;
    frag.appendChild(h);
  }
  for (const hit of group.items) {
    const row = document.createElement("div");
    row.className = "contents-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "contents-item";
    const text = document.createElement("span");
    text.className = "ci-text";
    const q = document.createElement("div");
    q.className = "ci-hit";
    // built from text nodes, never innerHTML — this is book content
    q.append(
      document.createTextNode(hit.excerpt.before),
      Object.assign(document.createElement("mark"), { textContent: hit.excerpt.match }),
      document.createTextNode(hit.excerpt.after),
    );
    text.appendChild(q);
    btn.appendChild(text);
    btn.addEventListener("click", () => {
      closeSheet();
      userMoved();
      jumpFrom(() => activeRenderer?.goToSearch?.(hit.target));
    });
    row.appendChild(btn);
    frag.appendChild(row);
  }
  return frag;
};

const runSearch = async (q) => {
  resetSearch();
  activeRenderer?.clearSearch?.();
  searchQuery = q;
  const run = searchRun;
  if (contentsTab === "search") renderContents();
  if (!searchable() || q.trim().length < 2) return;

  try {
    for await (const r of activeRenderer.search(q)) {
      if (run !== searchRun) return;
      if (r.progress != null) searchProgress = r.progress;
      if (r.items?.length) {
        const room = MAX_HITS - searchHits;
        const group = r.items.length > room ? { ...r, items: r.items.slice(0, room) } : r;
        if (group.items.length < r.items.length) searchTruncated = true;
        searchGroups.push(group);
        searchHits += group.items.length;
        // append rather than re-render: a page-by-page scan would otherwise
        // rebuild the whole list once per page
        $("contents-results")?.appendChild(searchGroupEl(group));
      }
      updateSearchStatus();
      if (searchHits >= MAX_HITS) { searchTruncated = true; break; }
    }
  } catch (err) {
    console.warn("in-book search failed", err);
  }
  if (run !== searchRun) return;
  searchDone = true;
  searchProgress = 1;
  updateSearchStatus();
};

const renderSearchTab = (list) => {
  const status = document.createElement("p");
  status.className = "contents-search-status";
  status.id = "contents-search-status";
  status.setAttribute("role", "status");
  list.appendChild(status);

  const bar = document.createElement("div");
  bar.className = "contents-search-progress";
  bar.id = "contents-search-bar";
  bar.appendChild(document.createElement("i"));
  list.appendChild(bar);

  const results = document.createElement("div");
  results.id = "contents-results";
  for (const g of searchGroups) results.appendChild(searchGroupEl(g));
  list.appendChild(results);
  updateSearchStatus();
};

const renderContents = () => {
  const list = $("contents-list");
  list.textContent = "";
  for (const b of $("contents-tabs").querySelectorAll("button")) {
    const on = b.dataset.val === contentsTab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  const searchTab = contentsTab === "search";
  $("contents-search-wrap").hidden = !searchTab;
  if (searchTab) {
    renderSearchTab(list);
    return;
  }
  const empty = (msg) => {
    const p = document.createElement("p");
    p.className = "contents-empty";
    p.textContent = msg;
    list.appendChild(p);
  };

  if (contentsTab === "toc") {
    const entries = tocEntries();
    if (!entries.length) return empty("This book has no table of contents.");
    const here = view?.lastLocation?.tocItem?.href;
    let currentRow = null;
    for (const e of entries) {
      const row = contentsRow({
        title: e.label, depth: e.depth, current: e.href === here,
        onPick: () => view?.goTo(e.href),
      });
      if (e.href === here) currentRow = row;
      list.appendChild(row);
    }
    // open where the reader is, not at the top of a long list
    requestAnimationFrame(() => currentRow?.scrollIntoView({ block: "center" }));
    return;
  }

  if (contentsTab === "bookmarks") {
    const bms = activeBook?.bookmarks || [];
    if (!bms.length) return empty("No bookmarks yet. Tap the bookmark button at the top to mark a page.");
    for (const b of bms) {
      list.appendChild(contentsRow({
        title: b.label || "Bookmark",
        sub: [b.sub, fmtDate(b.at)].filter(Boolean).join(" · "),
        onPick: () => activeRenderer?.gotoBookmark?.(b.target),
        onDelete: async () => {
          activeBook.bookmarks = (activeBook.bookmarks || []).filter((x) => x !== b);
          await putBook(activeBook);
          syncBookmarkBtn();
          renderContents();
        },
      }));
    }
    return;
  }

  const hls = activeBook?.highlights || [];
  if (!hls.length) return empty("No highlights yet. Select text in the book and tap Highlight.");
  for (const h of hls) {
    list.appendChild(contentsRow({
      quote: h.text || "Highlight",
      sub: fmtDate(h.at),
      mark: true,
      onPick: () => view?.showAnnotation(h),
      onDelete: async () => {
        await view?.deleteAnnotation({ value: h.value }).catch(() => {});
        activeBook.highlights = (activeBook.highlights || []).filter((x) => x !== h);
        await putBook(activeBook);
        renderContents();
      },
    }));
  }
};

const openContents = (tab = null) => {
  // a format with no searchable text shouldn't offer a dead tab
  $("contents-tabs").querySelector('[data-val="search"]').hidden = !searchable();
  if (tab) contentsTab = tab;
  if (contentsTab === "search" && !searchable()) contentsTab = "toc";
  // books without a table of contents open on bookmarks
  if (contentsTab === "toc" && !tocEntries().length) contentsTab = "bookmarks";
  renderContents();
  openSheet("sheet-contents");
  if (contentsTab === "search") $("contents-search").focus();
};

// applyStyles() reflects the new value into the Aa sheet's readout
const stepFontSize = (d) => {
  readerSettings.fontSize = Math.min(250, Math.max(60, readerSettings.fontSize + d));
  applyStyles();
  saveReaderSettings();
  afterReflow();
};

// Restyling reflows the page; renderers that measure in pixels need to put
// the reader back where they were. Foliate handles this itself.
const afterReflow = () => requestAnimationFrame(() => activeRenderer?.reflow?.());

const initAppearance = () => {
  const seg = (id, key) => {
    const el = $(id);
    const setActive = () => [...el.querySelectorAll("button")].forEach((b) =>
      b.classList.toggle("active", b.dataset.val === readerSettings[key]));
    el.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        readerSettings[key] = b.dataset.val;
        applyStyles(); saveReaderSettings(); setActive();
        afterReflow();
      }));
    setActive();
  };
  seg("reader-theme-seg", "theme");
  seg("reader-font-seg", "font");
  seg("reader-spacing-seg", "spacing");
  seg("reader-margin-seg", "margin");
  seg("reader-align-seg", "align");
  seg("reader-flow-seg", "flow");
  $("font-minus").addEventListener("click", () => stepFontSize(-10));
  $("font-plus").addEventListener("click", () => stepFontSize(10));
  for (const b of $("contents-tabs").querySelectorAll("button"))
    b.addEventListener("click", () => {
      contentsTab = b.dataset.val;
      renderContents();
      if (contentsTab === "search") $("contents-search").focus();
    });

  const searchInput = $("contents-search");
  const fire = debounce(() => runSearch(searchInput.value), 350);
  searchInput.addEventListener("input", () => {
    // clearing the box should drop the drawn match highlights straight away
    if (!searchInput.value.trim()) { resetSearch(); searchQuery = ""; activeRenderer?.clearSearch?.(); renderContents(); return; }
    fire();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(searchInput.value); }
  });
};

// read-aloud speed, cycled from the mini player
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const syncRateChip = () => {
  $("tts-rate").textContent = `${+ttsController.settings.rate.toFixed(2)}×`;
};
const cycleRate = () => {
  const r = ttsController.settings.rate;
  const next = RATES.find((x) => x > r + 0.01) ?? RATES[0];
  ttsController.setRate(next);
  syncRateChip();
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export const initReader = async () => {
  await loadReaderSettings();
  initAppearance();
  // iOS discards backgrounded web apps, so don't leave the page you're on
  // sitting in a 1.2s debounce
  onPageHidden(() => saveProgress.flush());
  document.addEventListener("keydown", readerKey);
  $("reader-close").addEventListener("click", closeReader);
  $("reader-back").addEventListener("click", () => {
    const to = jumpBack;
    clearJumpBack();
    if (to) { userMoved(); view?.goTo(to); }
  });
  $("reader-toc-btn").addEventListener("click", () => openContents());
  $("reader-aa-btn").addEventListener("click", () => openSheet("sheet-appearance"));
  // Dragging used to seek on every input event — for an EPUB that's a section
  // load per pixel of travel. Show where you'd land, and only go on release.
  const slider = $("reader-slider");
  const seekTo = (frac) => {
    userMoved();
    if (view) view.goToFraction(frac);
    else activeRenderer?.seekFraction?.(frac);
  };
  slider.addEventListener("input", () => {
    sliderPreview = slider.value / 1000;
    $("reader-pct").textContent = `${Math.round(sliderPreview * 100)}%`;
  });
  slider.addEventListener("change", () => {
    const frac = sliderPreview ?? slider.value / 1000;
    sliderPreview = null;
    seekTo(frac);
  });
  // stage taps outside foliate docs (margins) toggle chrome
  $("reader-stage").addEventListener("click", (e) => {
    if (e.target === $("reader-stage")) toggleChrome();
  });
  // TTS
  // Speaker and play share one path: no session yet → start one, else
  // play/pause. (Play used to only toggle, so with no session it did nothing.)
  const playTts = () => {
    $("tts-bar").hidden = false;
    syncRateChip();
    if (ttsController._session || ttsController.playing) ttsController.toggle();
    else ttsController.start(() => activeRenderer, {
      title: activeBook?.title,
      author: activeBook?.author,
      cover: coverUrl(activeBook),
    });
  };
  $("reader-tts-btn").addEventListener("click", playTts);
  $("reader-bmk-btn").addEventListener("click", toggleBookmark);
  $("tts-play").addEventListener("click", playTts);
  $("tts-prev").addEventListener("click", () => ttsController.skip(-1));
  $("tts-next").addEventListener("click", () => ttsController.skip(1));
  $("tts-sleep").addEventListener("click", pickTtsSleep);
  $("tts-rate").addEventListener("click", cycleRate);
  $("tts-stop").addEventListener("click", () => {
    ttsController.stop();
    $("tts-bar").hidden = true;
  });
  ttsController.onStateChange = (playing) => {
    $("tts-play").innerHTML = playing
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    $("tts-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  };
};
