import { describe, it, expect } from "vitest";
import { matchShelfRow, remoteResumeFraction } from "../docs/js/bm-pull.js";

const row = (over) => ({
  userBookId: "ub1",
  bookId: "b1",
  title: "Dune",
  author: "Frank Herbert",
  status: "reading",
  rating: null,
  currentPage: 0,
  format: "ebook",
  upNext: null,
  totalPages: 400,
  openLibraryId: null,
  isbn: null,
  percent: 0,
  ...over,
});

const book = (over) => ({ id: "x", title: "Dune", author: "Frank Herbert", ...over });

describe("matchShelfRow", () => {
  it("a pinned shelf row wins without consulting anything else", () => {
    const rows = [row({ userBookId: "ub9", title: "Elsewhere" })];
    expect(matchShelfRow(book({ bookmasterId: "ub9", title: "Anything" }), rows)?.userBookId).toBe("ub9");
    expect(matchShelfRow(book({ bookmasterId: "gone", title: "Nope" }), rows)).toBeNull();
  });

  it("matches on Open Library id and on normalized ISBN", () => {
    const rows = [
      row({ userBookId: "ub1", title: "Different name", openLibraryId: "OL123W" }),
      row({ userBookId: "ub2", title: "Another", isbn: "978-0-441-17271-9" }),
    ];
    expect(matchShelfRow(book({ identifiers: { open_library: "OL123W" } }), rows)?.userBookId).toBe("ub1");
    expect(matchShelfRow(book({ isbn: "0441172712" }), rows)?.userBookId).toBe("ub2");
  });

  it("folds an edition-drifted title but respects author disagreement", () => {
    const rows = [row({ title: "Dune" })];
    expect(matchShelfRow(book({ title: "Dune — Deluxe Edition" }), rows)?.userBookId).toBe("ub1");
    expect(matchShelfRow(book({ title: "Dune", author: "Brian Herbert" }), rows)).toBeNull();
  });

  it("a bare title matches when the e-reader knows no author", () => {
    const rows = [row({ title: "Dune" })];
    expect(matchShelfRow(book({ title: "Dune", author: "" }), rows)?.userBookId).toBe("ub1");
  });
});

describe("remoteResumeFraction", () => {
  it("converts a remote percent, nulls the rest", () => {
    expect(remoteResumeFraction({ bmRemotePercent: 62 })).toBeCloseTo(0.62);
    expect(remoteResumeFraction({ bmRemotePercent: null })).toBeNull();
    expect(remoteResumeFraction({})).toBeNull();
    expect(remoteResumeFraction(null)).toBeNull();
  });
});
