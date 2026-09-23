/**
 * util.js — DOM helpers, toasts, sheets, formatting.
 */

export const $ = (id) => document.getElementById(id);

export const fmtDuration = (sec) => {
  if (!isFinite(sec) || sec == null) return "0:00";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
           : `${m}:${String(s).padStart(2, "0")}`;
};

export const fmtBytes = (n) => {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

export const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const coverUrlCache = new Map();
export const coverUrl = (book) => {
  if (!book.coverBlob) return null;
  if (!coverUrlCache.has(book.id))
    coverUrlCache.set(book.id, URL.createObjectURL(book.coverBlob));
  return coverUrlCache.get(book.id);
};
export const dropCoverUrl = (id) => {
  const u = coverUrlCache.get(id);
  if (u) { URL.revokeObjectURL(u); coverUrlCache.delete(id); }
};

// ---------- toast ----------
let toastTimer;
export const toast = (msg, { error = false, ms = 3200 } = {}) => {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast" + (error ? " toast-err" : "");
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
};

// ---------- sheets ----------
const overlay = () => $("sheet-overlay");
let openSheetEl = null;
let onSheetClose = null;

export const openSheet = (id, onClose = null) => {
  closeSheet();
  openSheetEl = $(id);
  onSheetClose = onClose;
  overlay().hidden = false;
  openSheetEl.hidden = false;
};

export const closeSheet = () => {
  if (openSheetEl) openSheetEl.hidden = true;
  overlay().hidden = true;
  const cb = onSheetClose;
  openSheetEl = null;
  onSheetClose = null;
  if (cb) cb();
};

export const isSheetOpen = () => !!openSheetEl;

// iOS-style drag-to-dismiss: pull the grabber down past ~30% (or 100px) to close
const wireSheetDrag = (sheet) => {
  const grabber = sheet.querySelector(".sheet-grabber");
  if (!grabber) return;
  let startY = 0, dy = 0, dragging = false;
  grabber.addEventListener("pointerdown", (e) => {
    startY = e.clientY; dy = 0; dragging = true;
    sheet.style.transition = "none";
    grabber.setPointerCapture?.(e.pointerId);
  });
  grabber.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = "";
    const close = dy > 100 || dy > sheet.offsetHeight * 0.3;
    sheet.style.transform = "";
    if (close) closeSheet();
    dy = 0;
  };
  grabber.addEventListener("pointerup", end);
  grabber.addEventListener("pointercancel", end);
};

export const initSheets = () => {
  overlay().addEventListener("click", closeSheet);
  document.querySelectorAll(".sheet").forEach(wireSheetDrag);
};

/**
 * Fill the generic list sheet with items and open it.
 * items: [{ title, sub?, thumb? (url), badge?, checked?, value,
 *           action?: { label, title, onAction(item, btn) } }]
 * returns via onPick(value). An item's action button fires in place and
 * leaves the sheet open — the row itself is what picks and closes.
 */
