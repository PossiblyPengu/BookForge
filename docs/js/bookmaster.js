/**
 * bookmaster.js — BookMaster sync: pushes live reading progress to the
 * tracker at bookmaster.pages.dev. Entirely opt-in — nothing leaves the
 * device until the user links an account in Settings.
 */
import { kvGet, kvSet } from "./db.js";
import { toast } from "./util.js";

const USER_KEY = "bm-user";

export const bookmasterLinked = async () => !!(await kvGet(USER_KEY, null));
export const bookmasterUser = () => kvGet(USER_KEY, null);

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
    await kvSet(USER_KEY, { username: data.username, display_name: data.display_name });
    toast("Linked to BookMaster");
    return true;
  } catch (err) {
    console.warn("BookMaster link failed", err);
    toast(err.message || "Couldn't link BookMaster", { error: true });
    return false;
  }
};

export const bookmasterUnlink = async () => kvSet(USER_KEY, null);

// Throttled push: at most once per 30s per book, unless forced (book closed,
// playback paused). Fire-and-forget — reading progress must never block.
const lastPush = new Map(); // bookId -> { at, pct }
let brokeWarned = false; // toast the dead link once per session, not per turn

export const syncProgress = async (book, { force = false } = {}) => {
  try {
    if (!book?.title) return;
    const user = await kvGet(USER_KEY, null);
    if (!user?.username) return;
    const pct = Math.round((book.progress?.fraction ?? 0) * 1000) / 10;
    const last = lastPush.get(book.id);
    if (!force) {
      if (last?.pct === pct) return; // nothing new to say
      if (last && Date.now() - last.at < 30_000) return;
    }
    lastPush.set(book.id, { at: Date.now(), pct });
    const res = await fetch("/api/bookmaster/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: user.username,
        title: book.title,
        author: book.author || "",
        isbn: book.isbn || book.identifiers?.isbn13 || book.identifiers?.isbn10 || undefined,
        open_library_id: book.openLibraryId || book.identifiers?.open_library || undefined,
        percent: pct,
        format: book.kind === "audio" ? "audio" : "ebook",
      }),
    });
    if (res.status === 404) {
      // BookMaster doesn't know this reader any more — the link is dead,
      // so stop quietly failing on every page turn from here on
      await kvSet(USER_KEY, null);
      if (!brokeWarned) {
        brokeWarned = true;
        toast("BookMaster link broke — relink in Settings", { error: true });
      }
    } else if (!res.ok) {
      console.warn("BookMaster sync failed", res.status);
    }
  } catch (err) {
    console.warn("BookMaster sync failed", err);
  }
};
