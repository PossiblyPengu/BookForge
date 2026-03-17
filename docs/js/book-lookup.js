/**
 * book-lookup.js
 *
 * Searches Google Books and Open Library for book metadata + cover art.
 * Returns a unified result format from both sources.
 */

/**
 * @typedef {Object} BookResult
 * @property {string} title
 * @property {string|null} author
 * @property {string|null} year
 * @property {string|null} genre
 * @property {string|null} description
 * @property {string|null} coverUrl - URL to a cover image
 * @property {string|null} isbn
 * @property {string|null} publisher
 * @property {string|null} workKey
 * @property {string|null} editionKey
 * @property {string[]|null} editionKeys
 * @property {string} source - "google" or "openlibrary"
 */

// ---------------------------------------------------------------------------
// Google Books API
// ---------------------------------------------------------------------------

const searchGoogleBooks = async (query, maxResults = 5) => {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}&printType=books`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.items?.length) return [];

    return data.items.map((item) => {
      const v = item.volumeInfo || {};
      const isbn = v.industryIdentifiers?.find(
        (id) => id.type === "ISBN_13" || id.type === "ISBN_10"
      );
      // Prefer larger thumbnail
      let coverUrl = null;
      if (v.imageLinks) {
        coverUrl =
          v.imageLinks.thumbnail ||
          v.imageLinks.smallThumbnail ||
          null;
        // Google returns http URLs; upgrade to https and request larger size
        if (coverUrl) {
          coverUrl = coverUrl.replace(/^http:/, "https:");
          coverUrl = coverUrl.replace(/&edge=curl/i, "");
          coverUrl = coverUrl.replace(/zoom=\d/, "zoom=1");
        }
      }
      // Extract chapter names from table of contents if available
      let chapters = null;
      if (v.tableOfContents?.length) {
        chapters = v.tableOfContents.map((ch) => ch.title || ch);
      }

      return {
        title: v.title || "Unknown",
        subtitle: v.subtitle || null,
        author: v.authors?.join(", ") || null,
        year: v.publishedDate?.slice(0, 4) || null,
        genre: v.categories?.join(", ") || null,
        description: v.description || null,
        coverUrl,
        isbn: isbn?.identifier || null,
        publisher: v.publisher || null,
        chapters,
        volumeId: item.id,
        source: "google",
      };
    });
  } catch (err) {
    console.warn("Google Books search failed:", err);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Open Library API
// ---------------------------------------------------------------------------

const searchOpenLibrary = async (query, maxResults = 5) => {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${maxResults}&fields=key,title,author_name,first_publish_year,subject,isbn,publisher,cover_i,edition_key,description,first_sentence`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.docs?.length) return [];

    return data.docs.map((doc) => {
      const coverId = doc.cover_i;
      const coverUrl = coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
        : null;
      const docDescription =
        normalizeOpenLibraryDescription(doc.description) ||
        normalizeOpenLibraryDescription(doc.first_sentence);
      return {
        title: doc.title || "Unknown",
        subtitle: null,
        author: doc.author_name?.join(", ") || null,
        year: doc.first_publish_year ? String(doc.first_publish_year) : null,
        genre: doc.subject?.slice(0, 3).join(", ") || null,
        description: docDescription,
        coverUrl,
        isbn: doc.isbn?.[0] || null,
        publisher: doc.publisher?.[0] || null,
        chapters: null,
        workKey: doc.key || null,
        editionKey: doc.edition_key?.[0] || null,
        editionKeys: doc.edition_key || null,
        source: "openlibrary",
      };
    });
  } catch (err) {
    console.warn("Open Library search failed:", err);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Combined search
// ---------------------------------------------------------------------------

/**
 * Search both Google Books and Open Library, deduplicate, and return
 * results sorted by relevance (Google first, then Open Library).
 *
 * @param {string} query - Search query (e.g. "The Hobbit Tolkien")
 * @param {number} maxResults - Max results per source
 * @returns {Promise<BookResult[]>}
 */
export const searchBooks = async (query, maxResults = 5) => {
  if (!query || query.trim().length < 2) return [];

  const [googleResults, olResults] = await Promise.all([
    searchGoogleBooks(query, maxResults),
    searchOpenLibrary(query, maxResults),
  ]);

  // Deduplicate: if a Google result has the same title+author as an OL result, skip the OL one
  const seen = new Set();
  for (const r of googleResults) {
    seen.add(`${r.title.toLowerCase()}|${(r.author || "").toLowerCase()}`);
  }

  const uniqueOL = olResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${(r.author || "").toLowerCase()}`;
    return !seen.has(key);
  });

  return [...googleResults, ...uniqueOL];
};

const stripHtml = (raw) => {
  if (!raw) return null;
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

const normalizeOpenLibraryDescription = (desc) => {
  if (!desc) return null;
  if (typeof desc === "string") return stripHtml(desc);
  if (typeof desc === "object") {
    if (typeof desc.value === "string") return stripHtml(desc.value);
    if (typeof desc.text === "string") return stripHtml(desc.text);
    if (typeof desc.data === "string") return stripHtml(desc.data);
  }
  return null;
};

/**
 * Extract narrator name from text using common patterns like
 * "read by ...", "narrated by ...", "narrator: ...".
 */
const extractNarratorFromText = (text) => {
  if (!text) return null;
  const match = text.match(
    /(?:(?:read|narrated|performed|voiced)\s+by|narrator:\s*)([^.,;(\n]+)/i
  );
  return match ? match[1].trim() : null;
};

const mapChapterTitles = (entries) =>
  entries.map((ch) => ch?.title || ch?.label || ch || "").filter(Boolean).map((name) => String(name));

const fetchOpenLibraryEdition = async (editionKey) => {
  if (!editionKey) return null;
  const url = `https://openlibrary.org/api/books?bibkeys=OLID:${editionKey}&format=json&jscmd=data`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const entry = data[`OLID:${editionKey}`];
    if (!entry) return null;
    return {
      description: stripHtml(
        entry.description?.value || entry.description || entry.subtitle || ""
      ),
      chapters: entry.table_of_contents
        ? mapChapterTitles(entry.table_of_contents)
        : null,
    };
  } catch (err) {
    console.warn("Open Library edition lookup failed", err);
    return null;
  }
};

