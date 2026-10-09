/**
 * library.js — library grid, import entry points, book detail sheet,
 * metadata search + manual edit.
 */

import {
  $, toast, openSheet, closeSheet, listSheet, dropCoverUrl, fmtBytes, fmtLength,
  fmtDuration, coverFor, coverUrl, fillCover, shrinkCover, sleep, isIOS,
} from "./util.js";
import { allBooks, getBook, putBook, deleteBook, kvGet, kvSet } from "./db.js";
import { importFiles } from "./importer.js";
import { searchMetadata, fetchCoverBlob, metaConfident, bmCandidateFields } from "./metadata.js";
import { detectSeries } from "./book-parser.js";
import { openDriveBrowser, initDrive } from "./gdrive.js";
import { syncProgress } from "./bookmaster.js";
import {
  autoImportSupported, watchFolder, scanWatched, listWatched, unwatchFolder, grantFolder,
} from "./autoimport.js";
import { bmTogether, fetchComments, postComment, suggestBook } from "./bm-pull.js";

let onOpenBook = () => {};
export const initLibrary = async (openBook) => {
  onOpenBook = openBook;
  sortMode = (await kvGet("library-sort")) || "recent";
  filterMode = (await kvGet("library-filter")) || "all";
  collections = await kvGet("collections", []);
  collectionFilter = (await kvGet("library-collection")) || "all";
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
let collections = []; // shelf names, ordered
let collectionFilter = "all"; // "all" or a shelf name

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
  if (collectionFilter === "upnext")
    list = list.filter((b) => b.bmUpNext);
  else if (collectionFilter !== "all")
    list = list.filter((b) => b.collections?.includes(collectionFilter));
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((b) =>
    `${b.title || ""} ${b.author || ""}`.toLowerCase().includes(q));
  return [...list].sort(SORTS[sortMode]?.cmp || SORTS.recent.cmp);
};

// The cold-boot IndexedDB read can take a beat: stand the grid in with
// skeleton cards until the first real render replaces them — or 600ms,
// whichever is first, so an empty (or slow) library isn't left staring at
// placeholders. The welcome block stays hidden meanwhile; stacking it under
// skeletons looked like a glitch, and renderGrid restores it if empty.
let booted = false;
let skelTimer = null;

const showSkeletons = () => {
  $("library-empty").hidden = true;
  const grid = $("library-grid");
  grid.textContent = "";
  for (let i = 0; i < 6; i++) {
    const card = document.createElement("div");
    card.className = "skel-card";
    card.setAttribute("aria-hidden", "true");
    card.innerHTML =
      '<div class="skel-cover"></div><div class="skel-lines"><div class="skel-line"></div><div class="skel-line short"></div></div>';
    grid.appendChild(card);
  }
  skelTimer = setTimeout(() => { grid.textContent = ""; }, 600);
};

export const refreshLibrary = async () => {
  if (!booted) showSkeletons();
  try {
    books = await allBooks();
    renderGrid();
  } finally {
    booted = true;
    clearTimeout(skelTimer);
    // a failed read never gets a render — drop the placeholders anyway
    if (!books.length) $("library-grid").querySelectorAll(".skel-card")
      .forEach((c) => c.remove());
  }
};

/**
 * One-time pass for libraries built before covers were capped at import:
 * shrink anything print-sized in place, off the boot path. The flag flips
 * even when nothing needed it so the scan never runs twice.
 */
