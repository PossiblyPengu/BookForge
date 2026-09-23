/**
 * library.js — library grid, import entry points, book detail sheet,
 * metadata search + manual edit.
 */

import { $, toast, openSheet, closeSheet, listSheet, coverUrl, dropCoverUrl, fmtBytes } from "./util.js";
import { allBooks, putBook, deleteBook, kvGet, kvSet } from "./db.js";
import { importFiles } from "./importer.js";
import { searchMetadata, fetchCoverBlob } from "./metadata.js";
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

const renderGrid = () => {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.textContent = "";
  empty.hidden = books.length > 0;
  for (const book of applyView()) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "book-card";
    card.dataset.id = book.id;

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
    card.appendChild(cover);

    const t = document.createElement("div");
    t.className = "book-card-title";
    t.textContent = book.title;
    card.appendChild(t);
    const a = document.createElement("div");
    a.className = "book-card-author";
    a.textContent = book.author || "Unknown author";
    card.appendChild(a);

    card.addEventListener("click", () => openDetail(book.id));
    grid.appendChild(card);
  }
};

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