/**
 * Fetch richer details (description + chapters) for a selected book result.
 * @param {BookResult} result
 * @returns {Promise<{description: string|null, chapters: string[]|null}>}
 */
export const fetchBookDetails = async (result) => {
  if (!result) return { description: null, chapters: null, narrator: null };

  let description = result.description || null;
  let chapters = result.chapters || null;
  let narrator = null;

  if (result.source === "google" && result.volumeId) {
    try {
      const resp = await fetch(
        `https://www.googleapis.com/books/v1/volumes/${result.volumeId}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const info = data.volumeInfo || {};
        if (!description && info.description) {
          description = stripHtml(info.description);
        }
        if (!chapters && info.tableOfContents?.length) {
          chapters = mapChapterTitles(info.tableOfContents);
        }
        // Extract narrator from description patterns like "read by ..." or "narrated by ..."
        if (!narrator && info.description) {
          narrator = extractNarratorFromText(info.description);
        }
      }
    } catch { /* ignore */ }
  }

  if (result.source === "openlibrary" && result.workKey) {
    try {
      const resp = await fetch(
        `https://openlibrary.org${result.workKey}.json`
      );
      if (resp.ok) {
        const data = await resp.json();
        if (!chapters && data.table_of_contents?.length) {
          chapters = mapChapterTitles(data.table_of_contents);
        }
        if (!description) {
          description =
            normalizeOpenLibraryDescription(data.description) ||
            normalizeOpenLibraryDescription(data.first_sentence);
        }
      }
    } catch { /* ignore */ }

    const editionCandidates = result.editionKeys?.length
      ? result.editionKeys
      : result.editionKey
        ? [result.editionKey]
        : [];
    if (!description || !chapters) {
      for (const edKey of editionCandidates) {
        if (!edKey) continue;
        const edition = await fetchOpenLibraryEdition(edKey);
        if (edition?.description && !description) description = edition.description;
        if (edition?.chapters?.length && !chapters) chapters = edition.chapters;
        if (description && chapters) break;
      }
    }
  }

  // Try to extract narrator from description if we didn't find one yet
  if (!narrator && description) {
    narrator = extractNarratorFromText(description);
  }

  return { description, chapters, narrator };
};

/**
 * Fetch chapter names for a specific book result.
 * For Google Books, uses the volumeId to get full details.
 * For Open Library, uses the work key to get the TOC.
 *
 * @param {BookResult} result
 * @returns {Promise<string[]|null>}
 */
export const fetchChapters = async (result) => {
  const details = await fetchBookDetails(result);
  return details.chapters;
};

/**
 * Fetch a cover image as a Blob (for embedding into the M4B).
 * Tries direct fetch first. If CORS blocks it, renders through
 * a canvas to extract pixel data as a JPEG blob.
 *
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
export const fetchCoverBlob = async (url) => {
  if (!url) return null;

  // Try direct fetch first
  try {
    const resp = await fetch(url, { mode: "cors" });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob.size > 0) return blob;
    }
  } catch { /* CORS blocked, try canvas fallback */ }

  // Canvas fallback: load image with crossOrigin, draw to canvas, export
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) => resolve(blob),
          "image/jpeg",
          0.92
        );
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
};
