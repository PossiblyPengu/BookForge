/**
 * library.js — library grid, import entry points, book detail sheet,
 * metadata search + manual edit.
 */

import {
  $, toast, openSheet, closeSheet, listSheet, dropCoverUrl, fmtBytes,
  fmtDuration, coverFor, fillCover,
} from "./util.js";
import { allBooks, getBook, putBook, deleteBook, kvGet, kvSet } from "./db.js";
import { importFiles } from "./importer.js";
import { searchMetadata, fetchCoverBlob, metaConfident } from "./metadata.js";
import { detectSeries } from "./book-parser.js";

let onOpenBook = () => {};
export const initLibrary = async (openBook) => {
  onOpenBook = openBook;
  sortMode = (await kvGet("library-sort")) || "recent";
  filterMode = (await kvGet("library-filter")) || "all";
  for (const b of $("library-filter").querySelectorAll("button")) {
    b.addEventListener("click", async () => {
      filterMode = b.dataset.val;
      await kvSet("library-filter", filterMode);
      renderGrid();
    });
  }
  $("library-search").addEventListener("input", (e) => {
    query = e.target.value;
    renderGrid();
  });
};

let books = [];
let query = "";
let sortMode = "recent";
let filterMode = "all"; // "all" | "books" | "audio"

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

const FILTERS = {
  all: () => true,
  books: (b) => b.kind !== "audio",
  audio: (b) => b.kind === "audio",
};

// the filter only means something when the library holds both kinds
const mixedLibrary = () =>
  books.some((b) => b.kind === "audio") && books.some((b) => b.kind !== "audio");

