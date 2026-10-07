/**
 * bookmaster.js — BookMaster sync: pushes live reading progress and finished
 * reading sessions to the tracker at bookmaster.pages.dev. Entirely opt-in —
 * nothing leaves the device until the user links an account in Settings.
 *
 * Pushes that can't reach the network aren't dropped: they land in a small
 * IndexedDB queue ("bm-queue") and are retried oldest-first when connectivity
 * returns. Progress is a position — only the newest per book is worth
 * keeping — while every session is a distinct stretch of reading that always
 * rides the queue.
 */
import { kvGet, kvSet, putBook } from "./db.js";
import { toast } from "./util.js";

const USER_KEY = "bm-user";
const QUEUE_KEY = "bm-queue";
const QUEUE_MAX = 50;

// The linked reader, cached so a push fired from pagehide doesn't have to
// wait on IndexedDB before its fetch gets dispatched — the page may freeze
// first.
let userCache; // undefined = not read yet, null = unlinked
const linkedUser = async () => {
  if (userCache === undefined) userCache = await kvGet(USER_KEY, null);
  return userCache;
};

export const bookmasterLinked = async () => !!(await linkedUser());
export const bookmasterUser = () => linkedUser();

/**
 * Hand the device to BookMaster's pair flow; it mints a one-time code and
 * returns it to `from` as ?bm-link=<code>. We navigate away entirely — the
 * page reloads into finishBookmasterLink on return.
 */
export const bookmasterLink = () => {
  location.href =
    `https://bookmaster.pages.dev/link/pageturner?from=${encodeURIComponent(location.origin)}`;
};

/**
 * The return half of the pair flow: redeem the one-time code through our own
 * Pages Function (the bridge secret can't ship in client JS), remember who
 * we linked as, and always strip the code from the URL so a refresh or a
 * copied link can't redeem it twice.
 */
export const finishBookmasterLink = async () => {
  const url = new URL(location.href);
  const code = url.searchParams.get("bm-link");
  if (!code) return false;
  url.searchParams.delete("bm-link");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    const res = await fetch("/api/bookmaster/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Link failed (${res.status})`);
    userCache = { username: data.username, display_name: data.display_name };
    await kvSet(USER_KEY, userCache);
    toast("Linked to BookMaster");
    return true;
  } catch (err) {
    console.warn("BookMaster link failed", err);
    toast(err.message || "Couldn't link BookMaster", { error: true });
    return false;
  }
};

export const bookmasterUnlink = async () => {
  userCache = null;
  await kvSet(USER_KEY, null);
};

// Throttled push: at most once per 30s per book, unless forced (book closed,
// playback paused). Fire-and-forget — reading progress must never block.
const lastPush = new Map(); // bookId -> { at, pct }
let brokeWarned = false; // toast the dead link once per session, not per turn

/**
 * The one POST both pushes share: JSON through our Pages Function, which is
 * the only place the bridge secret lives. `keepalive` lets a push fired as
 * the page hides — a session logged at the moment the app is killed — be
 * delivered anyway.
 */
