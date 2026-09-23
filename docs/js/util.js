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
 * items: [{ title, sub?, thumb? (url), checked?, value }]
 * returns via onPick(value)
 */
export const listSheet = (title, items, onPick, { search = false } = {}) => {
  $("sheet-list-title").textContent = title;
  const body = $("sheet-list-body");
  body.textContent = "";
  const rows = document.createElement("div");
  if (search && items.length > 12) {
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
  const renderItems = (list) => {
    rows.textContent = "";
    for (const item of list) {
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
    if (item.checked) {
      const c = document.createElement("span");
      c.className = "item-check";
      c.textContent = "✓";
      btn.appendChild(c);
    }
    btn.addEventListener("click", () => { closeSheet(); onPick(item.value); });
    rows.appendChild(btn);
    }
    if (!list.length) {
      const p = document.createElement("p");
      p.style.cssText = "padding:24px;text-align:center;color:var(--text-2)";
      p.textContent = "Nothing found.";
      rows.appendChild(p);
    }
  };
  renderRows("");
  openSheet("sheet-list");
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
export const rangeForChunk = (el, chunkText, searchFrom = 0) => {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let joined = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: joined.length });
    joined += n.nodeValue;
  }
  if (!joined || !chunkText) return null;

  const needle = chunkText.trim().split(/\s+/)
    .map(reEscape).filter(Boolean).join("\\s+");
  if (!needle) return null;
  const re = new RegExp(needle, "g");
  re.lastIndex = Math.min(searchFrom, joined.length);
  let m = re.exec(joined);
  if (!m) { re.lastIndex = 0; m = re.exec(joined); }
  if (!m) return null;

  const from = m.index;
  const to = m.index + m[0].length;
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
