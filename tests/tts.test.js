import { describe, it, expect, vi, afterEach } from "vitest";
import { extractBlocks } from "../docs/js/util.js";
import { chunk, ttsController } from "../docs/js/tts.js";
import { web } from "../docs/js/tts-engines.js";

// ---------------------------------------------------------------------------
// Minimal DOM stand-in. vitest runs in node here, and extractBlocks only
// touches tagName / children / childNodes / textContent, so a literal tree is
// enough — and keeps the expectations readable.
// ---------------------------------------------------------------------------
const t = (s) => ({ nodeType: 3, nodeValue: s, textContent: s });
const mk = (tag, kids, xhtml) => ({
  nodeType: 1,
  // HTML documents uppercase tagName; XHTML (every EPUB content document)
  // keeps the source case, which is what `x` below models.
  tagName: xhtml ? tag : tag.toUpperCase(),
  ...(xhtml ? { localName: tag } : {}),
  childNodes: kids,
  children: kids.filter((k) => k.nodeType === 1),
  get textContent() { return kids.map((k) => k.textContent).join(""); },
});
const e = (tag, ...kids) => mk(tag, kids, false);
const x = (tag, ...kids) => mk(tag, kids, true);
const docOf = (...kids) => ({ body: e("body", ...kids), defaultView: null });
const xdocOf = (...kids) => ({ body: x("body", ...kids), defaultView: null });

const spoken = (root) => [...extractBlocks(root)].map((b) => b.text);

describe("extractBlocks", () => {
  it("reads <div> paragraphs, not just the heading", () => {
    // Calibre/AZW3 conversions wrap every paragraph in a <div>. A
    // "p,h1..h6,li" selector matched only the heading, so read-aloud
    // announced the chapter number and skipped the chapter.
    const doc = docOf(
      e("h1", t("Chapter Five")),
      e("div", t("It was a bright cold day in April.")),
      e("div", t("The clocks were striking thirteen.")),
    );
    expect(spoken(doc)).toEqual([
      "Chapter Five",
      "It was a bright cold day in April.",
      "The clocks were striking thirteen.",
    ]);
  });

  it("matches XHTML's lowercase tag names", () => {
    // EPUB content documents are XHTML, so tagName is "p", not "P". Matching
    // case-sensitively made every tag test miss, which collapsed a whole
    // chapter into one body-sized block with no paragraph structure.
    const doc = xdocOf(
      x("h1", t("Chapter Nine")),
      x("p", t("First paragraph.")),
      x("p", t("Second paragraph.")),
    );
    expect(spoken(doc)).toEqual(["Chapter Nine", "First paragraph.", "Second paragraph."]);
  });

  it("reads ordinary <p> chapters unchanged", () => {
    const doc = docOf(e("h2", t("Two")), e("p", t("First.")), e("p", t("Second.")));
    expect(spoken(doc)).toEqual(["Two", "First.", "Second."]);
  });

  it("speaks nested blocks once, not once per ancestor", () => {
    const doc = docOf(
      e("ul", e("li", e("p", t("bullet one"))), e("li", e("p", t("bullet two")))),
      e("blockquote", e("p", t("quoted line"))),
    );
    expect(spoken(doc)).toEqual(["bullet one", "bullet two", "quoted line"]);
  });

  it("keeps loose text that sits between child blocks", () => {
    const doc = docOf(e("div", t("lead in"), e("p", t("inner")), t("tail end")));
    expect(spoken(doc)).toEqual(["lead in", "inner", "tail end"]);
  });

  it("keeps inline markup inside a block together", () => {
    const doc = docOf(e("p", t("a "), e("em", t("strong")), t(" claim")));
    expect(spoken(doc)).toEqual(["a strong claim"]);
  });

  it("treats <br> as a line break rather than a join", () => {
    const doc = docOf(e("div", t("line one"), e("br"), t("line two")));
    expect(spoken(doc)).toEqual(["line one\nline two"]);
  });

  it("skips script, style and aria-hidden furniture", () => {
    const doc = docOf(
      e("script", t("var x = 1;")),
      e("style", t("p{color:red}")),
      e("p", t("real text")),
    );
    expect(spoken(doc)).toEqual(["real text"]);
  });

  it("walks table cells", () => {
    const doc = docOf(e("table", e("tbody", e("tr", e("td", t("left")), e("td", t("right"))))));
    expect(spoken(doc)).toEqual(["left", "right"]);
  });

  it("drops blocks with no real text", () => {
    const doc = docOf(e("p", t("   ")), e("p", t("*")), e("p", t("kept")));
    expect(spoken(doc)).toEqual(["kept"]);
  });

  it("accepts an element root as well as a document", () => {
    const root = e("div", e("p", t("from an element")));
    expect(spoken(root)).toEqual(["from an element"]);
  });
});

describe("chunk", () => {
  const words = (s) => s.split(/\s+/).filter(Boolean);

  it("splits on sentence ends", () => {
    expect(chunk("One. Two. Three.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("never loses a word", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
    expect(words(chunk(text).join(" "))).toEqual(words(text));
  });

  it("breaks a run-on sentence at word boundaries under the cap", () => {
    const text = Array.from({ length: 200 }, () => "alpha").join(" ");
    const out = chunk(text);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(240);
    expect(words(out.join(" "))).toEqual(words(text));
  });

  it("returns nothing for whitespace", () => {
    expect(chunk("   \n  ")).toEqual([]);
  });
});

describe("chunk — sentence boundaries", () => {
  it("doesn't break after titles and initials", () => {
    expect(chunk("Mr. Smith met Dr. J. Watson. They talked."))
      .toEqual(["Mr. Smith met Dr. J. Watson.", "They talked."]);
  });

  it("breaks after a closing quote", () => {
    expect(chunk(`"Stop!" she said. "Now."`)).toEqual([`"Stop!"`, "she said.", `"Now."`]);
  });

  it("keeps semicolons and colons inside a sentence", () => {
    expect(chunk("One thing; another: a third. Next.")).toEqual(["One thing; another: a third.", "Next."]);
  });

  it("splits an overlong sentence at a clause boundary when it can", () => {
    const a = Array.from({ length: 20 }, () => "alpha").join(" ");
    const b = Array.from({ length: 30 }, () => "beta").join(" ");
    const out = chunk(`${a}, ${b}; ${b}.`, 240);
    expect(out[0].endsWith(",") || out[0].endsWith(";")).toBe(true);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(240);
  });
});

describe("ttsController.revoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    ttsController.stop();
  });

  it("re-voices the current sentence instead of advancing", async () => {
    vi.useFakeTimers();
    // no DOM here — the status line writes into #tts-status
    vi.spyOn(ttsController, "_status").mockImplementation(() => {});
    const stop = vi.spyOn(web, "stop").mockImplementation(() => {});
    const speak = vi.spyOn(web, "speak").mockImplementation(() => {});
    const session = {};
    const cur = { text: "Same sentence.", i: 0, block: {} };
    const next = { text: "Next one.", i: 1, block: {} };
    Object.assign(ttsController, {
      _session: session, playing: true, _src: null,
      _cur: cur, _ahead: [next], _history: [cur], _fails: 2,
    });
    await ttsController.revoice();
    expect(stop).toHaveBeenCalled();
    expect(ttsController._cur).toBeNull();
    expect(ttsController._fails).toBe(0);
    vi.advanceTimersByTime(80);
    expect(speak).toHaveBeenCalledWith("Same sentence.", expect.any(Function), expect.any(Function));
    expect(ttsController._cur).toBe(cur); // the same sentence again, not _ahead's
  });
});
