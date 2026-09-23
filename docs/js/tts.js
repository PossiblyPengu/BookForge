/**
 * tts.js — read-aloud controller.
 *
 *   renderer.textBlocks()  ─►  Sentences  ─►  ahead[] (synthesising)  ─►  play
 *
 * - Sentences splits the renderer's blocks into sentence chunks, starting
 *   from what's on screen, one section at a time; renderer.advance() moves
 *   to the next section when one runs dry.
 * - For audio engines (piper, kokoro) the next few sentences are generated
 *   while the current one plays, then played through a single <audio>
 *   element — real media playback that survives the iOS lock screen and
 *   owns the Media Session controls.
 * - Web Speech (the speech engine) speaks sentences directly.
 *
 * A sentence that isn't heard is retried, never skipped; if the engine keeps
 * refusing, read-aloud pauses on it so the next tap on play retries it.
 */

import { $, toast, chunk } from "./util.js";
import {
  settings, loadSettings, saveSettings, currentEngine, silentWavUrl, web,
} from "./tts-engines.js";

export { chunk };

const LOOKAHEAD = 3; // sentences generated ahead of the one playing
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const asBlock = (v) => (typeof v === "string" ? { text: v } : v);

// --- iOS lock-screen plumbing ------------------------------------------------
// iOS keeps a page's JS alive while an <audio> element is playing. A silent
// loop holds the session through the gaps between clips (and under Web
// Speech, which isn't a media session at all). iOS ignores el.volume, so the
// keepalive must be truly silent samples.
const keepalive = {
  el: null,
  start() {
    if (!this.el) {
      this.el = new Audio();
      this.el.loop = true;
      this.el.preload = "auto";
    }
    this.el.src = silentWavUrl();
    this.el.play().catch(() => {});
  },
  stop() { try { this.el?.pause(); } catch { /* noop */ } },
};

// One persistent <audio> element for every generated clip. It's unlocked
// inside the tap by playing a silent clip; after that iOS lets play() run
// from async continuations.
const player = {
  el: null,
  url: null,
  item: null, // the sentence whose clip is loaded
  ensure() {
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = "auto";
    }
    return this.el;
  },
  unlock() {
    const el = this.ensure();
    this._release();
    el.src = silentWavUrl();
    el.play().catch(() => {});
  },
  play(item, blob, { onEnd, onFail }) {
    const el = this.ensure();
    this._release();
    this.url = URL.createObjectURL(blob);
    this.item = item;
    el.onended = () => { if (this.item === item) onEnd(); };
    el.onerror = () => { if (this.item === item) onFail(); };
    el.src = this.url;
    el.playbackRate = settings.rate;
    return el.play().catch(() => { if (this.item === item) onFail(); });
  },
  holds(item) { return !!this.el && this.item === item && !this.el.ended; },
  pause() { try { this.el?.pause(); } catch { /* noop */ } },
  resume() { return this.el ? this.el.play() : Promise.reject(new Error("no clip")); },
  progress() {
    const el = this.el;
    return el && el.duration > 0 && isFinite(el.duration) ? el.currentTime / el.duration : null;
  },
  stop() { this.pause(); this._release(); },
  _release() {
    if (this.el) { this.el.onended = null; this.el.onerror = null; }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.item = null;
  },
};

/**
 * Sentence stream over one section of the renderer. next() resolves to
 * { text, block, i } or null once the section is exhausted. Calls are
 * serialised, so concurrent pullers still get sentences in order.
 */
