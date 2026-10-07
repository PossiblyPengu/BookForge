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

  it("a series parenthetical still names the book", () => {
    const rows = [row({ title: "Dune" })];
    expect(matchShelfRow(book({ title: "Dune (Dune Chronicles, #1)" }), rows)?.userBookId).toBe("ub1");
    // a shelved series-note title meets a plain file title too
    const rows2 = [row({ title: "Dune (Dune Chronicles, #1)" })];
    expect(matchShelfRow(book({ title: "Dune" }), rows2)?.userBookId).toBe("ub1");
  });

  it("file-as order is the same person — 'Herbert, Frank' is Frank Herbert", () => {
    const rows = [row({ title: "Dune" })];
    expect(matchShelfRow(book({ title: "Dune", author: "Herbert, Frank" }), rows)?.userBookId).toBe("ub1");
  });

  it("co-authors in one field still match the row's name", () => {
    const rows = [row({ title: "A Memory Called Empire", author: "Arkady Martine" })];
    expect(matchShelfRow(book({ title: "A Memory Called Empire", author: "Arkady Martine & Someone Else" }), rows)?.userBookId)
      .toBe("ub1");
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
