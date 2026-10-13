import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const { values, copy } = vi.hoisted(() => ({
  values: new Map(),
  copy: (value) => JSON.parse(JSON.stringify(value)),
}));

vi.mock("../docs/js/db.js", () => ({
  kvGet: vi.fn(async (k, fallback = null) => copy(values.get(k) ?? fallback)),
  kvSet: vi.fn(async (k, value) => { values.set(k, copy(value)); }),
  kvUpdate: vi.fn(async (k, update, fallback = null) => {
    const value = update(copy(values.get(k) ?? fallback));
    values.set(k, copy(value));
    return value;
  }),
  putBook: vi.fn(async () => {}),
}));

vi.mock("../docs/js/util.js", () => ({
  $: vi.fn(), toast: vi.fn(), uid: () => crypto.randomUUID(),
}));

let bm;
const book = { id: "book", title: "Dune", author: "Frank Herbert", progress: { fraction: 0.5 } };
const sitting = (at) => ({ percentStart: 10, percentEnd: 15, minutes: 20, at });
const queued = (kind, body = {}) => ({ kind, body: { username: "reader", title: "Dune", ...body } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(async () => {
  vi.resetModules();
  values.clear();
  values.set("bm-user", { username: "reader" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bm = await import("../docs/js/bookmaster.js");
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("BookMaster offline queue", () => {
  it("preserves simultaneous offline sessions", async () => {
    await Promise.all([bm.syncSession(book, sitting(1)), bm.syncSession(book, sitting(2))]);
    expect(values.get("bm-queue").map((e) => e.body.at)).toEqual([1, 2]);
  });

  it("replays quotes to the quote endpoint, not progress", async () => {
    await bm.postQuote(book, { content: "A passage", percent: 0.5 });
    fetch.mockResolvedValue(new Response("{}"));
    await bm.flushBookmaster();
    expect(fetch.mock.calls.at(-1)[0]).toBe("/api/bookmaster/quote");
    expect(values.get("bm-queue")).toEqual([]);
  });

  it("does not erase an entry appended by another tab during a flush", async () => {
    const head = queued("session", { at: 1 });
    const later = queued("session", { at: 2 });
    values.set("bm-queue", [head]);
    const started = deferred();
    const reply = deferred();
    fetch.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
    const flushing = bm.flushBookmaster();
    await started.promise;
    values.set("bm-queue", [head, later]);
    reply.resolve(new Response("{}"));
    await flushing;
    expect(values.get("bm-queue")).toEqual([later]);
  });

  it("keeps a newer progress replacement while an old one is in flight", async () => {
    values.set("bm-queue", [queued("progress", { percent: 10 })]);
    const started = deferred();
    const reply = deferred();
    fetch.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
    const flushing = bm.flushBookmaster();
    await started.promise;
    const newer = queued("progress", { percent: 20 });
    values.set("bm-queue", [newer]);
    reply.resolve(new Response("{}"));
    await flushing;
    expect(values.get("bm-queue")).toEqual([newer]);
  });

  it("waits for an active flush before sending newer progress", async () => {
    values.set("bm-queue", [queued("progress", { percent: 10 })]);
    const started = deferred();
    const reply = deferred();
    fetch.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
    const flushing = bm.flushBookmaster();
    await started.promise;
    const sync = bm.syncProgress(book, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    reply.resolve(new Response("{}"));
    await Promise.all([flushing, sync]);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).percent).toBe(50);
  });

  it("queues newer progress instead of overtaking a temporarily blocked replay", async () => {
    values.set("bm-queue", [queued("progress", { author: book.author, percent: 10 })]);
    fetch.mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValue(new Response("{}"));
    await bm.syncProgress(book, { force: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(values.get("bm-queue")).toHaveLength(1);
    expect(values.get("bm-queue")[0].body.percent).toBe(50);
    await bm.flushBookmaster();
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).percent).toBe(50);
    expect(values.get("bm-queue")).toEqual([]);
  });

  it("drops queued entries belonging to another account without posting them", async () => {
    values.set("bm-queue", [queued("quote", { username: "someone-else" })]);
    await bm.flushBookmaster();
    expect(fetch).not.toHaveBeenCalled();
    expect(values.get("bm-queue")).toEqual([]);
  });

  it("does not coalesce same-title books by different authors", async () => {
    await bm.syncProgress(book, { force: true });
    await bm.syncProgress({ ...book, author: "Someone Else" }, { force: true });
    expect(values.get("bm-queue")).toHaveLength(2);
  });

  it.each([408, 429, 500, 502, 503, 504])("queues transient HTTP %i responses", async (status) => {
    fetch.mockResolvedValue(new Response("{}", { status }));
    await bm.syncSession(book, sitting(1));
    expect(values.get("bm-queue")).toHaveLength(1);
    await bm.flushBookmaster();
    expect(values.get("bm-queue")).toHaveLength(1);
  });

  it("drops a permanently rejected entry and continues to the next", async () => {
    values.set("bm-queue", [queued("session", { at: 1 }), queued("session", { at: 2 })]);
    fetch.mockResolvedValueOnce(new Response("{}", { status: 400 })).mockResolvedValueOnce(new Response("{}"));
    await bm.flushBookmaster();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(values.get("bm-queue")).toEqual([]);
  });

  it("does not coalesce distinct pinned books with the same title", async () => {
    await bm.syncProgress({ ...book, bookmasterId: "one" }, { force: true });
    await bm.syncProgress({ ...book, bookmasterId: "two" }, { force: true });
    expect(values.get("bm-queue")).toHaveLength(2);
  });

  it("still keeps only the newest queued progress for the same book", async () => {
    await bm.syncProgress({ ...book, progress: { fraction: 0.1 } }, { force: true });
    await bm.syncProgress(book, { force: true });
    expect(values.get("bm-queue")).toHaveLength(1);
    expect(values.get("bm-queue")[0].body.percent).toBe(50);
  });

  it("clears queued pushes when unlinking", async () => {
    await bm.syncSession(book, sitting(1));
    await bm.bookmasterUnlink();
    expect(values.get("bm-queue")).toEqual([]);
    fetch.mockClear().mockResolvedValue(new Response("{}"));
    await bm.flushBookmaster();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not requeue a failed in-flight request after unlinking", async () => {
    const started = deferred();
    const reply = deferred();
    fetch.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
    const sync = bm.syncSession(book, sitting(1));
    await started.promise;
    await bm.bookmasterUnlink();
    reply.resolve(new Response("{}", { status: 503 }));
    await sync;
    expect(values.get("bm-queue")).toEqual([]);
  });
});
