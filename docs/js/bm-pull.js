/**
 * bm-pull.js — the read half of BookMaster sync: what the tracker knows that
 * this device doesn't. Fetches the linked reader's shelf and overview through
 * the bridge, merges the shelf onto library books (bmStatus, bmRating,
 * bmRemotePercent, bmUpNext), and caches the pair in kv so a relaunch doesn't
 * wait on the network.
 *
 * The merge only ever decorates: Pageturner's own progress stays the local
 * truth — remote positions exist to be offered (resume), never imposed.
 */
import { kvGet, kvSet, allBooks, putBook } from "./db.js";
import { bookmasterUser } from "./bookmaster.js";
import { listSheet, toast } from "./util.js";

const PULL_KEY = "bm-pull";
const TTL = 5 * 60 * 1000;

let cache; // { at, books: [shelf rows], overview: {...} } — undefined = unread

const fold = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const titleHead = (s) => fold(s).split(/\s*[—–:]\s*/)[0].trim();

/**
 * ISBNs arrive as 10- or 13-digit strings for the same book; canonicalize
 * to both forms so either side matches. Returns a Set of equivalent keys.
 */
const isbnKeys = (s) => {
  const d = (s || "").replace(/[^0-9Xx]/gi, "").toUpperCase();
  const keys = new Set([d]);
  if (d.length === 10) keys.add(isbn10to13(d));
  if (d.length === 13 && d.startsWith("978")) keys.add(isbn13to10(d));
  return keys;
};
const isbn10to13 = (d10) => {
  const b = `978${d10.slice(0, 9)}`;
  const sum = [...b].reduce((a, c, i) => a + +c * (i % 2 ? 3 : 1), 0);
  return `${b}${(10 - (sum % 10)) % 10}`;
};
const isbn13to10 = (d13) => {
  const b = d13.slice(3, 12);
  const sum = [...b].reduce((a, c, i) => a + +c * (10 - i), 0);
  const r = (11 - (sum % 11)) % 11;
  return `${b}${r === 10 ? "X" : r}`;
};
const isbnOverlap = (a, b) => {
  const ka = isbnKeys(a);
  return [...isbnKeys(b)].some((k) => ka.has(k));
};

/**
 * Which shelf row a local book is, best evidence first — the ladder the push
 * side already runs, mirrored: pin, then the ids, then a folded name pair.
 * Author disagreement rejects; a missing author never decides either way.
 */
export const matchShelfRow = (book, rows) => {
  if (book.bookmasterId) {
    const pinned = rows.find((r) => r.userBookId === book.bookmasterId);
    if (pinned) return pinned;
  }
  const ol = book.identifiers?.open_library;
  if (ol) {
    const hit = rows.find((r) => r.openLibraryId && r.openLibraryId === ol);
    if (hit) return hit;
  }
  const isbn = book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10;
  if (isbn) {
    const hit = rows.find((r) => r.isbn && isbnOverlap(isbn, r.isbn));
    if (hit) return hit;
  }
  const wantTitle = fold(book.title);
  const wantHead = titleHead(book.title);
  const wantAuthor = fold(book.author);
  const candidates = rows.filter((r) => {
    const t = fold(r.title);
    const titleOk = t === wantTitle || (wantHead && (t === wantHead || titleHead(r.title) === wantHead));
    if (!titleOk) return false;
    const a = fold(r.author);
    return !(wantAuthor && a && a !== wantAuthor); // disagree → reject; missing → allow
  });
  return candidates[0] || null;
};

/**
 * Apply a shelf row onto a local book. Remote ratings fill a local gap —
 * they never overwrite a rating made here. Returns true if anything changed
 * enough to persist.
 */
const mergeRow = (book, row) => {
  const before = JSON.stringify([book.bmStatus, book.bmRating, book.bmRemotePercent, book.bmUpNext, book.bookmasterId, book.bmBookId, book.rating]);
  book.bookmasterId = book.bookmasterId || row.userBookId;
  book.bmBookId = book.bmBookId || row.bookId;
  book.bmStatus = row.status;
  book.bmRemotePercent = typeof row.percent === "number" ? row.percent : null;
  book.bmUpNext = row.upNext != null;
  if (book.rating == null && typeof row.rating === "number") book.rating = row.rating;
  book.bmRating = row.rating ?? null;
  return JSON.stringify([book.bmStatus, book.bmRating, book.bmRemotePercent, book.bmUpNext, book.bookmasterId, book.bmBookId, book.rating]) !== before;
};

