import { describe, it, expect, vi, afterEach } from "vitest";
import { postBookmaster } from "../docs/js/bookmaster.js";

// keepalive fetches are capped at ~64KB by the platform — a cover-bearing
// push is far past that, and asking for keepalive on it throws before the
// request ever leaves (that's the bug that silently ate covers — and, via
// the queue's retry-on-head, every push queued behind one).
afterEach(() => vi.unstubAllGlobals());

const sent = () => {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}"));
  }));
  return calls;
};

describe("postBookmaster", () => {
  it("keeps small pushes alive — they can outlive a closing page", async () => {
    const calls = sent();
    await postBookmaster("progress", { username: "a", percent: 50 });
    expect(calls[0].init.keepalive).toBe(true);
  });

  it("a cover-sized body doesn't ask for keepalive it can't have", async () => {
    const calls = sent();
    await postBookmaster("progress", { cover_b64: "x".repeat(200_000) });
    expect(calls[0].init.keepalive).toBe(false);
    expect(calls[0].init.body.length).toBeGreaterThan(200_000);
  });

  it("the boundary sits at the 64KB platform quota", async () => {
    const calls = sent();
    await postBookmaster("progress", { pad: "x".repeat(50_000) });
    await postBookmaster("progress", { pad: "x".repeat(70_000) });
    expect(calls[0].init.keepalive).toBe(true);
    expect(calls[1].init.keepalive).toBe(false);
  });
});
