import { describe, it, expect } from "vitest";
import { cleanSpeech, wordAt } from "../docs/js/speech.js";
import { chunk } from "../docs/js/util.js";
import { Sentences } from "../docs/js/tts.js";

describe("cleanSpeech", () => {
  it("leaves ordinary prose untouched", () => {
    const c = cleanSpeech("Mr. Smith met Dr. Watson at half past nine.");
    expect(c.say).toBe("Mr. Smith met Dr. Watson at half past nine.");
    expect(c.silent).toBe(false);
    expect(c.map.every((m, i) => m === i)).toBe(true); // identity map
  });

  it("strips markdown emphasis markers", () => {
    expect(cleanSpeech("He said **yes**, _firmly_, and `now`.").say)
      .toBe("He said yes, firmly, and now.");
  });

  it("keeps a markdown link's words, drops the URL", () => {
    expect(cleanSpeech("see [the docs](https://example.com/x) here").say)
      .toBe("see the docs here");
  });

  it("drops bare URLs entirely", () => {
    expect(cleanSpeech("visit https://example.com/page for more").say)
      .toBe("visit for more");
  });

  it("drops bracketed footnote refs but keeps stage directions", () => {
    expect(cleanSpeech("The claim[12] stands. [she laughs]").say)
      .toBe("The claim stands. [she laughs]");
    expect(cleanSpeech("noted[iv] too").say).toBe("noted too");
  });

  it("drops superscript note marks", () => {
    expect(cleanSpeech("word¹ word²³ more").say).toBe("word word more");
  });

  it("drops note sigils after words", () => {
    expect(cleanSpeech("the claim* stands").say).toBe("the claim stands");
    expect(cleanSpeech("the claim† holds").say).toBe("the claim holds");
  });

  it("normalises dashes into spaced em dashes", () => {
    expect(cleanSpeech("one--two").say).toBe("one — two");
    expect(cleanSpeech("one—two").say).toBe("one — two");
  });

  it("collapses dot runs into one ellipsis", () => {
    expect(cleanSpeech("wait... what").say).toBe("wait… what");
    expect(cleanSpeech("wait… what").say).toBe("wait… what");
  });

  it("collapses shouted punctuation runs", () => {
    expect(cleanSpeech("Stop!!!").say).toBe("Stop!");
    expect(cleanSpeech("What???").say).toBe("What?");
    expect(cleanSpeech("Really!?!?").say).toBe("Really!?");
  });

  it("turns table pipes into pauses", () => {
    expect(cleanSpeech("a | b | c").say).toBe("a, b, c");
  });

  it("strips a leading list bullet or heading mark", () => {
    expect(cleanSpeech("# Chapter One").say).toBe("Chapter One");
    expect(cleanSpeech("• first item").say).toBe("first item");
    expect(cleanSpeech("3. third item").say).toBe("third item");
  });

  it("strips a leading dialogue dash", () => {
    expect(cleanSpeech("— a pause").say).toBe("a pause");
  });

  it("removes invisible characters and ligatures", () => {
    expect(cleanSpeech("soft\u00ADhyphen").say).toBe("softhyphen");
    expect(cleanSpeech("the ﬁsh swam").say).toBe("the fish swam");
  });

  it("clears symbol furniture without eating $5 or 3:45", () => {
    expect(cleanSpeech("a == b = c").say).toBe("a b c");
    expect(cleanSpeech("costs $5 at 3:45").say).toBe("costs $5 at 3:45");
  });

  it("silences a scene separator into a pause", () => {
    const c = cleanSpeech("* * *");
    expect(c.silent).toBe(true);
    expect(c.gap).toBeGreaterThan(0);
    expect(cleanSpeech("— — —").gap).toBeGreaterThan(0);
    expect(cleanSpeech("⁂").silent).toBe(true);
  });

  it("drops a lone mark or page number with no pause", () => {
    expect(cleanSpeech("*")).toEqual(expect.objectContaining({ silent: true, gap: 0 }));
    expect(cleanSpeech("42")).toEqual(expect.objectContaining({ silent: true, gap: 0 }));
  });

  it("gives a paragraph's first chunk a longer gap", () => {
    expect(cleanSpeech("New para.", { newBlock: true }).gap)
      .toBeGreaterThan(cleanSpeech("Same block.").gap);
  });

  it("maps each spoken character back to its source index", () => {
    const raw = "He said **yes** firmly.";
    const { say, map } = cleanSpeech(raw);
    expect(say).toBe("He said yes firmly.");
    // "yes" is at say-index 8 but raw-index 10
    expect(map[8]).toBe(10);
    expect(say.length).toBe(map.length);
  });
});

describe("chunk — prosody-aware boundaries", () => {
  it("joins an ellipsis into its lowercase continuation", () => {
    expect(chunk("Well… maybe not. Yes.")).toEqual(["Well… maybe not.", "Yes."]);
  });

  it("still breaks an ellipsis before a capital", () => {
    expect(chunk("Wait… What?")).toEqual(["Wait…", "What?"]);
  });

  it("doesn't break after month and address abbreviations", () => {
    expect(chunk("He left on Jan. 5th for Lake Ave. She stayed."))
      .toEqual(["He left on Jan. 5th for Lake Ave.", "She stayed."]);
    expect(chunk("Acme Inc. fell. So did Globex Corp."))
      .toEqual(["Acme Inc. fell.", "So did Globex Corp."]);
  });
});

describe("wordAt", () => {
  it("finds the word around an index", () => {
    expect(wordAt("the quick brown", 5)).toEqual({ word: "quick", start: 4 });
  });
});

describe("Sentences — speech pipeline", () => {
  const renderer = (texts) => ({
    textBlocks: async function* () { for (const t of texts) yield { text: t }; },
  });

  it("yields cleaned speech alongside verbatim text", async () => {
    const s = new Sentences(renderer(["He said **yes**.", "Fine."]));
    const first = await s.next();
    expect(first.text).toBe("He said **yes**.");
    expect(first.say).toBe("He said yes.");
    expect(first.map).toBeDefined();
  });

  it("emits a pause marker where a separator sits", async () => {
    const s = new Sentences(renderer(["End of scene.", "* * *", "New scene."]));
    expect((await s.next()).say).toBe("End of scene.");
    const marker = await s.next();
    expect(marker.marker).toBe(true);
    expect(marker.gap).toBeGreaterThan(0);
    expect((await s.next()).say).toBe("New scene.");
  });

  it("skips furniture chunks entirely", async () => {
    const s = new Sentences(renderer(["Real words.", "42", "More words."]));
    expect((await s.next()).say).toBe("Real words.");
    expect((await s.next()).say).toBe("More words.");
  });
});
