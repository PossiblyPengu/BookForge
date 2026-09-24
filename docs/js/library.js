/**
 * library.js — library grid, import entry points, book detail sheet,
 * metadata search + manual edit.
 */

import {
  $, toast, openSheet, closeSheet, listSheet, coverUrl, dropCoverUrl, fmtBytes,
  fmtDuration,
} from "./util.js";
import { allBooks, getBook, putBook, deleteBook, kvGet, kvSet } from "./db.js";
import { importFiles } from "./importer.js";
import { searchMetadata, fetchCoverBlob, metaMatches } from "./metadata.js";
import { detectSeries } from "./book-parser.js";

let onOpenBook = () => {};
export const initLibrary = async (openBook) => {
  onOpenBook = openBook;
  sortMode = (await kvGet("library-sort")) || "recent";
  $("library-search").addEventListener("input", (e) => {
    query = e.target.value;
    renderGrid();
  });
};

let books = [];
let query = "";
let sortMode = "recent";

// selection mode: ids ticked for a bulk action
let selecting = false;
const selected = new Set();

const SORTS = {
  recent: { title: "Recently opened", cmp: (a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt) },
  added:  { title: "Recently added",  cmp: (a, b) => (b.addedAt || 0) - (a.addedAt || 0) },
  title:  { title: "Title A–Z",       cmp: (a, b) => (a.title || "").localeCompare(b.title || "") },
  author: { title: "Author A–Z",      cmp: (a, b) => (a.author || "￿").localeCompare(b.author || "￿") || (a.title || "").localeCompare(b.title || "") },
  format: { title: "Format",          cmp: (a, b) => (a.format || "").localeCompare(b.format || "") || (a.title || "").localeCompare(b.title || "") },
};

const applyView = () => {
  let list = books;
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((b) =>
    `${b.title || ""} ${b.author || ""}`.toLowerCase().includes(q));
  return [...list].sort(SORTS[sortMode]?.cmp || SORTS.recent.cmp);
};

export const refreshLibrary = async () => {
  books = await allBooks();
  renderGrid();
};

export const pickSort = () =>
  listSheet("Sort by", Object.entries(SORTS).map(([value, s]) => ({
    title: s.title, value, checked: sortMode === value,
  })), async (v) => {
    sortMode = v;
    await kvSet("library-sort", v);
    renderGrid();
  });

const GLYPH_BOOK =
  '<svg class="cover-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';
const GLYPH_AUDIO =
  '<svg class="cover-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

// ---------------------------------------------------------------------------
// "Continue reading" — one tap back into the book you were last in
// ---------------------------------------------------------------------------

/** The book to offer resuming: most recently opened, started but not finished. */
const continueBook = () =>
  books
    .filter((b) => b.lastOpenedAt && (b.progress?.fraction || 0) > 0.005
      && (b.progress?.fraction || 0) < 0.995)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] || null;

const renderContinue = () => {
  const card = $("continue-card");
  // it's a shortcut back to one book, so it only gets in the way while
  // someone is searching, or is ticking books for a bulk action
  const book = (query.trim() || selecting) ? null : continueBook();
  card.hidden = !book;
  if (!book) return;

  const audio = book.kind === "audio";
  $("continue-kicker").textContent = audio ? "Continue listening" : "Continue reading";
  $("continue-title").textContent = book.title;

  const pct = Math.round((book.progress.fraction || 0) * 100);
  const total = book.audio?.durationSec || 0;
  const left = audio && total
    ? `${fmtDuration(Math.max(0, total - (book.progress.positionSec || 0)))} left`
    : null;
  $("continue-sub").textContent =
    [book.author, left || `${pct}%`].filter(Boolean).join(" · ");
  $("continue-fill").style.width = `${pct}%`;

  const cover = $("continue-cover");
  cover.textContent = "";
  const url = coverUrl(book);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    cover.appendChild(img);
  } else {
    cover.innerHTML = audio ? GLYPH_AUDIO : GLYPH_BOOK;
  }
  card.setAttribute("aria-label",
    `${audio ? "Continue listening to" : "Continue reading"} ${book.title}, ${pct} percent through`);
};

/**
 * The book "Continue reading" resumes — also used by the manifest's
 * "Continue Reading" app shortcut, so the two can't disagree. Falls back to
 * the most recent book when nothing has been started yet.
 */
export const resumeBook = async () => {
  if (!books.length) books = await allBooks();
  return continueBook() || books[0] || null;
};

export const initContinue = () => {
  $("continue-card").addEventListener("click", () => {
    const book = continueBook();
    if (book) onOpenBook(book);
  });
};