export const listSheet = (title, items, onPick, { search = false, note = "", onClose = null } = {}) => {
  $("sheet-list-title").textContent = title;
  const body = $("sheet-list-body");
  body.textContent = "";
  if (note) {
    const n = document.createElement("p");
    n.className = "sheet-note";
    n.textContent = note;
    body.appendChild(n);
  }
  const rows = document.createElement("div");
  if (search && items.length > 8) {
    const inp = document.createElement("input");
    inp.className = "sheet-search";
    inp.type = "search";
    inp.placeholder = "Filter…";
    inp.addEventListener("input", () => renderRows(inp.value));
    body.appendChild(inp);
  }
  body.appendChild(rows);
  const renderRows = (q) => {
    const needle = (q || "").trim().toLowerCase();
    renderItems(needle ? items.filter((i) =>
      `${i.title} ${i.sub || ""}`.toLowerCase().includes(needle)) : items);
  };
  const buildRow = (item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sheet-list-item";
    if (item.thumb !== undefined) {
      if (item.thumb) {
        const img = document.createElement("img");
        img.className = "sheet-list-thumb";
        img.src = item.thumb;
        img.alt = "";
        btn.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "sheet-list-thumb";
        btn.appendChild(ph);
      }
    }
    const text = document.createElement("div");
    text.className = "item-text";
    const t = document.createElement("div");
    t.className = "item-title";
    t.textContent = item.title;
    text.appendChild(t);
    if (item.sub) {
      const s = document.createElement("div");
      s.className = "item-sub";
      s.textContent = item.sub;
      text.appendChild(s);
    }
    btn.appendChild(text);
    if (item.badge) {
      const b = document.createElement("span");
      b.className = "item-badge";
      b.textContent = item.badge;
      btn.appendChild(b);
    }
    if (item.checked) {
      const c = document.createElement("span");
      c.className = "item-check";
      c.textContent = "✓";
      btn.appendChild(c);
    }
    btn.addEventListener("click", () => { closeSheet(); onPick(item.value); });
    if (!item.action) return btn;

    const row = document.createElement("div");
    row.className = "sheet-list-row";
    row.appendChild(btn);
    const act = document.createElement("button");
    act.type = "button";
    act.className = "sheet-list-action";
    act.textContent = item.action.label;
    act.title = item.action.title || item.action.label;
    act.setAttribute("aria-label", act.title);
    act.addEventListener("click", (e) => {
      e.stopPropagation();
      item.action.onAction(item, act);
    });
    row.appendChild(act);
    return row;
  };
  const renderItems = (list) => {
    rows.textContent = "";
    for (const item of list) rows.appendChild(buildRow(item));
    if (!list.length) {
      const p = document.createElement("p");
      p.style.cssText = "padding:24px;text-align:center;color:var(--text-2)";
      p.textContent = "Nothing found.";
      rows.appendChild(p);
    }
  };
  renderRows("");
  openSheet("sheet-list", onClose);
};

/** Wire a segmented control; returns current value. */
export const segControl = (el, initial, onChange) => {
  const btns = [...el.querySelectorAll("button[data-val]")];
  const set = (val, fire = true) => {
    btns.forEach((b) => b.classList.toggle("active", b.dataset.val === val));
    if (fire) onChange(val);
  };
  btns.forEach((b) => b.addEventListener("click", () => set(b.dataset.val)));
  set(initial, false);
  return { set, get: () => btns.find((b) => b.classList.contains("active"))?.dataset.val };
};

export const confirmSheet = (title, confirmLabel, onConfirm) => {
  listSheet(title, [{ title: confirmLabel, value: true }], (v) => v && onConfirm());
};

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;

/**
 * Deliver a generated file to the user. iOS standalone PWAs can't open
 * blob: downloads reliably — prefer the share sheet (Save to Files).
 */
export const exportBlob = async (blob, name) => {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch { /* user cancelled → fall through to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
};

// ---------- TTS highlight helpers ----------

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find `chunkText` inside element `el`'s text nodes and return a Range
 * covering it. Whitespace-tolerant (innerText collapses whitespace that
 * textContent preserves). `searchFrom` is the raw-text offset to start
 * looking from; returns { range, end } so callers can chain searches.
 * Falls back to null (caller may highlight the whole element).
 */
/**
 * Whitespace-tolerant search for `needleText` in `hay`, starting at
 * `searchFrom` and wrapping to the start if it isn't found after it.
 * Returns { start, end } offsets into `hay`, or null.
 */
export const findText = (hay, needleText, searchFrom = 0) => {
  if (!hay || !needleText) return null;
  const needle = needleText.trim().split(/\s+/)
    .map(reEscape).filter(Boolean).join("\\s+");
  if (!needle) return null;
  const re = new RegExp(needle, "g");
  re.lastIndex = Math.min(searchFrom, hay.length);
  let m = re.exec(hay);
  if (!m) { re.lastIndex = 0; m = re.exec(hay); }
  return m ? { start: m.index, end: m.index + m[0].length } : null;
};

export const rangeForChunk = (el, chunkText, searchFrom = 0) => {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let joined = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: joined.length });
    joined += n.nodeValue;
  }
  const hit = findText(joined, chunkText, searchFrom);
  if (!hit) return null;

  const from = hit.start;
  const to = hit.end;
  const range = doc.createRange();
  let started = false;
  for (const { node, start } of nodes) {
    const end = start + node.nodeValue.length;
    if (!started && from < end) {
      range.setStart(node, from - start);
      started = true;
    }
    if (started && to <= end) {
      range.setEnd(node, to - start);
      return { range, start: from, end: to };
    }
  }
  if (!started) return null;
  const last = nodes[nodes.length - 1];
  range.setEnd(last.node, last.node.nodeValue.length);
  return { range, start: from, end: joined.length };
};