const postBookmaster = (path, body) =>
  fetch(`/api/bookmaster/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    keepalive: true,
    body: JSON.stringify(body),
  });

/**
 * What a refused push means. A 404 "Unknown reader" is a dead link — stop
 * quietly failing on every page turn from here on. Any other 404 means the
 * pinned shelf row is gone: drop the pin so the next push re-resolves by
 * ISBN and title and pins the row it gets back.
 */
const handleFailedPush = async (book, res) => {
  if (res.status === 404) {
    const data = await res.json().catch(() => null);
    if (data?.error === "Unknown reader") {
      userCache = null;
      await kvSet(USER_KEY, null);
      if (!brokeWarned) {
        brokeWarned = true;
        toast("BookMaster link broke — relink in Settings", { error: true });
      }
    } else if (book?.bookmasterId) {
      delete book.bookmasterId;
      await putBook(book).catch(() => {});
    }
  } else {
    console.warn("BookMaster sync failed", res.status);
  }
};

// ---------- offline queue ----------

const readQueue = async () => (await kvGet(QUEUE_KEY, [])) || [];
const writeQueue = (q) => kvSet(QUEUE_KEY, q);

/** Two pushes name the same book when their pins agree or their titles do. */
const sameBook = (a, b) =>
  (a.user_book_id != null && a.user_book_id === b.user_book_id) || a.title === b.title;

/**
 * Park a push the network couldn't take. Sessions always queue — each one is
 * a distinct stretch of reading — but progress is positional, so a newer
 * position for the same book replaces the queued one rather than adding a
 * stale point for the replay to land. Capped; the oldest give way.
 */
const enqueue = async (entry) => {
  const q = await readQueue();
  if (entry.kind === "progress") {
    const i = q.findIndex((e) => e.kind === "progress" && sameBook(e.body, entry.body));
    if (i >= 0) q.splice(i, 1);
  }
  q.push(entry);
  while (q.length > QUEUE_MAX) q.shift();
  await writeQueue(q);
};

/** A bridge answer worth retrying later rather than dropping the push. */
const retriable = (res) => res.status >= 502 && res.status <= 504;

let flushing = false;
/**
 * Drain the queue oldest-first, stopping at the first push the network still
 * won't take — order is the point (a replayed position must not land after
 * a newer one). A 4xx can never succeed, so it's dropped rather than left to
 * block the line behind it.
 */
export const flushBookmaster = async () => {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const q = await readQueue();
      if (!q.length) return;
      const [head, ...rest] = q;
      let res;
      try {
        res = await postBookmaster(head.kind === "session" ? "session" : "progress", head.body);
      } catch {
        return; // still offline — leave the queue alone
      }
      if (retriable(res)) return;
      await writeQueue(rest);
      if (!res.ok) await handleFailedPush(null, res);
    }
  } finally {
    flushing = false;
  }
};

/**
 * Send a push, parking it in the queue when the network can't take it.
 * Queued entries go first so positions reach BookMaster in the order the
 * reader lived them.
 */
const send = async (kind, body) => {
  await flushBookmaster();
  let res;
  try {
    res = await postBookmaster(kind, body);
  } catch {
    await enqueue({ kind, body });
    return null;
  }
  if (retriable(res)) {
    await enqueue({ kind, body });
    return null;
  }
  return res;
};

export const syncProgress = async (book, { force = false } = {}) => {
  try {
    if (!book?.title) return;
    const user = await linkedUser();
    if (!user?.username) return;
    const pct = Math.round((book.progress?.fraction ?? 0) * 1000) / 10;
    const last = lastPush.get(book.id);
    if (!force) {
      if (last?.pct === pct) return; // nothing new to say
      if (last && Date.now() - last.at < 30_000) return;
    }
    lastPush.set(book.id, { at: Date.now(), pct });
    const res = await send("progress", {
      username: user.username,
      title: book.title,
      author: book.author || "",
      isbn: book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10 || undefined,
      open_library_id: book.identifiers?.open_library || undefined,
      // The shelf row BookMaster gave back last time; pinning beats every
      // guess the other side could make about which book this file is.
      user_book_id: book.bookmasterId || undefined,
      percent: pct,
      format: book.kind === "audio" ? "audio" : "ebook",
      // 'read' is the only status a push may claim — finishing here (a page
      // turn past 99.5%, or "Mark as finished") marks it read over there,
      // reads_on_finish trigger and all.
      status: (book.progress?.fraction || 0) >= 0.995 ? "read" : undefined,
      rating: book.rating || undefined,
    });
    if (!res) return; // offline — parked in the queue
    if (res.ok) {
      // BookMaster answers with the shelf row it wrote — remember its id so
      // the next push pins to it rather than trusting the title again.
      const { userBook, newAchievements } = await res.json().catch(() => ({}));
      if (userBook?.id && userBook.id !== book.bookmasterId) {
        book.bookmasterId = userBook.id;
        await putBook(book).catch(() => {});
      }
      // the bridge hydrates ids into {id, name, icon} — Pageturner keeps no
      // achievement catalogue of its own
      for (const a of newAchievements || [])
        toast(`${a.icon || "🏆"} ${a.name || "Achievement earned"}`, { ms: 4500 });
    } else {
      await handleFailedPush(book, res);
    }
  } catch (err) {
    console.warn("BookMaster sync failed", err);
  }
};

/**
 * A finished stretch of reading, pushed when the reader closes a book or the
 * player pauses — BookMaster logs it as a real session, so streaks and stats
 * move the way they do for a session entered by hand. Sessions are events,
 * not positions: no throttle, and no force flag to swallow one.
 */
export const syncSession = async (book, { percentStart, percentEnd, minutes, at } = {}) => {
  try {
    if (!book?.title) return;
    const user = await linkedUser();
    if (!user?.username) return;
    const res = await send("session", {
      username: user.username,
      user_book_id: book.bookmasterId || undefined,
      title: book.title,
      author: book.author || "",
      isbn: book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10 || undefined,
      open_library_id: book.identifiers?.open_library || undefined,
      percent_start: percentStart,
      percent_end: percentEnd,
      duration_minutes: Math.round(minutes) || undefined,
      at,
    });
    if (res && res.ok) {
      const { newAchievements } = await res.json().catch(() => ({}));
      for (const a of newAchievements || [])
        toast(`${a.icon || "🏆"} ${a.name || "Achievement earned"}`, { ms: 4500 });
    } else if (res) {
      await handleFailedPush(book, res);
    }
  } catch (err) {
    console.warn("BookMaster session sync failed", err);
  }
};

/**
 * A line worth keeping, pushed from the reader's selection chip — lands on
 * the book's shelf row as a BookMaster quote. Queues like a session: a quote
 * is an event, not a position.
 */
export const postQuote = async (book, { content, percent } = {}) => {
  try {
    if (!book?.title || !content) return false;
    const user = await linkedUser();
    if (!user?.username) return false;
    const res = await send("quote", {
      username: user.username,
      user_book_id: book.bookmasterId || undefined,
      title: book.title,
      author: book.author || "",
      isbn: book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10 || undefined,
      open_library_id: book.identifiers?.open_library || undefined,
      content,
      // the reader measures in percent — BookMaster converts to pages when
      // the shelf row knows the book's length
      percent: typeof percent === "number" ? percent * 100 : undefined,
    });
    if (!res) return true; // parked for later — report success
    if (!res.ok) { await handleFailedPush(book, res); return false; }
    return true;
  } catch (err) {
    console.warn("BookMaster quote sync failed", err);
    return false;
  }
};

// Pushes stranded by an earlier outage or a killed page go first, and the
// queue drains again whenever the network comes back.
if (typeof window !== "undefined") {
  flushBookmaster().catch(() => {});
  window.addEventListener("online", () => flushBookmaster().catch(() => {}));
}
