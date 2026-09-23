import { describe, it, expect } from "vitest";
import { pdfBlocks } from "../docs/js/reader-pdf.js";

// pdf.js text item: transform [a b c d x y], y grows upwards
const item = (str, x, y, { h = 10, eol = true, w = str.length * 5 } = {}) =>
  ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h, hasEOL: eol });

const texts = (items, opts) => pdfBlocks(items, opts).map((b) => b.text);

describe("pdfBlocks", () => {
  it("joins wrapped lines into one paragraph", () => {
    // line-per-block chopped sentences at every line break
    expect(texts([
      item("The quick brown fox jumps over", 50, 700, { w: 400 }),
      item("the lazy dog.", 50, 688, { w: 90 }),
    ])).toEqual(["The quick brown fox jumps over the lazy dog."]);
  });

  it("undoes end-of-line hyphenation", () => {
    expect(texts([
      item("a question of infor-", 50, 700, { w: 400 }),
      item("mation.", 50, 688, { w: 60 }),
    ])).toEqual(["a question of information."]);
  });

  it("splits paragraphs on a short sentence-final line", () => {
    expect(texts([
      item("First paragraph runs the full width of", 50, 700, { w: 400 }),
      item("the page and ends here.", 50, 688, { w: 150 }),
      item("Second paragraph starts on the next line", 50, 676, { w: 400 }),
      item("and ends.", 50, 664, { w: 60 }),
    ])).toEqual([
      "First paragraph runs the full width of the page and ends here.",
      "Second paragraph starts on the next line and ends.",
    ]);
  });

  it("splits a heading from body text", () => {
    expect(texts([
      item("Chapter One", 50, 740, { h: 20, w: 200 }),
      item("It began quietly.", 50, 700, { w: 120 }),
    ])).toEqual(["Chapter One", "It began quietly."]);
  });

  it("drops page numbers at the head or foot of the page", () => {
    expect(texts([
      item("Body text that is read aloud.", 50, 500, { w: 300 }),
      item("42", 300, 30, { w: 10 }),
    ], { top: 800, bottom: 0 })).toEqual(["Body text that is read aloud."]);
  });

  it("maps each item to its characters in the text", () => {
    const [b] = pdfBlocks([
      item("Hello", 50, 700, { eol: false, w: 25 }),
      item(" ", 75, 700, { eol: false, w: 3 }),
      item("world.", 78, 700, { w: 30 }),
    ]);
    expect(b.text).toBe("Hello world.");
    expect(b.spans.map((s) => b.text.slice(s.start, s.end))).toEqual(["Hello", "world."]);
  });
});