const getJSON = async (path) => {
  const res = await fetch(`/api/bookmaster/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`BookMaster ${path} → ${res.status}`);
  return res.json();
};

/**
 * Fetch + merge. Returns the cached shape whether fresh or not — callers can
 * fire-and-forget at startup and still get yesterday's data instantly.
 */
export const bmPull = async ({ force = false } = {}) => {
  // null means "last attempt found nothing" — re-read kv so a link that
  // happened in another tab (or a seeded record) is seen without a reload.
  if (!cache) cache = await kvGet(PULL_KEY, null);
  if (!force && cache && Date.now() - cache.at < TTL) return cache;
  const user = await bookmasterUser();
  if (!user?.username) return cache;

  try {
    const q = `?username=${encodeURIComponent(user.username)}`;
    const [library, overview, together] = await Promise.all([
      getJSON(`library${q}`),
      getJSON(`overview${q}`),
      getJSON(`together${q}`),
    ]);
    const firstPull = !cache;
    cache = { at: Date.now(), books: library.books || [], overview, together };
    await kvSet(PULL_KEY, cache);
    await toastNewNotices(together?.notices, firstPull);

    for (const b of await allBooks()) {
      const row = matchShelfRow(b, cache.books);
      if (row && mergeRow(b, row)) await putBook(b).catch(() => {});
    }
  } catch (err) {
    console.warn("BookMaster pull failed", err);
  }
  return cache;
};

export const bmOverview = async () => (await bmPull())?.overview || null;

/** The partner + suggestions + notices half of the pull. */
export const bmTogether = async () => (await bmPull())?.together || null;

/**
 * Suite notices — "Alex suggested Dune", a Kindred round waiting — toasted
 * once each, by id. The very first pull of a link marks everything seen
 * silently: a backlog of old notices isn't news.
 */
const SEEN_KEY = "bm-seen-notices";
const toastNewNotices = async (notices, firstPull) => {
  if (!Array.isArray(notices) || !notices.length) return;
  const seen = new Set(await kvGet(SEEN_KEY, []));
  const fresh = notices.filter((n) => n?.id && !seen.has(n.id));
  for (const n of fresh) seen.add(n.id);
  await kvSet(SEEN_KEY, [...seen].slice(-200));
  if (firstPull) return;
  for (const n of fresh.slice(0, 3)) toast(n.text, { ms: 5000 });
};

/**
 * A POST through the bridge that isn't worth queueing: comments, suggestions,
 * heartbeats — conversational, one-off, cheap to retry by hand. Carries the
 * link's username automatically; returns the parsed body or throws.
 */
export const bmPost = async (path, body = {}) => {
  const user = await bookmasterUser();
  if (!user?.username) throw new Error("not linked");
  const res = await fetch(`/api/bookmaster/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `BookMaster → ${res.status}`);
  return data;
};

/** The fields every book-carrying route resolves by — the pin first. */
const bookFields = (book) => ({
  user_book_id: book.bookmasterId || undefined,
  title: book.title,
  author: book.author || "",
  isbn: book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10 || undefined,
  open_library_id: book.identifiers?.open_library || undefined,
});

/**
 * The shared thread on this book, gated the way BookMaster gates it — a note
 * left further on than you are arrives sealed until you reach it (or ask).
 */
export const fetchComments = async (book, { reveal = false } = {}) => {
  const user = await bookmasterUser();
  if (!user?.username) return { comments: [] };
  const q = new URLSearchParams({ username: user.username });
  if (book.bookmasterId) q.set("ub", book.bookmasterId);
  else { q.set("title", book.title || ""); q.set("author", book.author || ""); }
  if (reveal) q.set("reveal", "1");
  return getJSON(`comments?${q}`);
};

/** A note for whoever else has this book — lands on the shared thread. */
export const postComment = (book, content) =>
  bmPost("comment", { ...bookFields(book), content });

/** "Read this next" — offer the book to the other reader. */
export const suggestBook = (book, note) =>
  bmPost("nudge", { ...bookFields(book), note: note || undefined });

/** Accept shelves it on your want-to-read; dismiss just clears the offer. */
export const answerNudge = (id, action) => bmPost("nudge-answer", { id, action });

/** The remote position worth offering for a book, or null. */
export const remoteResumeFraction = (book) => {
  const pct = book?.bmRemotePercent;
  return typeof pct === "number" ? pct / 100 : null;
};

/**
 * Another device may be further along — offer the jump once per opening,
 * never impose it. "Don't offer" lasts a week per book, not forever: drift
 * happens when the other device is where the book actually gets read.
 */
export const offerRemoteResume = (book, jump) => {
  const remote = remoteResumeFraction(book);
  const local = book?.progress?.fraction || 0;
  if (remote === null || remote <= local + 0.02) return;
  const WEEK = 7 * 86_400_000;
  if (book.resumeDismissedAt && Date.now() - book.resumeDismissedAt < WEEK) return;
  const rpct = Math.round(remote * 100);
  const lpct = Math.round(local * 100);
  setTimeout(() => {
    listSheet(`You're ${rpct}% in on BookMaster`, [
      { title: `Jump to ${rpct}%`, sub: "Where the other device left off", value: "jump" },
      { title: "Stay here", value: "stay" },
      { title: "Don't offer again for this book", value: "never" },
    ], async (v) => {
      if (v === "never") {
        book.resumeDismissedAt = Date.now();
        await putBook(book).catch(() => {});
        return;
      }
      if (v === "jump") jump(remote);
    }, {
      note: `This copy is at ${lpct}%. BookMaster keeps the furthest spot you've reported anywhere.`,
    });
  }, 800);
};
