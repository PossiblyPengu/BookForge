import { describe, it, expect } from "vitest";
import {
  parseFilename,
  extractSortKey,
  parseFilenames,
  id3Consensus,
  buildChapterNames,
  inferBook,
} from "../docs/js/book-parser.js";

// ---------------------------------------------------------------------------
// parseFilename
// ---------------------------------------------------------------------------
describe("parseFilename", () => {
  it("parses 'Author - Title - Chapter 01.mp3'", () => {
    const r = parseFilename("J.R.R. Tolkien - The Hobbit - Chapter 01.mp3");
    expect(r.author).toBe("J.R.R. Tolkien");
    expect(r.title).toBe("The Hobbit");
    expect(r.chapterNum).toBe(1);
  });

  it("parses 'Author - Title - 03 - The Journey.mp3'", () => {
    const r = parseFilename("Brandon Sanderson - Mistborn - 03 - The Journey.mp3");
    expect(r.author).toBe("Brandon Sanderson");
    expect(r.title).toBe("Mistborn");
    expect(r.chapterNum).toBe(3);
    expect(r.chapterName).toBe("The Journey");
  });

  it("parses 'Title - Chapter 05.mp3'", () => {
    const r = parseFilename("The Hobbit - Chapter 05.mp3");
    expect(r.title).toBe("The Hobbit");
    expect(r.chapterNum).toBe(5);
  });

  it("parses 'Title - 01 - Chapter Name.mp3'", () => {
    const r = parseFilename("Dune - 01 - The Boy.mp3");
    expect(r.title).toBe("Dune");
    expect(r.chapterNum).toBe(1);
    expect(r.chapterName).toBe("The Boy");
  });

  it("parses 'Title Ch01.mp3'", () => {
    const r = parseFilename("Neuromancer Ch01.mp3");
    expect(r.title).toBe("Neuromancer");
    expect(r.chapterNum).toBe(1);
  });

  it("parses '01 - Chapter Name.mp3'", () => {
    const r = parseFilename("01 - The Beginning.mp3");
    expect(r.chapterNum).toBe(1);
    expect(r.chapterName).toBe("The Beginning");
  });

  it("parses 'Chapter 01.mp3'", () => {
    const r = parseFilename("Chapter 01.mp3");
    expect(r.chapterNum).toBe(1);
    expect(r.title).toBeNull();
  });

  it("parses bare number '07.mp3'", () => {
    const r = parseFilename("07.mp3");
    expect(r.chapterNum).toBe(7);
  });

  it("falls back to filename as chapter name", () => {
    const r = parseFilename("some_random_file.mp3");
    expect(r.chapterName).toBe("some random file");
  });

  it("handles en-dash and em-dash separators", () => {
    const r = parseFilename("Author \u2013 Title \u2014 Chapter 02.mp3");
    expect(r.author).toBe("Author");
    expect(r.title).toBe("Title");
    expect(r.chapterNum).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractSortKey
// ---------------------------------------------------------------------------
describe("extractSortKey", () => {
  it("extracts last number from complex filename", () => {
    expect(extractSortKey("David Wong - John Dies at the End - 10.mp3")).toBe(10);
  });

  it("extracts chapter number from 'Chapter 03 - The Journey.mp3'", () => {
    expect(extractSortKey("Chapter 03 - The Journey.mp3")).toBe(3);
  });

  it("extracts from bare number filename", () => {
    expect(extractSortKey("01.mp3")).toBe(1);
  });

  it("returns Infinity when no number found", () => {
    expect(extractSortKey("prologue.mp3")).toBe(Infinity);
  });

  it("strips path prefix before parsing", () => {
    expect(extractSortKey("some/path/05.mp3")).toBe(5);
  });

  it("uses last number, not first", () => {
    expect(extractSortKey("Book 1 - Chapter 12.mp3")).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// parseFilenames (aggregate)
// ---------------------------------------------------------------------------
describe("parseFilenames", () => {
  it("finds common title across files", () => {
    const files = [
      "The Hobbit - Chapter 01.mp3",
      "The Hobbit - Chapter 02.mp3",
      "The Hobbit - Chapter 03.mp3",
    ];
    const r = parseFilenames(files);
    expect(r.title).toBe("The Hobbit");
  });

  it("finds common author across files", () => {
    const files = [
      "Tolkien - The Hobbit - 01.mp3",
      "Tolkien - The Hobbit - 02.mp3",
    ];
    const r = parseFilenames(files);
    expect(r.author).toBe("Tolkien");
  });

  it("uses common prefix when no title is parsed", () => {
    const files = [
      "MyBook_01.mp3",
      "MyBook_02.mp3",
      "MyBook_03.mp3",
    ];
    const r = parseFilenames(files);
    expect(r.title).toBe("MyBook");
  });

  it("returns null title for unrelated filenames", () => {
    const files = ["01.mp3", "02.mp3"];
    const r = parseFilenames(files);
    expect(r.title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// id3Consensus
// ---------------------------------------------------------------------------
describe("id3Consensus", () => {
  it("finds most common album", () => {
    const meta = [
      { album: "The Hobbit", artist: "Tolkien" },
      { album: "The Hobbit", artist: "Tolkien" },
      { album: "Different", artist: "Other" },
    ];
    const r = id3Consensus(meta);
    expect(r.album).toBe("The Hobbit");
    expect(r.artist).toBe("Tolkien");
  });

  it("handles null metadata entries", () => {
    const meta = [null, { album: "Test" }, null];
    const r = id3Consensus(meta);
    expect(r.album).toBe("Test");
  });

  it("returns null for empty list", () => {
    const r = id3Consensus([]);
    expect(r.album).toBeNull();
    expect(r.artist).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildChapterNames
// ---------------------------------------------------------------------------
describe("buildChapterNames", () => {
  it("uses ID3 title over filename chapter name", () => {
    const fp = [{ chapterNum: 1, chapterName: "File Chapter" }];
    const meta = [{ title: "ID3 Chapter Title" }];
    const names = buildChapterNames(fp, meta);
    expect(names[0]).toContain("ID3 Chapter Title");
  });

  it("falls back to 'Chapter N' when no names available", () => {
    const fp = [{ chapterNum: 1, chapterName: null }];
    const meta = [{ title: null }];
    const names = buildChapterNames(fp, meta);
    expect(names[0]).toBe("Chapter 1");
  });

  it("uses sort key number when available", () => {
    const fp = [{ chapterNum: null, chapterName: null }];
    const meta = [{ title: null }];
    const names = buildChapterNames(fp, meta, ["05.mp3"]);
    expect(names[0]).toBe("Chapter 5");
  });

  it("strips noise prefixes from chapter names", () => {
    const fp = [{ chapterNum: 1, chapterName: "01 - The Beginning" }];
    const meta = [{}];
    const names = buildChapterNames(fp, meta);
    expect(names[0]).toContain("The Beginning");
  });
});

// ---------------------------------------------------------------------------
// inferBook (integration)
// ---------------------------------------------------------------------------
describe("inferBook", () => {
  it("infers title and author from ID3 consensus", () => {
    const files = [
      { name: "01.mp3", file: { name: "01.mp3" } },
      { name: "02.mp3", file: { name: "02.mp3" } },
    ];
    const meta = [
      { album: "The Hobbit", artist: "J.R.R. Tolkien", title: "Ch 1" },
      { album: "The Hobbit", artist: "J.R.R. Tolkien", title: "Ch 2" },
    ];
    const r = inferBook(files, meta);
    expect(r.title).toBe("The Hobbit");
    expect(r.author).toBe("J.R.R. Tolkien");
    expect(r.chapters).toHaveLength(2);
  });

  it("falls back to filename title when no ID3", () => {
    const files = [
      { name: "Dune - 01.mp3", file: { name: "Dune - 01.mp3" } },
      { name: "Dune - 02.mp3", file: { name: "Dune - 02.mp3" } },
    ];
    const meta = [null, null];
    const r = inferBook(files, meta);
    expect(r.title).toBe("Dune");
  });

  it("handles empty input", () => {
    const r = inferBook([], []);
    expect(r.title).toBeNull();
    expect(r.author).toBeNull();
    expect(r.chapters).toHaveLength(0);
  });
});