const applyView = () => {
  let list = books;
  if (mixedLibrary()) list = list.filter(FILTERS[filterMode] || FILTERS.all);
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

// Only formats that change how a book behaves get a badge. EPUB and its
// cousins are the default, and a label on every cover was noise.
const BADGE_FORMATS = new Set(["PDF", "CBZ", "CBR", "TXT", "Markdown", "HTML"]);
const HEADPHONES_BADGE =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>';
const isFinished = (b) => (b.progress?.fraction || 0) >= 0.995;
const isNew = (b) => !b.lastOpenedAt && !(b.progress?.fraction > 0.005);

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

  fillCover($("continue-cover"), book);
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

  const view = applyView();
  const mixed = mixedLibrary();
  $("library-head").hidden = !books.length;
  $("library-search-wrap").hidden = !books.length; // nothing to search yet
  if (!selecting) {
    $("select-btn").hidden = !books.length;
    $("sort-btn").hidden = !books.length;
  }
  $("library-filter").hidden = !mixed;
  for (const b of $("library-filter").querySelectorAll("button")) {
    const on = b.dataset.val === (mixed ? filterMode : "all");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const noun = (n) => (mixed && filterMode === "audio" ? `audiobook${n === 1 ? "" : "s"}` : `book${n === 1 ? "" : "s"}`);
  $("library-count").textContent = view.length === books.length
    ? `${books.length} ${noun(books.length)}`
    : `${view.length} of ${books.length}`;
  if (!view.length && books.length) {
    const none = document.createElement("p");
    none.className = "library-none";
    none.textContent = query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing here yet.";
    grid.appendChild(none);
  }

  for (const book of view) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "book-card" + (selected.has(book.id) ? " selected" : "");
    card.dataset.id = book.id;
    if (selecting) card.setAttribute("aria-pressed", selected.has(book.id) ? "true" : "false");

    const cover = document.createElement("div");
    cover.className = "book-cover";
    cover.appendChild(coverFor(book, { lazy: true }));
    // generated audiobook covers already carry headphones — the badge is for real art
    if (book.kind === "audio" && book.coverBlob) {
      const badge = document.createElement("span");
      badge.className = "book-badge book-badge-audio";
      badge.innerHTML = HEADPHONES_BADGE;
      badge.title = "Audiobook";
      cover.appendChild(badge);
    } else if (BADGE_FORMATS.has(book.format)) {
      const badge = document.createElement("span");
      badge.className = "book-badge";
      badge.textContent = book.format === "Markdown" ? "MD" : book.format;
      cover.appendChild(badge);
    }
    if (isNew(book)) {
      const pill = document.createElement("span");
      pill.className = "book-pill";
      pill.textContent = "New";
      cover.appendChild(pill);
    } else if (isFinished(book)) {
      const done = document.createElement("span");
      done.className = "book-pill book-pill-done";
      done.textContent = "✓ Finished";
      cover.appendChild(done);
    }
    const frac = book.progress?.fraction || 0;
    if (frac > 0.005 && !isFinished(book)) {
      const bar = document.createElement("div");
      bar.className = "book-progress";
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(frac * 100)}%`;
      bar.appendChild(fill);
      cover.appendChild(bar);
    }
    if (selecting) {
      // a corner check, like Photos — the cover stays visible
      const tick = document.createElement("span");
      tick.className = "book-tick";
      tick.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17l9-10"/></svg>';
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
    if (!book.author) a.classList.add("book-card-author-missing");
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
      const match = cands.find((c) => metaConfident(c, book));
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

/** "9h 32m" — an audiobook's length reads better in hours than h:mm:ss. */
const fmtLength = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};

/** "3 days ago", in the reader's own language. */
const ago = (t) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (s < 60) return "just now";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), "day");
  if (s < 86400 * 365) return rtf.format(-Math.round(s / (86400 * 30)), "month");
  return rtf.format(-Math.round(s / (86400 * 365)), "year");
};

export const openDetail = async (id) => {
  detailBook = books.find((b) => b.id === id) || null;
  if (!detailBook) return;
  const b = detailBook;
  const audio = b.kind === "audio";
  const frac = b.progress?.fraction || 0;
  const finished = isFinished(b);
  const started = frac > 0.005;
  const dur = b.audio?.durationSec || 0;

  $("detail-title").textContent = b.title;
  $("detail-author").textContent = b.author || "Unknown author";
  $("detail-author").classList.toggle("book-card-author-missing", !b.author);
  const series = detectSeries(b.title || "");
  $("detail-format").textContent = [
    b.format,
    audio && dur ? fmtLength(dur) : null,
    fmtBytes(b.fileSize),
    b.year,
    series ? `${series.series}${series.bookNum ? ` #${series.bookNum}` : ""}` : null,
  ].filter(Boolean).join(" · ");
  fillCover($("detail-cover"), b);

  const pct = Math.round(frac * 100);
  $("detail-progress-fill").style.width = `${finished ? 100 : pct}%`;
  $("detail-progress-label").textContent = finished ? "Finished"
    : !started ? "Not started"
    : audio && dur ? `${fmtDuration(Math.max(0, dur - (b.progress?.positionSec || 0)))} left`
    : `${pct}% read`;
  $("detail-progress-extra").textContent = b.lastOpenedAt
    ? `Opened ${ago(b.lastOpenedAt)}` : `Added ${ago(b.addedAt)}`;

  // the one thing most people came here to do, worded for where they are
  $("detail-open-btn").textContent = audio
    ? (finished ? "Listen again" : started ? "Continue listening" : "Listen")
    : (finished ? "Read again" : started ? "Continue reading" : "Read");

  const desc = (b.desc || "").trim();
  const d = $("detail-desc");
  d.textContent = desc;
  d.hidden = !desc;
  d.classList.remove("expanded");
  $("detail-desc-more").hidden = true;
  // whether it's clamped is only measurable once the sheet has laid out
  requestAnimationFrame(() => {
    $("detail-desc-more").hidden = !desc || d.scrollHeight <= d.clientHeight + 2;
  });

  // replaces the "?" that used to sit on the cover with no explanation
  $("detail-missing").hidden = !b.needsMeta;
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
  $("detail-open-btn").addEventListener("click", async () => {
    const b = detailBook;
    closeSheet();
    if (!b) return;
    // "Read again" means from the beginning, not from the last page
    if (isFinished(b)) {
      b.progress = { fraction: 0 };
      await putBook(b);
    }
    onOpenBook(b);
  });
  $("detail-desc-more").addEventListener("click", () => {
    $("detail-desc").classList.add("expanded");
    $("detail-desc-more").hidden = true;
  });
  $("detail-missing-fix").addEventListener("click", runMetaSearch);
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