const renderGrid = () => {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.textContent = "";
  empty.hidden = books.length > 0;
  renderContinue();
  grid.classList.toggle("selecting", selecting);
  for (const book of applyView()) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "book-card" + (selected.has(book.id) ? " selected" : "");
    card.dataset.id = book.id;
    if (selecting) card.setAttribute("aria-pressed", selected.has(book.id) ? "true" : "false");

    const cover = document.createElement("div");
    cover.className = "book-cover";
    const url = coverUrl(book);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      cover.appendChild(img);
    } else {
      cover.innerHTML = book.kind === "audio" ? GLYPH_AUDIO : GLYPH_BOOK;
    }
    const badge = document.createElement("span");
    badge.className = "book-badge" + (book.kind === "audio" ? " book-badge-audio" : "");
    badge.textContent = book.format;
    cover.appendChild(badge);
    if (book.needsMeta) {
      const dot = document.createElement("span");
      dot.className = "book-needs-meta";
      dot.textContent = "?";
      dot.title = "Metadata incomplete — tap to fix";
      cover.appendChild(dot);
    }
    const frac = book.progress?.fraction || 0;
    if (frac > 0.005) {
      const bar = document.createElement("div");
      bar.className = "book-progress";
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(frac * 100)}%`;
      bar.appendChild(fill);
      cover.appendChild(bar);
    }
    if (selecting) {
      const tick = document.createElement("span");
      tick.className = "book-tick";
      tick.textContent = "✓";
      cover.appendChild(tick);
    }
    card.appendChild(cover);

    const t = document.createElement("div");
    t.className = "book-card-title";
    t.textContent = book.title;
    card.appendChild(t);
    const a = document.createElement("div");
    a.className = "book-card-author";
    a.textContent = book.author || "Unknown author";
    card.appendChild(a);

    card.addEventListener("click", () => {
      if (selecting) toggleSelected(book.id);
      else openDetail(book.id);
    });
    grid.appendChild(card);
  }
};

// ---------------------------------------------------------------------------
// Selection mode — bulk delete and bulk metadata
// ---------------------------------------------------------------------------

const visibleIds = () => applyView().map((b) => b.id);

const syncSelectUI = () => {
  const n = selected.size;
  $("library-nav-title").textContent = selecting
    ? (n ? `${n} selected` : "Select books")
    : "Library";
  $("select-bar").hidden = !selecting;
  $("select-done").hidden = !selecting;
  for (const id of ["select-btn", "sort-btn", "import-btn"]) $(id).hidden = selecting;
  $("select-delete").disabled = !n;
  $("select-meta").disabled = !n;
  $("select-delete").textContent = n ? `Delete ${n}` : "Delete";
  const all = visibleIds();
  $("select-all").textContent =
    all.length && all.every((id) => selected.has(id)) ? "Select none" : "Select all";
};

const toggleSelected = (id) => {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderGrid();
  syncSelectUI();
};

const setSelecting = (on) => {
  selecting = on;
  selected.clear();
  $("app").classList.toggle("selecting", on);
  renderGrid();
  syncSelectUI();
};

const bulkDelete = () => {
  const ids = [...selected];
  const targets = books.filter((b) => ids.includes(b.id));
  if (!targets.length) return;
  listSheet(
    `Delete ${targets.length} item${targets.length === 1 ? "" : "s"}?`,
    [{ title: `Delete ${targets.length}`, value: true }],
    async () => {
      showImporting(`Deleting ${targets.length}…`);
      try {
        for (const b of targets) {
          await deleteBook(b.id);
          dropCoverUrl(b.id);
        }
      } finally {
        hideImporting();
      }
      setSelecting(false);
      await refreshLibrary();
      toast(`Deleted ${targets.length} item${targets.length === 1 ? "" : "s"}`);
    },
    { note: targets.length <= 6 ? targets.map((b) => b.title).join(" · ") : "This can't be undone." },
  );
};

/**
 * Look up metadata for every selected book, applying only confident matches.
 * The single-book flow asks which edition; across a batch that would mean one
 * question per book, so this takes the unambiguous ones and reports the rest.
 */
const bulkMetadata = async () => {
  const targets = books.filter((b) => selected.has(b.id));
  if (!targets.length) return;
  setSelecting(false);
  let fixed = 0;
  let missed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      showImporting(`Looking up metadata… ${i + 1} of ${targets.length}`);
      const book = targets[i];
      const cands = await searchMetadata(book.title, book.author).catch(() => []);
      const match = cands.find((c) => metaMatches(c, book));
      if (!match) { missed++; continue; }
      const cur = (await getBook(book.id)) || book;
      if (!cur.coverBlob && match.cover)
        cur.coverBlob = (await fetchCoverBlob(match.cover)) || cur.coverBlob;
      if (match.author) cur.author = match.author;
      if (match.title) cur.title = match.title;
      if (!cur.year && match.year) cur.year = match.year;
      if (!cur.desc && match.desc) cur.desc = match.desc;
      cur.identifiers = { ...(cur.identifiers || {}), ...match.identifiers };
      cur.metaSource = match.source;
      cur.needsMeta = false;
      await putBook(cur);
      dropCoverUrl(cur.id);
      fixed++;
    }
  } finally {
    hideImporting();
  }
  await refreshLibrary();
  toast(missed
    ? `Updated ${fixed}, no confident match for ${missed}`
    : `Updated ${fixed} book${fixed === 1 ? "" : "s"}`, { ms: 5000 });
};

export const initSelect = () => {
  $("select-btn").addEventListener("click", () => setSelecting(true));
  $("select-done").addEventListener("click", () => setSelecting(false));
  $("select-delete").addEventListener("click", bulkDelete);
  $("select-meta").addEventListener("click", bulkMetadata);
  $("select-all").addEventListener("click", () => {
    const all = visibleIds();
    if (all.every((id) => selected.has(id))) selected.clear();
    else for (const id of all) selected.add(id);
    renderGrid();
    syncSelectUI();
  });
  syncSelectUI();
};

/** True while the library is in selection mode (app.js suppresses tab keys). */
export const isSelecting = () => selecting;

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

let importEl = null;
const showImporting = (msg) => {
  if (!importEl) {
    importEl = document.createElement("div");
    importEl.className = "import-progress";
    importEl.innerHTML = '<div class="spinner"></div><span></span>';
    document.body.appendChild(importEl);
  }
  importEl.querySelector("span").textContent = msg;
};
const hideImporting = () => { importEl?.remove(); importEl = null; };

export const doImport = async (fileList) => {
  if (!fileList?.length) return;
  showImporting("Importing…");
  try {
    const created = await importFiles(fileList, showImporting);
    if (created.length) {
      toast(created.length === 1 ? `Added "${created[0].title}"` : `Added ${created.length} items`);
      await refreshLibrary();
    }
  } finally {
    hideImporting();
  }
};

/**
 * File Handling API: when the installed app is the OS handler for a book
 * (manifest `file_handlers`), the files arrive here rather than as a share.
 * launch_handler is "focus-existing", so this can fire long after boot.
 */
export const wireFileHandler = () => {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params?.files?.length) return;
    const files = [];
    for (const handle of params.files) {
      const file = await handle.getFile?.().catch(() => null);
      if (file) files.push(file);
    }
    if (files.length) await doImport(files);
  });
};

// Shared-files handoff from the service worker share target
export const checkSharedFiles = async () => {
  const params = new URLSearchParams(location.search);
  const n = parseInt(params.get("shared") || "0", 10);
  if (!n) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("shared-files");
    const files = [];
    for (let i = 0; i < n; i++) {
      const res = await cache.match(`shared-file-${i}`);
      if (res) {
        const blob = await res.blob();
        const name = res.headers.get("x-file-name") || `shared-${i}`;
        files.push(new File([blob], name, { type: blob.type }));
        await cache.delete(`shared-file-${i}`);
      }
    }
    if (files.length) await doImport(files);
  } catch (err) {
    console.warn("shared-file import failed", err);
  }
};

// ---------------------------------------------------------------------------
// Book detail sheet
// ---------------------------------------------------------------------------

let detailBook = null;

export const openDetail = async (id) => {
  detailBook = books.find((b) => b.id === id) || null;
  if (!detailBook) return;
  const b = detailBook;

  $("detail-title").textContent = b.title;
  $("detail-author").textContent = b.author || "Unknown author";
  const series = detectSeries(b.title || "");
  $("detail-format").textContent =
    `${b.format} · ${fmtBytes(b.fileSize)}`
    + (b.year ? ` · ${b.year}` : "")
    + (series ? ` · ${series.series}${series.bookNum ? ` #${series.bookNum}` : ""}` : "");
  const dc = $("detail-cover");
  dc.textContent = "";
  const url = coverUrl(b);
  if (url) {
    const img = document.createElement("img");
    img.src = url; img.alt = "";
    dc.appendChild(img);
  } else {
    dc.innerHTML = b.kind === "audio" ? GLYPH_AUDIO : GLYPH_BOOK;
  }
  $("detail-open-btn").textContent = b.kind === "audio" ? "Listen" : "Read";
  openSheet("sheet-book");
};

const saveDetail = async (updates) => {
  Object.assign(detailBook, updates);
  detailBook.needsMeta = !detailBook.title || !detailBook.author;
  await putBook(detailBook);
  await refreshLibrary();
  openDetail(detailBook.id);
};

const runMetaSearch = async () => {
  closeSheet();
  showImporting("Searching metadata…");
  try {
    const cands = await searchMetadata(detailBook.title, detailBook.author);
    if (!cands.length) { toast("No matches found — edit manually"); openDetail(detailBook.id); return; }
    listSheet("Select edition", cands.map((c, i) => ({
      title: c.title, sub: [c.author, c.year, c.source].filter(Boolean).join(" · "),
      thumb: c.cover, value: i,
    })), async (i) => {
      const c = cands[i];
      const updates = {
        title: c.title || detailBook.title,
        author: c.author || detailBook.author,
        year: c.year || detailBook.year,
        desc: c.desc || detailBook.desc,
        identifiers: { ...(detailBook.identifiers || {}), ...c.identifiers },
        metaSource: c.source,
      };
      if (c.cover) {
        const blob = await fetchCoverBlob(c.cover);
        if (blob) updates.coverBlob = blob;
      }
      await saveDetail(updates);
      toast("Metadata updated");
    });
  } finally {
    hideImporting();
  }
};

const runMetaEdit = () => {
  const b = detailBook;
  $("edit-title").value = b.title || "";
  $("edit-author").value = b.author || "";
  $("edit-year").value = b.year || "";
  $("edit-desc").value = b.desc || "";
  openSheet("sheet-edit");
};

export const initEditSheet = () => {
  $("edit-save").addEventListener("click", async () => {
    if (!detailBook) return;
    await saveDetail({
      title: $("edit-title").value.trim() || detailBook.title,
      author: $("edit-author").value.trim(),
      year: $("edit-year").value.trim(),
      desc: $("edit-desc").value.trim(),
    });
    toast("Saved");
  });
  $("edit-cancel").addEventListener("click", () => openDetail(detailBook?.id));
};

/**
 * Mark finished, or start over. Without this a book abandoned at 40% sits in
 * the Continue card forever, and re-reading one has no way back to page one.
 */
const runProgress = () => {
  const b = detailBook;
  const pct = Math.round((b.progress?.fraction || 0) * 100);
  const done = pct >= 100;
  const audio = b.kind === "audio";
  listSheet(pct ? `${pct}% ${audio ? "listened" : "read"}` : "Not started yet", [
    !done && { title: audio ? "Mark as finished" : "Mark as finished", value: "finish" },
    pct > 0 && { title: audio ? "Start from the beginning" : "Start from the beginning", value: "reset" },
  ].filter(Boolean), async (v) => {
    if (v === "finish") {
      // fraction 1 drops it out of Continue; the position is left alone so
      // reopening still lands where they stopped
      await saveDetail({ progress: { ...(b.progress || {}), fraction: 1 } });
      toast("Marked as finished");
    } else if (v === "reset") {
      await saveDetail({ progress: { fraction: 0 }, lastOpenedAt: null });
      toast("Progress cleared");
    }
  }, {
    note: "Finished books leave the Continue card but stay in your library.",
  });
};

const runDelete = () => {
  const b = detailBook;
  listSheet(`Delete "${b.title}"?`, [{ title: "Delete", value: true }], async () => {
    await deleteBook(b.id);
    dropCoverUrl(b.id);
    detailBook = null;
    await refreshLibrary();
    toast("Deleted");
  });
};

export const initDetail = () => {
  $("detail-open-btn").addEventListener("click", () => {
    const b = detailBook;
    closeSheet();
    if (b) onOpenBook(b);
  });
  $("detail-progress-btn").addEventListener("click", runProgress);
  $("detail-meta-btn").addEventListener("click", runMetaSearch);
  $("detail-edit-btn").addEventListener("click", runMetaEdit);
  $("detail-delete-btn").addEventListener("click", runDelete);
};

export const wireImportUI = () => {
  const input = $("file-input");
  const dirInput = $("dir-input");
  const trigger = () =>
    listSheet("Import", [
      { title: "Files", sub: "Pick one or more — zip archives unpack automatically", value: "files" },
      { title: "Folder", sub: "Import a whole folder at once", value: "dir" },
    ], (v) => (v === "dir" ? dirInput : input).click());
  $("import-btn").addEventListener("click", trigger);
  $("empty-import-btn").addEventListener("click", trigger);
  $("sort-btn").addEventListener("click", pickSort);
  input.addEventListener("change", () => {
    doImport(input.files);
    input.value = "";
  });
  dirInput.addEventListener("change", () => {
    doImport(dirInput.files);
    dirInput.value = "";
  });
  // Drag & drop anywhere (desktop)
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) doImport(e.dataTransfer.files);
  });
};