export const shrinkOversizedCovers = async () => {
  if (await kvGet("covers-shrunk", false)) return;
  let changed = false;
  for (const b of books.filter((x) => x.coverBlob?.size > 300_000)) {
    // deleted mid-pass → leave it deleted (same guard as the metadata flow)
    const cur = await getBook(b.id);
    if (!cur || !cur.coverBlob) continue;
    const shrunk = await shrinkCover(cur.coverBlob);
    if (shrunk === cur.coverBlob) continue;
    cur.coverBlob = shrunk;
    await putBook(cur);
    dropCoverUrl(cur.id);
    changed = true;
    await sleep(30);
  }
  if (changed) await refreshLibrary();
  await kvSet("covers-shrunk", true);
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

// ---------------------------------------------------------------------------
// "Recently added" shelf — a horizontal row of the freshest arrivals
// ---------------------------------------------------------------------------

const renderRecent = () => {
  const shelf = $("recent-shelf");
  const row = $("recent-row");
  row.textContent = "";
  // the shelf is browsable furniture — it hides while searching/selecting,
  // and a tiny library doesn't need a second way to see the same books
  const recent = (query.trim() || selecting || books.length < 5)
    ? []
    : [...books].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  shelf.hidden = !recent.length;

  for (const book of recent) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "shelf-book";
    const cover = document.createElement("div");
    cover.className = "book-cover";
    cover.appendChild(coverFor(book, { lazy: true }));
    item.appendChild(cover);
    const t = document.createElement("div");
    t.className = "shelf-book-title";
    t.textContent = book.title;
    item.appendChild(t);
    const a = document.createElement("div");
    a.className = "shelf-book-author";
    a.textContent = book.author || "Unknown author";
    item.appendChild(a);
    item.addEventListener("click", () => openDetail(book.id));
    row.appendChild(item);
  }
};

// ---------------------------------------------------------------------------
// Collections — named shelves a book can live on, filtered by chips
// ---------------------------------------------------------------------------

const renderChips = () => {
  const wrap = $("coll-chips");
  wrap.textContent = "";
  // "Up next" rides the shelf chips but comes from BookMaster's queue —
  // it appears only while some book carries the flag.
  const chips = ["all", ...(books.some((b) => b.bmUpNext) ? ["upnext"] : []), ...collections];
  // a filter can outlive its chip — up-next flags arrive and vanish with
  // sync — so a name the row can't show falls back to the whole library
  if (!chips.includes(collectionFilter)) collectionFilter = "all";
  wrap.hidden = (chips.length <= 1) || selecting;
  if (wrap.hidden) return;
  for (const name of chips) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "coll-chip" + (collectionFilter === name ? " active" : "");
    chip.textContent = name === "all" ? "All" : name === "upnext" ? "↑ Next" : name;
    chip.addEventListener("click", async () => {
      collectionFilter = name;
      await kvSet("library-collection", name);
      renderGrid();
    });
    wrap.appendChild(chip);
  }
};

/**
 * The shelves sheet, shared by the book-detail action and bulk select.
 * `ids` is the set of books being shelved; a row shows a check when every
 * target is already on it, and toggling adds to — or removes from — all.
 */