export class Sentences {
  constructor(renderer) {
    this.gen = renderer?.textBlocks?.() ?? null;
    this.done = !this.gen;
    this.pending = [];
    this._q = Promise.resolve();
  }
  next() {
    const p = this._q.then(() => this._next());
    this._q = p.catch(() => {});
    return p;
  }
  async _next() {
    while (!this.pending.length) {
      if (this.done) return null;
      const res = await this.gen.next().catch(() => ({ done: true }));
      if (res.done) { this.done = true; return null; }
      const block = asBlock(res.value);
      const chunks = chunk(String(block.text));
      // a block the page top cut through starts part-way in
      for (let i = Math.min(block.startChunk ?? 0, chunks.length); i < chunks.length; i++)
        this.pending.push({ text: chunks[i], block, i });
    }
    return this.pending.shift();
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
//
// `_session` identifies the live read-aloud session; every await re-checks
// it, so a stop/restart mid-await can't leave a second chain running.
// `_cur` is the sentence being voiced — replacing it (skip, pause, stop)
// makes the old sentence's completion callback stale.
export const ttsController = {
  playing: false,
  onStateChange: null,
  eng: web,
  _getRenderer: null,
  _session: null,
  _src: null,        // Sentences for the current section
  _ahead: [],        // pulled (and, for audio engines, synthesising) sentences
  _history: [],      // sentences voiced in this section, for skip-back
  _cur: null,        // sentence being voiced
  _resumeAt: null,   // sentence to voice when play is pressed again
  _pausedClip: null, // audio engines: sentence paused mid-clip
  _taking: false,    // _next is awaiting the next sentence
  _sleepAt: null,    // timestamp, "chapter", or null

  // settings passthroughs used by the settings screen
  init: loadSettings,
  get settings() { return settings; },
  saveSettings,

  async start(getRenderer, meta) {
    if (this._starting || this.playing) return; // double-tap during init
    if (this._session) this.stop();
    this._starting = true;
    this._getRenderer = getRenderer;
    this._meta = meta;
    try {
      // Everything iOS gates on a user gesture happens before the first await.
      const eng = currentEngine();
      if (eng.kind === "speech") eng.unlock();
      else player.unlock();
      keepalive.start();
      this._media(meta);
      await loadSettings();
      const r = this._renderer();
      r?.beginTts?.();
      const src = new Sentences(r);
      if (src.done) { toast("Nothing to read aloud here"); this.stop(); return; }
      const session = {};
      Object.assign(this, {
        _session: session, _src: src, _ahead: [], _history: [], _cur: null,
        _resumeAt: null, _pausedClip: null, _moved: false,
        _fails: 0, _empty: 0, _spoke: 0, _origin: r.bookmark?.() ?? null,
        eng: currentEngine(),
      });
      this._setPlaying(true);
      if (this.eng.kind === "audio" && !this.eng.ready()) {
        this._status("Loading voice…");
        const loading = this.eng.ensure((p) => this._downloadProgress(p));
        // Pin where reading starts now, at the tap. Loading a neural voice
        // can take a while (a first-use download), and the start position
        // used to be read only once it finished — so swiping while waiting
        // made read-aloud begin pages from where play was pressed.
        this._fill(1);
        try {
          await loading;
        } catch (err) {
          console.warn("neural voice failed to load, using device voice", err);
          toast("Neural voice couldn't load — using device voice", { error: true });
          this.eng = web;
        }
        if (this._session !== session) return;
      }
      this._next(session);
    } finally { this._starting = false; }
  },

  _renderer() { return this._getRenderer?.(); },

  _status(text) { const el = $("tts-status"); if (el) el.textContent = text; },
  _downloadProgress(p) {
    if (!p) return;
    this._status(p.total
      ? `Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`
      : "Downloading voice…");
  },

  _setPlaying(on) {
    this.playing = on;
    this.onStateChange?.(on);
    this._playbackState(on ? "playing" : "paused");
  },

  _media(meta) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta?.title || "Reading aloud",
        artist: meta?.author || "",
        album: meta?.title || "",
        artwork: meta?.cover ? [{ src: meta.cover, sizes: "512x512" }] : [],
      });
      const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* noop */ } };
      h("play", () => this.resume());
      h("pause", () => this.pause());
      h("previoustrack", () => this.skip(-1));
      h("nexttrack", () => this.skip(1));
    } catch { /* noop */ }
  },
  _playbackState(s) {
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = s; } catch { /* noop */ }
  },

  // --- the sentence queue ----------------------------------------------------

  // Top `_ahead` up to n sentences from the current section, starting
  // synthesis for each on audio engines. Serialised through the source.
  _fill(n) {
    const src = this._src;
    if (!src) return Promise.resolve();
    const run = async () => {
      while (this._src === src && this._ahead.length < n && !src.done) {
        const s = await src.next();
        if (this._src !== src || !s) break;
        this._prepare(s);
        this._ahead.push(s);
      }
    };
    this._filling = (this._filling || Promise.resolve()).then(run, run);
    return this._filling;
  },

  _prepare(s) {
    if (this.eng.kind === "audio" && !s.audio) {
      s.audio = this.eng.synth(s.text);
      s.audio.catch(() => {}); // surfaced when it's played
    }
  },

  // Next sentence to voice, advancing section by section as each runs dry.
  // Resolves null when the session ended (it has already been stopped).
  async _take(session) {
    for (;;) {
      await this._fill(1);
      if (this._session !== session) return null;
      if (this._ahead.length) {
        const s = this._ahead.shift();
        this._empty = 0;
        this._spoke++;
        this._fill(this.eng.kind === "audio" ? LOOKAHEAD : 1); // keep generating ahead
        return s;
      }
      const r = this._renderer();
      if (!r) { this.stop(); return null; }
      r.clearHighlight?.();
      if (this._sleepAt === "chapter") {
        toast("Sleep timer ended");
        this.stop();
        return null;
      }
      // Several sections in and not a word found: the book has no text
      // layer (a scan, a comic). Put the reader back where they were.
      if (!this._spoke && this._empty >= 6) {
        const origin = this._origin;
        toast("Nothing to read aloud here");
        this.stop();
        if (origin) r.gotoBookmark?.(origin);
        return null;
      }
      if (++this._empty > 40) { this.stop(); return null; }
      const more = await r.advance?.();
      if (this._session !== session) return null;
      if (!more) { this.stop(); return null; } // end of book
      await sleep(350); // let the renderer settle
      if (this._session !== session) return null;
      this._history = []; // the old section's elements are gone
      this._src = new Sentences(r);
      if (this._src.done) { this.stop(); return null; }
    }
  },

  async _next(session) {
    if (this._session !== session || this._taking) return;
    this._taking = true;
    let s;
    try { s = await this._take(session); }
    finally { if (this._session === session) this._taking = false; }
    if (s && this._session === session) this._voice(s, session);
  },

  // --- voicing one sentence ----------------------------------------------------

  _voice(s, session) {
    if (this._session !== session) return;
    // paused while this sentence was on its way — park it for resume()
    if (!this.playing) { this._resumeAt = s; return; }
    if (typeof this._sleepAt === "number" && Date.now() >= this._sleepAt) {
      toast("Sleep timer ended");
      return this.stop();
    }
    this._cur = s;
    s.done = false;
    if (this._history[this._history.length - 1] !== s) {
      this._history.push(s);
      // keep the last few clips for skip-back; drop older audio (memory)
      const old = this._history[this._history.length - 5];
      if (old) old.audio = null;
      if (this._history.length > 300) this._history.shift();
    }
    this._highlight(s);

    const done = (ok) => {
      if (this._cur !== s || this._session !== session) return; // superseded
      this._stopWordSync();
      if (ok) {
        s.done = true;
        this._fails = 0;
        this._cur = null;
        return this._next(session);
      }
      // Not heard. Never move past words that weren't spoken: retry this
      // sentence, and if the engine keeps refusing, pause right here so the
      // next tap on play (a user gesture iOS will honour) picks it up.
      s.audio = null;
      if (++this._fails >= 3) {
        this._fails = 0;
        this.pause();
        toast("Read-aloud couldn't play — tap play to try again", { error: true });
        return;
      }
      setTimeout(() => {
        if (this._cur !== s || !this.playing || this._session !== session) return;
        this._cur = null;
        this._voice(s, session);
      }, 400);
    };

    if (this.eng.kind === "audio") {
      this._status("Reading aloud");
      this._prepare(s);
      s.audio.then((blob) => {
        if (this._cur !== s || this._session !== session) return;
        if (!this.playing) { this._resumeAt = s; this._cur = null; return; }
        return player.play(s, blob, { onEnd: () => done(true), onFail: () => done(false) })
          .then(() => { if (this._cur === s) this._startWordSync(s); });
      }, () => done(false));
    } else {
      this._status("Reading aloud");
      web.speak(s.text, done, (ci, cl) => {
        if (this._cur === s && s.start != null) this._highlightWord(s, s.text.slice(ci, ci + cl), s.start + ci);
      });
    }
  },

  // --- highlighting --------------------------------------------------------

  _highlight(s) {
    const r = this._renderer();
    if (!r?.highlight) return;
    const b = s.block;
    const at = (b._at ||= []);
    // where to look for this sentence in the block: where it was found
    // before, else just past the previous sentence (or the resume offset)
    const from = at[s.i] ?? (s.i === (b.startChunk ?? 0) ? (b.hlFrom ?? 0) : (b._next ?? 0));
    const res = r.highlight(b, s.text, from);
    if (res) {
      at[s.i] = s.start = res.start;
      b._next = res.end;
    } else s.start = null;
  },

  _highlightWord(s, word, from) {
    if (!word.trim()) return;
    this._renderer()?.highlight?.(s.block, word, from);
  },

  // Audio clips carry no word timings. Estimate the word from how far
  // through the clip playback is — close enough to follow along with.
  _startWordSync(s) {
    this._stopWordSync();
    if (s.start == null || typeof requestAnimationFrame !== "function") return;
    const words = [...s.text.matchAll(/\S+/g)];
    if (words.length < 2) return;
    let last = -1;
    const tick = () => {
      if (this._cur !== s) return;
      const f = player.progress();
      if (f != null && this.playing) {
        const pos = f * s.text.length;
        let k = words.findIndex((w) => w.index + w[0].length > pos);
        if (k < 0) k = words.length - 1;
        if (k !== last) {
          last = k;
          this._highlightWord(s, words[k][0], s.start + words[k].index);
        }
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  },
  _stopWordSync() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  },

  // --- transport -----------------------------------------------------------

  /**
   * Skip to the previous/next sentence. Back from the first sentence of a
   * section restarts it.
   */
  skip(dir) {
    const session = this._session;
    const c = this._cur ?? this._pausedClip ?? this._resumeAt;
    if (!session || !c) return;
    const h = this._history;
    const idx = h.lastIndexOf(c);
    let to = null; // null → whatever comes next
    if (dir < 0) {
      to = idx > 0 ? h[idx - 1] : c;
      if (to !== c) {
        h.splice(idx - 1); // both get re-added as they're voiced again
        this._ahead.unshift(c);
      }
    }
    this._cur = null;
    this._pausedClip = null;
    this._stopWordSync();
    this._fails = 0;
    web.stop();
    player.stop();
    if (!this.playing) { this._resumeAt = to; return; }
    // Chrome drops a speak() issued in the same tick as cancel()
    setTimeout(() => {
      if (this._session !== session || this._cur) return;
      if (to) this._voice(to, session);
      else this._next(session);
    }, this.eng.kind === "speech" ? 60 : 0);
  },

  /** minutes → timestamp, "chapter" for end-of-section, null to clear */
  setSleep(v) {
    this._sleepAt = v === "chapter" ? "chapter" : v == null ? null : Date.now() + v * 60000;
  },

  // Audio clips pause and resume mid-sentence. Web Speech can't be trusted
  // to (pause() is a no-op on Android), so it's cancelled and the sentence
  // restarts on resume.
  pause() {
    if (!this.playing) return;
    const c = this._cur;
    this._stopWordSync();
    if (c && !c.done && this.eng.kind === "audio" && player.holds(c)) {
      player.pause();
      this._pausedClip = c;
    } else {
      if (c && !c.done) this._resumeAt = c;
      web.stop();
      player.stop();
    }
    this._cur = null;
    keepalive.stop();
    this._setPlaying(false);
  },

  /**
   * The reader navigated by hand (page turn, swipe, slider, contents).
   * While paused, that means "read from here" on the next play.
   */
  noteUserMove() {
    if (this._session && !this.playing) this._moved = true;
  },

  resume() {
    if (this.playing) return;
    if (!this._session) {
      if (this._getRenderer) this.start(this._getRenderer, this._meta);
      return;
    }
    // Turned the page while paused → read from what's on screen now rather
    // than dragging the reader back to where narration stopped.
    if (this._moved) {
      this.stop();
      this.start(this._getRenderer, this._meta);
      return;
    }
    const session = this._session;
    keepalive.start();
    this._setPlaying(true);
    const clip = this._pausedClip;
    this._pausedClip = null;
    if (clip) {
      // play() here runs inside the tap, which is what iOS wants
      this._cur = clip;
      player.resume().then(
        () => { if (this._cur === clip) this._startWordSync(clip); },
        () => { if (this._cur === clip) { this._cur = null; this._voice(clip, session); } },
      );
      return;
    }
    if (this.eng.kind === "speech") web.unlock();
    else player.unlock();
    const at = this._resumeAt;
    this._resumeAt = null;
    if (at) this._voice(at, session);
    else if (!this._taking && !this._cur) this._next(session);
  },

  toggle() {
    if (this.playing) this.pause();
    else this.resume();
  },

  stop() {
    Object.assign(this, {
      _session: null, playing: false, _src: null, _ahead: [], _history: [],
      _cur: null, _resumeAt: null, _pausedClip: null, _moved: false,
      _taking: false, _sleepAt: null,
    });
    this._stopWordSync();
    this._renderer()?.clearHighlight?.();
    web.stop();
    player.stop();
    keepalive.stop();
    this._playbackState("none");
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        for (const a of ["play", "pause", "previoustrack", "nexttrack"])
          navigator.mediaSession.setActionHandler(a, null);
      } catch { /* noop */ }
    }
    this.onStateChange?.(false);
  },
};

/** Play a clip outside a read-aloud session (voice previews). */
export const playClip = (blob) => new Promise((resolve) => {
  const item = {};
  player.play(item, blob, { onEnd: resolve, onFail: resolve });
});
export const stopClip = () => player.stop();
export const unlockClip = () => player.unlock();
