import { describe, it, expect, vi } from "vitest";
import { registerAudioOwner, claimAudio } from "../docs/js/audio-focus.js";

describe("audio focus", () => {
  it("pauses the other owners and leaves the claimant alone", () => {
    const tts = vi.fn();
    const book = vi.fn();
    registerAudioOwner("read-aloud", tts);
    registerAudioOwner("audiobook", book);

    claimAudio("audiobook");
    expect(tts).toHaveBeenCalledTimes(1);
    expect(book).not.toHaveBeenCalled();

    claimAudio("read-aloud");
    expect(book).toHaveBeenCalledTimes(1);
    expect(tts).toHaveBeenCalledTimes(1);
  });

  it("re-registering replaces the old pause function", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerAudioOwner("thing", first);
    registerAudioOwner("thing", second);
    claimAudio("someone-else");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  // one owner throwing must not leave the rest playing
  it("keeps going when an owner throws", () => {
    const after = vi.fn();
    registerAudioOwner("broken", () => { throw new Error("nope"); });
    registerAudioOwner("fine", after);
    expect(() => claimAudio("claimant")).not.toThrow();
    expect(after).toHaveBeenCalled();
  });

  it("claiming for an unregistered id still quietens everything", () => {
    const a = vi.fn();
    registerAudioOwner("a", a);
    claimAudio("not-registered");
    expect(a).toHaveBeenCalled();
  });
});
