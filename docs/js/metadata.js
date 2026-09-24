/**
 * metadata.js — book metadata lookup: Google Books + Open Library.
 * Returns normalized candidates the user can pick from.
 */

const GB_KEY = ""; // Google Books works keyless at low volume
const UA_TIMEOUT = 12000;

const fetchJson = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UA_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

const norm = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Normalized candidate record. */
const cand = ({ title, author, year, desc, cover, source, identifiers = {} }) => ({
  title: title || "", author: author || "", year: year || "",
  desc: desc || "", cover: cover || null, source, identifiers,
});

const searchGoogleBooks = async (query) => {
  const url =
    "https://www.googleapis.com/books/v1/volumes?q=" +
    encodeURIComponent(query) + "&maxResults=8&fields=items(volumeInfo)" +
    (GB_KEY ? `&key=${GB_KEY}` : "");
  const data = await fetchJson(url);
  if (!data?.items) return [];
  return data.items.map(({ volumeInfo: v }) =>
    cand({
      title: v.title,
      author: (v.authors || []).join(", "),
      year: (v.publishedDate || "").slice(0, 4),
      desc: v.description,
      cover: v.imageLinks?.thumbnail?.replace("http://", "https://") || null,
      source: "Google Books",
      identifiers: {
        isbn13: v.industryIdentifiers?.find((i) => i.type === "ISBN_13")?.identifier,
        isbn10: v.industryIdentifiers?.find((i) => i.type === "ISBN_10")?.identifier,
      },
    })
  );
};

const searchOpenLibrary = async (query) => {
  const url =
    "https://openlibrary.org/search.json?q=" + encodeURIComponent(query) +
    "&limit=8&fields=key,title,author_name,first_publish_year,cover_i,isbn";
  const data = await fetchJson(url);
  if (!data?.docs) return [];
  return data.docs.map((d) =>
    cand({
      title: d.title,
      author: (d.author_name || []).join(", "),
      year: d.first_publish_year ? String(d.first_publish_year) : "",
      desc: "",
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      source: "Open Library",
      identifiers: { isbn13: d.isbn?.find((i) => i.length === 13) },
    })
  );
};

/** Search both sources; returns combined, roughly deduplicated candidates. */
export const searchMetadata = async (title, author = "") => {
  const q = [title, author].filter(Boolean).join(" ").trim();
  if (!q) return [];
  const [gb, ol] = await Promise.all([
    searchGoogleBooks(q).catch(() => []),
    searchOpenLibrary(q).catch(() => []),
  ]);
  const seen = new Set();
  const out = [];
  for (const c of [...gb, ...ol]) {
    const key = `${norm(c.title)}|${norm(c.author)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
};

/** Fetch a cover image URL into a Blob (for offline storage). */
export const fetchCoverBlob = async (url) => {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 500 && blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  }
};

/** A title reduced to what identifies it: no subtitle, no leading article. */
const coreTitle = (t) =>
  norm(String(t || "").split(/[:([]/)[0]).replace(/^(the|a|an) /, "");

/**
 * Strict enough to apply without asking. The earlier rule accepted any
 * candidate whose title merely *contained* ours, so "The Salt Road" matched
 * "The Salt Roads" and silently got a stranger's cover. Here the core titles
 * must be equal, and where both sides name an author, a surname must be
 * shared. (The manual picker shows every candidate and lets the person choose.)
 */
export const metaConfident = (cand, { title, author }) => {
  const bt = coreTitle(title);
  if (!bt || coreTitle(cand.title) !== bt) return false;
  const ca = norm(cand.author);
  const ba = norm(author);
  if (!ca || !ba) return true;
  const surname = (a) => a.split(" ").filter((w) => w.length > 1).pop() || a;
  return ca.includes(surname(ba)) || ba.includes(surname(ca));
};
