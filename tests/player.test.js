import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../docs/js/db.js", () => ({ getFile: vi.fn(async () => new Blob(["audio"])), putBook: vi.fn(async () => {}), kvGet: vi.fn(async () => null), kvSet: vi.fn(async () => {}) }));
vi.mock("../docs/js/bookmaster.js", () => ({ syncProgress: vi.fn(), syncSession: vi.fn() }));
vi.mock("../docs/js/bm-pull.js", () => ({ offerRemoteResume: vi.fn() }));
vi.mock("../docs/js/stats.js", () => ({ recordSession: vi.fn() }));
vi.mock("../docs/js/audio-focus.js", () => ({ registerAudioOwner: vi.fn(), claimAudio: vi.fn() }));
vi.mock("../docs/js/util.js", async (original) => {
  const actual = await original();
  return { ...actual, $: () => ({ addEventListener: vi.fn(), classList: { add() {}, remove() {}, toggle() {} }, style: { removeProperty() {}, setProperty() {} } }), fillCover: vi.fn(), coverTint: vi.fn(async () => null), onPageHidden: vi.fn() };
});
import { putBook } from "../docs/js/db.js";
import { syncProgress } from "../docs/js/bookmaster.js";
import { onPageHidden } from "../docs/js/util.js";

let audio, player, book, pageHidden;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", new globalThis.EventTarget());
  vi.stubGlobal("Audio", class extends globalThis.EventTarget {
    constructor() { super(); audio = this; this.currentTime = 0; this.duration = 100; this.readyState = 1; this.paused = true; this.playbackRate = 1; }
    async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  });
  player = await import("../docs/js/player.js");
  player.initPlayer();
  book = { id: "audio", title: "Audio", fileKey: "file", audio: { durationSec: 100 }, progress: { fraction: 0 } };
  await player.openPlayer(book);
  pageHidden = onPageHidden.mock.calls[0][0];
  vi.clearAllMocks();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("audiobook checkpoints", () => {
  it("saves throughout uninterrupted timeupdate events", async () => {
    for (let i = 1; i <= 20; i++) { audio.currentTime = i; audio.dispatchEvent(new Event("timeupdate")); await vi.advanceTimersByTimeAsync(250); }
    expect(putBook).toHaveBeenCalledTimes(2);
    expect(book.progress.positionSec).toBe(16);
  });

  it("captures the current playhead before forced pause sync", () => {
    audio.currentTime = 42;
    audio.pause();
    expect(putBook).toHaveBeenCalledOnce();
    expect(book.progress).toEqual({ fraction: 0.42, positionSec: 42 });
    expect(syncProgress).toHaveBeenCalledWith(book, { force: true });
  });

  it("captures hidden-page position even without a pending timeupdate", () => {
    audio.currentTime = 32;
    pageHidden();
    expect(putBook).toHaveBeenCalledOnce();
    expect(book.progress.positionSec).toBe(32);
  });
});
