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
import { listSheet } from "./util.js";

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
  const before = JSON.stringify([book.bmStatus, book.bmRating, book.bmRemotePercent, book.bmUpNext, book.bookmasterId, book.rating]);
  book.bookmasterId = book.bookmasterId || row.userBookId;
  book.bmStatus = row.status;
  book.bmRemotePercent = typeof row.percent === "number" ? row.percent : null;
  book.bmUpNext = row.upNext != null;
  if (book.rating == null && typeof row.rating === "number") book.rating = row.rating;
  book.bmRating = row.rating ?? null;
  return JSON.stringify([book.bmStatus, book.bmRating, book.bmRemotePercent, book.bmUpNext, book.bookmasterId, book.rating]) !== before;
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
  if (cache === undefined) cache = await kvGet(PULL_KEY, null);
  if (!force && cache && Date.now() - cache.at < TTL) return cache;
  const user = await bookmasterUser();
  if (!user?.username) return cache;

  try {
    const q = `?username=${encodeURIComponent(user.username)}`;
    const [library, overview] = await Promise.all([
      getJSON(`library${q}`),
      getJSON(`overview${q}`),
    ]);
    cache = { at: Date.now(), books: library.books || [], overview };
    await kvSet(PULL_KEY, cache);

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
