import { describe, it, expect, vi } from "vitest";
import {
  debounce, findAllText, excerptAround, findText, fmtDuration, fmtBytes,
} from "../docs/js/util.js";

describe("debounce", () => {
  it("runs once, trailing, with the latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
    vi.useRealTimers();
  });

  // reading/playback positions are debounced, and iOS kills backgrounded web
  // apps without warning — flush is what stops that losing your place
  it("flush runs a pending call immediately, and only once", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 1000);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("flush does nothing when nothing is pending", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("findAllText", () => {
  it("finds every occurrence, case-insensitively", () => {
    const hits = findAllText("Cat cat CAT dog", "cat");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.start)).toEqual([0, 4, 8]);
  });

  it("matches a phrase across a line break", () => {
    // source text wraps mid-phrase; the reader still has to find it
    const hits = findAllText("the quick\n  brown fox", "quick brown");
    expect(hits).toHaveLength(1);
    expect("the quick\n  brown fox".slice(hits[0].start, hits[0].end)).toBe("quick\n  brown");
  });

  it("caps the number of hits", () => {
    expect(findAllText("a ".repeat(500), "a", 40)).toHaveLength(40);
  });

  it("returns nothing for an empty needle or haystack", () => {
    expect(findAllText("some text", "   ")).toEqual([]);
    expect(findAllText("", "x")).toEqual([]);
  });

  it("treats regex metacharacters literally", () => {
    expect(findAllText("cost is $5 (net)", "$5 (net)")).toHaveLength(1);
    expect(findAllText("plain text", ".*")).toEqual([]);
  });
});

describe("excerptAround", () => {
  const hay = "Before the match there was context, and after the match more of it.";

  it("splits into before/match/after", () => {
    const at = findAllText(hay, "match")[0];
    const ex = excerptAround(hay, at.start, at.end);
    expect(ex.match).toBe("match");
    expect(hay).toContain(ex.match);
    expect(ex.before.endsWith(" ")).toBe(true);
  });

  it("ellipsises only the ends it actually cut", () => {
    const at = findAllText(hay, "context")[0];
    const ex = excerptAround(hay, at.start, at.end, 8);
    expect(ex.before.startsWith("…")).toBe(true);
    expect(ex.after.endsWith("…")).toBe(true);
  });

  it("does not ellipsise when the match is at the very start", () => {
    const ex = excerptAround(hay, 0, 6, 40);
    expect(ex.match).toBe("Before");
    expect(ex.before).toBe("");
  });

  it("collapses whitespace so a hit stays one line", () => {
    const text = "a\n\n  spread   out\tmatch here";
    const at = findAllText(text, "match")[0];
    const ex = excerptAround(text, at.start, at.end);
    expect(`${ex.before}${ex.match}${ex.after}`).not.toMatch(/[\n\t]|\s{2}/);
  });
});

describe("findText", () => {
  it("searches forward from an offset, then wraps", () => {
    expect(findText("one two one", "one", 1).start).toBe(8);
    // nothing after the offset → wraps to the first match
    expect(findText("one two", "one", 5).start).toBe(0);
  });
});

describe("formatters", () => {
  it("formats durations with hours only when needed", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(61)).toBe("1:01");
    expect(fmtDuration(3661)).toBe("1:01:01");
    expect(fmtDuration(NaN)).toBe("0:00");
  });

  it("formats byte sizes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(null)).toBe("—");
  });
});