let collTargets = [];
const renderCollSheet = () => {
  const list = $("coll-list");
  list.textContent = "";
  if (!collections.length) {
    const empty = document.createElement("p");
    empty.className = "sheet-note";
    empty.textContent = "No shelves yet — make one below.";
    list.appendChild(empty);
  }
  for (const name of collections) {
    const members = books.filter((b) => b.collections?.includes(name));
    const allIn = collTargets.every((id) =>
      books.find((b) => b.id === id)?.collections?.includes(name));
    const row = document.createElement("div");
    row.className = `list-row coll-row${allIn ? " coll-row-on" : ""}`;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "coll-main";
    const label = document.createElement("span");
    label.className = "row-label";
    const check = document.createElement("span");
    check.className = "coll-check";
    check.textContent = "✓";
    label.append(check, name);
    const count = document.createElement("span");
    count.className = "coll-count";
    count.textContent = `${members.length}`;
    main.append(label, count);
    main.addEventListener("click", async () => {
      const nowAll = collTargets.every((id) =>
        books.find((b) => b.id === id)?.collections?.includes(name));
      for (const id of collTargets) {
        const b = books.find((x) => x.id === id);
        if (!b) continue;
        const set = new Set(b.collections || []);
        if (nowAll) set.delete(name); else set.add(name);
        b.collections = [...set];
        await putBook(b);
        if (detailBook?.id === id) detailBook = b;
      }
      await refreshLibrary();
      renderCollSheet();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "coll-del";
    del.setAttribute("aria-label", `Remove shelf ${name}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      listSheet(`Remove “${name}”?`, [{
        title: "Remove shelf", sub: "Books stay in your library", value: "rm",
      }], async () => {
        collections = collections.filter((c) => c !== name);
        if (collectionFilter === name) collectionFilter = "all";
        await kvSet("collections", collections);
        await kvSet("library-collection", collectionFilter);
        for (const b of books.filter((x) => x.collections?.includes(name))) {
          b.collections = b.collections.filter((c) => c !== name);
          await putBook(b);
        }
        await refreshLibrary();
        openCollections(collTargets);
      });
    });
    row.append(main, del);
    list.appendChild(row);
  }
};

export const openCollections = (ids) => {
  collTargets = ids;
  $("coll-new-name").value = "";
  renderCollSheet();
  openSheet("sheet-collections");
};

const initCollections = () => {
  const add = async () => {
    const name = $("coll-new-name").value.trim();
    if (!name) return;
    if (!collections.includes(name)) {
      collections.push(name);
      await kvSet("collections", collections);
    }
    for (const id of collTargets) {
      const b = books.find((x) => x.id === id);
      if (!b) continue;
      b.collections = [...new Set([...(b.collections || []), name])];
      await putBook(b);
    }
    $("coll-new-name").value = "";
    await refreshLibrary();
    renderCollSheet();
  };
  $("coll-new-add").addEventListener("click", add);
  $("coll-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  $("detail-coll-btn").addEventListener("click", () =>
    detailBook && openCollections([detailBook.id]));
};

// ---------------------------------------------------------------------------
// Series — books from one series collapse into a stacked card
// ---------------------------------------------------------------------------

/**
 * Fold runs of the same series into a single { series, members } entry,
 * sitting where its first member sorted. Singles pass through untouched, and
 * searching/selecting keeps books flat — you need the individual titles then.
 */
const groupSeries = (list) => {
  if (query.trim() || selecting) return list;
  const groups = new Map();
  const out = [];
  for (const b of list) {
    const s = detectSeries(b.title || "");
    const key = s?.series?.toLowerCase();
    if (!key) { out.push(b); continue; }
    let g = groups.get(key);
    if (!g) { g = { series: s.series, author: b.author, members: [] }; groups.set(key, g); out.push(g); }
    g.members.push(b);
  }
  return out.flatMap((x) =>
    x.members ? (x.members.length > 1 ? [x] : x.members) : [x]);
};

const seriesCard = (group) => {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "book-card series-card";
  const cover = document.createElement("div");
  cover.className = "book-cover";
  cover.appendChild(coverFor(group.members[0], { lazy: true }));
  card.appendChild(cover);
  const info = document.createElement("div");
  info.className = "book-card-info";
  const t = document.createElement("div");
  t.className = "book-card-title";
  t.textContent = group.series;
  info.appendChild(t);
  const a = document.createElement("div");
  a.className = "book-card-author";
  a.textContent = group.author || "";
  info.appendChild(a);
  const foot = document.createElement("div");
  foot.className = "book-card-foot";
  const pill = document.createElement("span");
  pill.className = "book-fmt";
  pill.textContent = `${group.members.length} books`;
  foot.appendChild(pill);
  info.appendChild(foot);
  card.appendChild(info);
  card.addEventListener("click", () => {
    const ordered = [...group.members].sort((a2, b2) => {
      const an = detectSeries(a2.title || "")?.bookNum ?? Infinity;
      const bn = detectSeries(b2.title || "")?.bookNum ?? Infinity;
      return an - bn;
    });
    listSheet(group.series, ordered.map((b) => ({
      title: b.title,
      sub: [
        detectSeries(b.title || "")?.bookNum ? `Book ${detectSeries(b.title).bookNum}` : null,
        `${Math.round((b.progress?.fraction || 0) * 100)}%`,
      ].filter(Boolean).join(" · "),
      thumb: coverUrl(b),
      value: b.id,
    })), (id) => openDetail(id));
  });
  return card;
};

const renderGrid = () => {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.textContent = "";
  empty.hidden = books.length > 0;
  renderContinue();
  renderRecent();
  renderChips();
  grid.classList.toggle("selecting", selecting);

  const view = applyView();
  const mixed = mixedLibrary();
  $("library-head").hidden = !books.length || !mixed; // the row only carries the filter
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
  $("library-sub").textContent = !books.length ? ""
    : view.length === books.length
      ? `${books.length} ${noun(books.length)}`
      : `${view.length} of ${books.length}`;
  if (!view.length && books.length) {
    const none = document.createElement("p");
    none.className = "library-none";
    none.textContent = query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing here yet.";
    grid.appendChild(none);
  }

  for (const item of groupSeries(view)) {
    if (item.members) { grid.appendChild(seriesCard(item)); continue; }
    const book = item;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "book-card" + (selected.has(book.id) ? " selected" : "");
    card.dataset.id = book.id;
    if (selecting) card.setAttribute("aria-pressed", selected.has(book.id) ? "true" : "false");

    const cover = document.createElement("div");
    cover.className = "book-cover";
    cover.appendChild(coverFor(book, { lazy: true }));
    if (selecting) {
      // a corner check, like Photos — the cover stays visible
      const tick = document.createElement("span");
      tick.className = "book-tick";
      tick.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17l9-10"/></svg>';
      cover.appendChild(tick);
    }
    card.appendChild(cover);

    const info = document.createElement("div");
    info.className = "book-card-info";
    const t = document.createElement("div");
    t.className = "book-card-title";
    t.textContent = book.title;
    info.appendChild(t);
    const a = document.createElement("div");
    a.className = "book-card-author";
    a.textContent = book.author || "Unknown author";
    if (!book.author) a.classList.add("book-card-author-missing");
    info.appendChild(a);

    const foot = document.createElement("div");
    foot.className = "book-card-foot";
    const frac = book.progress?.fraction || 0;
    const st = document.createElement("span");
    if (isFinished(book)) {
      st.className = "book-status st-read";
      st.textContent = "Finished";
    } else if (frac > 0.005) {
      st.className = "book-status st-reading";
      st.textContent = book.kind === "audio" ? "Listening" : "Reading";
    } else if (isNew(book)) {
      st.className = "book-status st-new";
      st.textContent = "New";
    }
    if (st.className) foot.appendChild(st);
    if (book.rating) {
      const star = document.createElement("span");
      star.className = "book-rating";
      star.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>${book.rating}`;
      foot.appendChild(star);
    }
    // generated audiobook covers already carry headphones — the badge is for real art;
    // quiet formats (epub) say nothing, like BookMaster says nothing about ebooks
    if (book.kind === "audio" && book.coverBlob) {
      const badge = document.createElement("span");
      badge.className = "book-fmt";
      badge.innerHTML = HEADPHONES_BADGE;
      badge.title = "Audiobook";
      foot.appendChild(badge);
    } else if (BADGE_FORMATS.has(book.format)) {
      const badge = document.createElement("span");
      badge.className = "book-fmt";
      badge.textContent = book.format === "Markdown" ? "MD" : book.format;
      foot.appendChild(badge);
    }
    if (foot.childElementCount) info.appendChild(foot);

    if (frac > 0.005) {
      const row = document.createElement("div");
      row.className = "book-progress-row";
      const bar = document.createElement("div");
      bar.className = "book-progress" + (isFinished(book) ? " done" : "");
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(frac * 100)}%`;
      bar.appendChild(fill);
      const pct = document.createElement("span");
      pct.className = "book-progress-pct";
      pct.textContent = `${Math.round(frac * 100)}%`;
      row.appendChild(bar);
      row.appendChild(pct);
      info.appendChild(row);
    }
    card.appendChild(info);

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
  $("library-title").textContent = selecting
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
      // deleted mid-lookup → leave it deleted
      const cur = await getBook(book.id);
      if (!cur) continue;
      if (!cur.coverBlob && match.cover)
        cur.coverBlob = (await fetchCoverBlob(match.cover)) || cur.coverBlob;
      if (match.author) cur.author = match.author;
      if (match.title) cur.title = match.title;
      if (!cur.year && match.year) cur.year = match.year;
      if (!cur.desc && match.desc) cur.desc = match.desc;
      cur.identifiers = { ...(cur.identifiers || {}), ...match.identifiers };
      Object.assign(cur, bmCandidateFields(match));
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
  $("select-coll").addEventListener("click", () => {
    if (selected.size) openCollections([...selected]);
  });
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
const showImporting = (msg, ctrl = null) => {
  if (!importEl) {
    importEl = document.createElement("div");
    importEl.className = "import-progress";
    importEl.innerHTML = '<div class="spinner"></div><span></span>';
    document.body.appendChild(importEl);
  }
  importEl.querySelector("span").textContent = msg;
  if (ctrl && !importEl.querySelector(".import-cancel")) {
    const btn = document.createElement("button");
    btn.className = "import-cancel";
    btn.type = "button";
    btn.textContent = "Cancel";
    btn.addEventListener("click", () => ctrl.abort());
    importEl.appendChild(btn);
  }
};
const hideImporting = () => { importEl?.remove(); importEl = null; };

export const doImport = async (fileList) => {
  if (!fileList?.length) return;
  const ctrl = new AbortController();
  showImporting("Importing…", ctrl);
  try {
    const created = await importFiles(fileList, showImporting, ctrl.signal);
    if (ctrl.signal.aborted) {
      toast(created.length
        ? `Import cancelled — ${created.length} item${created.length === 1 ? "" : "s"} kept`
        : "Import cancelled");
      if (created.length) await refreshLibrary();
    } else if (created.length) {
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

  // your rating — taps push straight through to BookMaster when linked
  const stars = $("detail-rating");
  stars.textContent = "";
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "rating-star" + ((b.rating || 0) >= i ? " on" : "");
    s.textContent = "★";
    s.setAttribute("role", "radio");
    s.setAttribute("aria-checked", String((b.rating || 0) === i));
    s.setAttribute("aria-label", `${i} star${i === 1 ? "" : "s"}`);
    s.addEventListener("click", async () => {
      const rating = b.rating === i ? null : i; // tap your rating again to clear
      await saveDetail({ rating });
      syncProgress(b, { force: true });
      toast(rating ? `Rated ${rating}★` : "Rating cleared");
    });
    stars.append(s);
  }

  // what the tracker says about this copy — read-only facts pulled down, so
  // "want to read" there doesn't rewrite the book's own progress here
  const bm = $("detail-bm");
  const bmBits = [];
  if (b.bmStatus) bmBits.push([{ want_to_read: "On the TBR", reading: "Reading", read: "Read", abandoned: "Abandoned" }[b.bmStatus] || b.bmStatus, `bm-s-${b.bmStatus}`]);
  if (b.bmUpNext) bmBits.push(["up next", "bm-s-upnext"]);
  if (b.bmRating && b.bmRating !== b.rating) bmBits.push([`★${b.bmRating} there`, "bm-s-rating"]);
  if (b.bmRemotePercent != null && Math.abs(b.bmRemotePercent / 100 - frac) > 0.02)
    bmBits.push([`${Math.round(b.bmRemotePercent)}% elsewhere`, "bm-s-elsewhere"]);
  bm.replaceChildren();
  if (bmBits.length) {
    bm.append("BookMaster · ");
    bmBits.forEach(([text, cls], i) => {
      if (i) bm.append(" · ");
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      bm.append(s);
    });
  }
  bm.hidden = !bmBits.length;
  fillSharedBlock(b);

  // the one thing most people came here to do, worded for where they are
  $("detail-open-btn").textContent = audio
    ? (finished ? "Listen again" : started ? "Continue listening" : "Listen")
    : (finished ? "Read again" : started ? "Continue reading" : "Read");
  // "Listen" means read-aloud, which only makes sense on non-audio books
  $("detail-listen-btn").hidden = audio;

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

/**
 * The shared thread on a book — notes left between the two readers, gated
 * the way BookMaster gates them (a note from further on than you are stays
 * sealed until you reach it). The block only exists when a second reader
 * uses the instance at all.
 */
const fillSharedBlock = async (book) => {
  const block = $("detail-shared");
  const tg = await bmTogether().catch(() => null);
  if (!tg?.partner) { block.hidden = true; return; }
  block.hidden = false;

  const sug = $("detail-suggest");
  sug.hidden = false;
  sug.textContent = `Suggest to ${tg.partner.name}`;
  sug.onclick = async () => {
    sug.disabled = true;
    try {
      const r = await suggestBook(book);
      toast(`Suggested to ${r.to}`);
      sug.hidden = true;
    } catch (err) {
      toast(err.message || "Couldn't suggest it");
    } finally { sug.disabled = false; }
  };

  const wrap = $("detail-comments");
  wrap.textContent = "";
  let reveal = false;
  const render = async () => {
    wrap.textContent = "";
    const { comments = [] } = await fetchComments(book, { reveal }).catch(() => ({ comments: [] }));
    if (!comments.length) {
      const p = document.createElement("p");
      p.className = "dc-empty";
      p.textContent = `Nothing said yet — first note is yours.`;
      wrap.appendChild(p);
      return;
    }
    for (const c of comments) {
      const row = document.createElement("div");
      row.className = "dc-row" + (c.ahead && !c.content ? " dc-gated" : "");
      const meta = document.createElement("span");
      meta.className = "dc-meta";
      meta.textContent = `${c.display_name}${c.at_percent != null ? ` · ${Math.round(c.at_percent)}%` : ""}`;
      row.appendChild(meta);
      const body = document.createElement("p");
      if (c.ahead && c.content == null) {
        body.textContent = "A note from further on — reach it, or ";
        const show = document.createElement("button");
        show.type = "button";
        show.className = "dc-reveal";
        show.textContent = "peek";
        show.addEventListener("click", () => { reveal = true; render(); });
        body.appendChild(show);
      } else {
        body.textContent = c.content;
      }
      row.appendChild(body);
      wrap.appendChild(row);
    }
  };
  render();

  const input = $("detail-comment-in");
  const send = $("detail-comment-send");
  input.value = "";
  const post = async () => {
    const content = input.value.trim();
    if (!content) return;
    send.disabled = true;
    try {
      await postComment(book, content);
      input.value = "";
      await render();
    } catch (err) { toast(err.message || "Couldn't post it"); }
    finally { send.disabled = false; }
  };
  send.onclick = post;
  input.onkeydown = (e) => { if (e.key === "Enter") post(); };
};

const saveDetail = async (updates) => {
  // a new coverBlob invalidates the cached object URL — drop it before the
  // grid re-renders, or the card keeps showing the old image forever
  if ("coverBlob" in updates) dropCoverUrl(detailBook.id);
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
        ...bmCandidateFields(c),
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
    !done && { title: audio ? "Mark as listened" : "Mark as finished", value: "finish" },
    pct > 0 && { title: audio ? "Listen from the beginning" : "Start from the beginning", value: "reset" },
  ].filter(Boolean), async (v) => {
    if (v === "finish") {
      // fraction 1 drops it out of Continue; the position is left alone so
      // reopening still lands where they stopped
      await saveDetail({ progress: { ...(b.progress || {}), fraction: 1 } });
      syncProgress(b, { force: true }); // shelves it as read on BookMaster
      toast(audio ? "Marked as listened" : "Marked as finished");
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
  // same door, but opens straight into the read-aloud panel
  $("detail-listen-btn").addEventListener("click", () => {
    const b = detailBook;
    closeSheet();
    if (b) onOpenBook(b, { listen: true });
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
  initCollections();
};

export const wireImportUI = () => {
  const input = $("file-input");
  const dirInput = $("dir-input");
  // iOS WebKit only honours MIME filters in `accept`, not extensions — and
  // it can't sniff a MIME for .m4b, so the file stays greyed no matter what
  // accept says (audio/* is worse: iOS reads it as video/*). Dropping the
  // filter lets the picker offer everything; detectFormat still sorts the
  // wheat from the chaff after selection.
  if (isIOS()) input.removeAttribute("accept");
  const trigger = () =>
    listSheet("Import", [
      { title: "Files", sub: "iCloud Drive, On My iPhone, or other apps — zips unpack", value: "files" },
      // iOS file inputs can't pick folders either — don't offer a dead end
      ...(isIOS() ? [] : [
        { title: "Folder", sub: "A whole folder at once — iCloud Drive folders work too", value: "dir" },
      ]),
      // File System Access API (Chromium) — a persistent handle we re-scan
      // on every open. iOS has no handles at all, so it hides too.
      ...(autoImportSupported() ? [
        { title: "Watch a folder", sub: "New books import on their own when you open the app", value: "watch" },
      ] : []),
      { title: "Google Drive", sub: "Browse your Drive and download straight into the library", value: "drive" },
    ], (v) => {
      if (v === "drive") return openDriveBrowser();
      if (v === "watch") return watchAndScan();
      (v === "dir" ? dirInput : input).click();
    });
  $("import-btn").addEventListener("click", trigger);
  $("empty-import-btn").addEventListener("click", trigger);
  initDrive();
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
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    // webkitGetAsEntry keeps folder structure — flat dataTransfer.files
    // turns a dropped folder of audiobooks into one merged book. Items die
    // when the event returns, so collect entries synchronously.
    const entries = [...(e.dataTransfer?.items || [])]
      .map((it) => it.webkitGetAsEntry?.())
      .filter(Boolean);
    if (!entries.length) {
      if (e.dataTransfer?.files?.length) doImport(e.dataTransfer.files);
      return;
    }
    const files = [];
    for (const entry of entries)
      files.push(...await filesFromEntry(entry).catch(() => []));
    if (files.length) doImport(files);
  });
};

/**
 * Re-scan watched folders and feed anything new through the normal import
 * path (progress pill, refresh, toasts). Quiet when nothing changed.
 * Blocked folders get one hint per call — permission needs a tap.
 */
export const rescanWatched = async () => {
  if (!autoImportSupported()) return;
  const { files, blocked } = await scanWatched().catch(() => ({ files: [], blocked: [] }));
  // doImport can still throw (e.g. the progress UI mid-boot) — a watched
  // folder is a background nicety, it must never take down the caller
  if (files.length) await doImport(files).catch(() => {});
  if (blocked.length)
    toast(`Folder access expired for ${blocked.join(", ")} — Settings → Auto-import folders`, { ms: 6000 });
};

/** Pick a folder to watch, then import whatever's already in it. */
const watchAndScan = async () => {
  let w;
  try { w = await watchFolder(); }
  catch { return; } // picker cancelled
  toast(w.added ? `Watching "${w.name}"` : `"${w.name}" is already watched`);
  await rescanWatched();
};

/** The manage sheet: watched folders, per-folder rescan, remove, add. */
export const openWatchManager = async () => {
  const folders = await listWatched();
  const items = [];
  for (const f of folders) {
    const perm = await f.handle.queryPermission({ mode: "read" }).catch(() => "denied");
    items.push({
      title: f.name,
      sub: perm === "granted" ? "Scans when the app opens" : "Folder access expired",
      badge: perm === "granted" ? "" : "Needs access",
      value: f.name,
      action: perm === "granted" ? {
        label: "Remove",
        title: `Stop watching ${f.name}`,
        onAction: async () => { await unwatchFolder(f); openWatchManager(); },
      } : {
        label: "Reconnect",
        title: `Allow access to ${f.name} again`,
        onAction: async () => {
          await grantFolder(f.handle).catch(() => {});
          await rescanWatched();
          openWatchManager();
        },
      },
    });
  }
  items.push({
    title: "Add folder",
    sub: "Books that appear in it import on their own",
    value: "__add",
  });
  listSheet("Auto-import folders", items, async (v) => {
    if (v === "__add") return watchAndScan();
    if (v) return rescanWatched();
  }, {
    note: folders.length
      ? `${folders.length} folder${folders.length === 1 ? "" : "s"} watched. Removing a watch never deletes books.`
      : "No folders watched. Add one and new books in it import when the app opens.",
  });
};

/** Recursively read a dropped FileSystemEntry, keeping the path in the name. */
const filesFromEntry = async (entry, prefix = "") => {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    const rel = prefix ? `${prefix}${file.name}` : file.name;
    return [new File([file], rel, { type: file.type, lastModified: file.lastModified })];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    // readEntries returns batches — loop until empty
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch)
      out.push(...await filesFromEntry(child, `${prefix}${entry.name}/`));
  }
  return out;
};