// ---------- TTS sentence chunking ----------

// A sentence ends at . ! ? … — including when a closing quote or bracket
// follows (`"Stop!" she said` breaks after the quote) — or at a hard line
// break. ; and : are clause breaks, used only to split an overlong sentence.
const SENTENCE_BREAK = /(?<=[.!?…]+["'”’)\]]*)\s+|(?<=\n)/;

// Periods that don't end a sentence. Breaking on them makes the voice stop
// dead mid-name ("Mr." … "Smith").
const ABBREV = /(?:^|[\s("'“‘])(?:mr|mrs|ms|mx|dr|prof|sr|jr|st|mt|ft|capt|col|gen|lt|sgt|rev|hon|gov|sen|rep|vs|etc|approx|dept|fig|vol|ch|no|pp?|e\.g|i\.e|a\.m|p\.m)\.$/i;
const INITIAL = /(?:^|\s)[A-Z]\.$/;

const splitLong = (p, max, out) => {
  while (p.length > max) {
    const head = p.slice(0, max + 1);
    // prefer a clause boundary, then a word boundary, then a hard cut
    const clause = [...head.matchAll(/[;:,—–]\s/g)].pop();
    let cut;
    if (clause && clause.index >= max / 3) cut = clause.index + 1;
    else {
      const sp = head.lastIndexOf(" ", max);
      cut = sp >= 40 ? sp : max;
    }
    out.push(p.slice(0, cut).trim());
    p = p.slice(cut).trim();
  }
  if (p) out.push(p);
};

/**
 * Split text into speakable chunks of at most `max` chars, one sentence
 * each where possible. Chunks are the unit of highlighting and skipping.
 */
export const chunk = (text, max = 240) => {
  const sentences = [];
  for (const piece of String(text).split(SENTENCE_BREAK)) {
    const p = piece.trim();
    if (!p) continue;
    const prev = sentences[sentences.length - 1];
    if (prev && (ABBREV.test(prev) || INITIAL.test(prev)) && prev.length + p.length < max)
      sentences[sentences.length - 1] = prev + " " + p;
    else sentences.push(p);
  }
  const out = [];
  for (const s of sentences) splitLong(s, max, out);
  return out;
};

/**
 * Where to start reading a block the page top cuts through: the first
 * chunk that isn't entirely above the reader. `endsBefore(range)` says
 * whether a chunk's DOM range finishes before the visible area begins.
 * Returns { startChunk, hlFrom } or null when the whole block is behind.
 */
export const resumePoint = (el, text, endsBefore) => {
  const chunks = chunk(text);
  let from = 0;
  for (let i = 0; i < chunks.length; i++) {
    const found = rangeForChunk(el, chunks[i], from);
    if (!found || !endsBefore(found.range)) return { startChunk: i, hlFrom: from };
    from = found.end;
  }
  return null;
};

// ---------- TTS block extraction ----------

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "SVG", "CANVAS", "IMG",
  "AUDIO", "VIDEO", "IFRAME", "OBJECT", "SELECT", "TEXTAREA", "RT", "RP",
]);

/**
 * Tags that start a new speech block. This deliberately includes the generic
 * containers (div/section/…): a great many EPUBs — anything converted by
 * Calibre or unpacked from AZW3/MOBI — use <div> for every paragraph, so a
 * "p,h1..h6,li" selector finds only the chapter heading and skips the body.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CENTER", "DD",
  "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD",
  "TFOOT", "TH", "THEAD", "TR", "UL",
]);

// EPUB content documents are XHTML, where tagName keeps the source case
// ("p", not "P"). Normalise, or every tag test silently misses and a whole
// chapter collapses into one body-sized block.
const tagOf = (el) => (el.localName || el.tagName || "").toUpperCase();

const ttsSkipped = (el) =>
  SKIP_TAGS.has(tagOf(el)) ||
  el.hidden === true ||
  el.getAttribute?.("aria-hidden") === "true" ||
  el.classList?.contains?.("tts-hl-layer");

const cleanBlockText = (s) =>
  (s || "").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();

/**
 * Yield { doc, el, text } for every leaf block of `root` (a Document or an
 * Element), in reading order.
 *
 * A block is an element carrying text with no block-level element inside it,
 * so nesting (<li><p>…), <blockquote><p>…) never speaks the same words twice,
 * and text loose between child blocks still gets spoken.
 */
export const extractBlocks = function* (root) {
  const doc = root.ownerDocument || root;
  const start = root.body || root;
  if (!start?.tagName && !start?.childNodes) return;
  // innerText needs layout (it folds <br> into newlines and drops hidden
  // text). A DOMParser document has none, so serialise by hand there —
  // textContent alone would weld "one<br>two" into a single nonsense word.
  const rendered = !!doc.defaultView;
  // innerText only hides *descendants* that aren't rendered; an element that
  // is itself display:none falls back to its textContent. Books hide page
  // numbers, pagebreak markers and nav furniture that way, so check the
  // element itself before descending into it.
  const invisible = (el) => {
    if (!rendered) return false;
    try {
      const cs = doc.defaultView.getComputedStyle(el);
      return cs.display === "none" || cs.visibility === "hidden";
    } catch { return false; }
  };
  const serialize = (el) => {
    let out = "";
    for (const node of el.childNodes || []) {
      if (node.nodeType === 3) out += node.nodeValue;
      else if (node.nodeType === 1 && !ttsSkipped(node))
        out += tagOf(node) === "BR" ? "\n" : serialize(node);
    }
    return out;
  };
  const textOf = (el) => cleanBlockText(rendered ? (el.innerText ?? serialize(el)) : serialize(el));

  const walk = function* (el) {
    if (ttsSkipped(el) || invisible(el)) return;
    let hasBlockChild = false;
    for (const c of el.children || [])
      if (BLOCK_TAGS.has(tagOf(c)) && !ttsSkipped(c)) { hasBlockChild = true; break; }

    if (!hasBlockChild) {
      const t = textOf(el);
      if (t.length > 1) yield { doc, el, text: t };
      return;
    }
    // Mixed content: speak inline runs sitting between the child blocks.
    let run = "";
    for (const node of el.childNodes || []) {
      if (node.nodeType === 3) { run += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      if (BLOCK_TAGS.has(tagOf(node)) && !ttsSkipped(node)) {
        const t = cleanBlockText(run);
        run = "";
        if (t.length > 1) yield { doc, el, text: t };
        yield* walk(node);
      } else if (!ttsSkipped(node)) {
        run += tagOf(node) === "BR" ? "\n" : serialize(node);
      }
    }
    const t = cleanBlockText(run);
    if (t.length > 1) yield { doc, el, text: t };
  };
  yield* walk(start);
};
