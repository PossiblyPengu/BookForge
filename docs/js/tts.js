/**
 * tts.js — read-aloud controller.
 *
 * Two engines:
 *   web   — speechSynthesis (iOS system voices; free; chunk-bounded for
 *           Safari's long-utterance watchdog)
 *   piper — on-device neural voices (WASM; model downloads once to OPFS)
 *
 * The controller pulls text blocks from the active renderer's
 * textBlocks() async generator, speaks them in order, and calls
 * renderer.advance() when the current section is exhausted.
 */

import { $, toast, listSheet, fmtBytes, chunk } from "./util.js";
import { kvGet, kvSet } from "./db.js";

export { chunk };

const SETTINGS_KEY = "tts-settings";
const settings = { engine: "web", voiceURI: "", piperVoice: "en_US-lessac-medium", rate: 1 };

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- iOS lock-screen plumbing ------------------------------------------------
// iOS keeps a page's JS alive while an <audio> element is playing — that's the
// only reliable way to keep chunk callbacks firing on the lock screen.
// speechSynthesis is not a media session and AudioContext suspends on lock,
// so a silent keepalive loop holds the session for web voices, and piper
// chunks play through a real <audio> element rather than Web Audio.
// (iOS ignores el.volume, so the keepalive must be truly silent samples.)

const silentWavUrl = (() => {
  let url = null;
  return () => {
    if (url) return url;
    const rate = 8000, n = Math.floor(rate * 0.25);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 2, true);
    url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    return url;
  };
})();

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

// ---------------------------------------------------------------------------
// Web Speech backend
// ---------------------------------------------------------------------------
const web = {
  _token: null, // the utterance whose watchdog is live
  speak(text, onDone, onBoundary) {
    const token = {};
    this._token = token;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = settings.rate;
    const v = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voiceURI);
    if (v) u.voice = v;
    let done = false;
    let started = false; // did this utterance ever actually produce speech?
    // The watchdog's cancel() re-enters via onerror in some engines; `forced`
    // makes sure the verdict it already reached is the one that is reported.
    let forced = null;
    const finish = (cont) => {
      if (done) return;
      done = true;
      clearInterval(wd);
      onDone(forced ?? cont);
    };
    u.onstart = () => { started = true; };
    // word-level sync where supported (Chrome; iOS Safari may never fire it)
    if (onBoundary) u.onboundary = (e) => {
      started = true;
      if (e.charIndex != null) onBoundary(e.charIndex, e.charLength || 0);
    };
    const queuedAt = Date.now();
    // iOS drops an utterance it won't play (no user activation, audio
    // session busy) by ending it at once without ever starting it. That is
    // not speech — counting it as spoken is how whole pages went by silently.
    u.onend = () => finish(started || Date.now() - queuedAt > 250);
    // Every error means the words weren't heard. (This used to report
    // not-allowed / audio-busy / synthesis-failed as success, so a refused
    // utterance advanced the book instead of being retried.)
    u.onerror = () => finish(false);
    speechSynthesis.resume(); // iOS can sit stuck in 'paused'
    speechSynthesis.speak(u);
    // Watchdog — in some environments (iOS standalone PWA) speak() silently
    // never starts. Don't hang: bail so the controller can surface it.
    //
    // The ceiling has to scale with the text and the rate. A flat 45s cut off
    // long chunks at slow rates mid-sentence and the controller counted that
    // as a failure, which is how whole passages went missing.
    const budget = 15000 + (text.length / Math.max(settings.rate, 0.1)) * 250;
    let t0 = Date.now();
    let pausedAt = 0;
    const wd = setInterval(() => {
      // A newer utterance owns the engine now. Its speaking/pending state
      // isn't ours to judge — acting on it would cancel the new utterance.
      if (web._token && web._token !== token) { clearInterval(wd); return; }
      if (speechSynthesis.paused) { // legit pause — keep waiting, don't age out
        if (!pausedAt) pausedAt = Date.now();
        return;
      }
      if (pausedAt) { t0 += Date.now() - pausedAt; pausedAt = 0; }
      if (speechSynthesis.speaking) started = true;
      const idle = !speechSynthesis.speaking && !speechSynthesis.pending;
      // Went quiet after speaking: a dropped 'end' event, not a mute engine.
      if (idle && Date.now() - t0 > 3000) forced = started;
      // Overran its budget: move on rather than re-reading or stalling.
      else if (Date.now() - t0 > budget) forced = true;
      else return;
      try { speechSynthesis.cancel(); } catch { /* noop */ }
      finish(forced);
    }, 250);
  },
  // iOS only lets a page speak once speak() has been called inside a user
  // gesture. The real first sentence comes after async work (settings,
  // renderer), outside the tap — so speak a silent one now, synchronously.
  unlock() {
    try {
      speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch { /* noop */ }
  },
  stop() { try { speechSynthesis.cancel(); } catch { /* noop */ } },
};

// ---------------------------------------------------------------------------
// Piper backend (lazy)
// ---------------------------------------------------------------------------
const piper = {
  session: null,
  el: null,
  loading: null,

  // A persistent <audio> element, unlocked inside the tap gesture by playing
  // a silent clip — after that, play() works from async continuations, and
  // real <audio> playback keeps going on the iOS lock screen (AudioContext
  // would suspend).
  ensureEl() {
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = "auto";
    }
    return this.el;
  },
  unlock() {
    const el = this.ensureEl();
    el.src = silentWavUrl();
    el.play().catch(() => {});
  },

  async ensure(onProgress) {
    if (this.session && this.voiceId === settings.piperVoice) return this.session;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import("../vendor/piper/piper-tts-web.js");
      // TtsSession is a singleton — reset it when the voice changed so create()
      // actually loads the new model + config instead of reusing the old one.
      // Keyed off voiceId, not this.session: picking a voice nulls the session
      // but the singleton survives, so gating on it kept the old voice.
      if (this.voiceId !== settings.piperVoice) {
        mod.TtsSession._instance = null;
        this.session = null;
      }
      const wasmBase = new URL("../vendor/piper/", import.meta.url).href;
      const ortBase = new URL("../vendor/ort/", import.meta.url).href;
      this.session = await mod.TtsSession.create({
        voiceId: settings.piperVoice,
        wasmPaths: {
          onnxWasm: ortBase,
          piperWasm: wasmBase + "piper_phonemize.wasm",
          piperData: wasmBase + "piper_phonemize.data",
        },
        progress: onProgress,
      });
      this.voiceId = settings.piperVoice;
      return this.session;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  },

  // Synthesis is serialised (one ORT session can't run two inferences at
  // once) and memoised, so the next sentence can be generated while this one
  // plays — otherwise every sentence boundary is a pause the length of an
  // inference — and a paused sentence restarts without re-synthesising.
  _queue: Promise.resolve(),
  _cache: new Map(),
  _synth(session, text) {
    const key = settings.piperVoice + "\u0000" + text;
    let p = this._cache.get(key);
    if (!p) {
      p = this._queue = this._queue.catch(() => {}).then(() => session.predict(text));
      this._cache.set(key, p);
      p.catch(() => this._cache.delete(key));
      while (this._cache.size > 6) this._cache.delete(this._cache.keys().next().value);
    }
    return p;
  },
  /** Warm the cache for upcoming text. Never triggers a model download. */
  prefetch(text) {
    if (!text || !this.session || this.voiceId !== settings.piperVoice) return;
    this._synth(this.session, text).catch(() => {});
  },

  async speak(text, onDone, onProgress, isStale) {
    const session = await this.ensure(onProgress);
    const blob = await this._synth(session, text);
    // stopped or superseded mid-predict (skip/stop) — don't play stale audio
    if (!this.session || isStale?.()) return; // dropped — don't speak over the new chunk
    const url = URL.createObjectURL(blob);
    const el = this.ensureEl();
    el.src = url;
    el.playbackRate = settings.rate;
    el.onended = () => { URL.revokeObjectURL(url); onDone(true); };
    el.onerror = () => { URL.revokeObjectURL(url); onDone(false); };
    await el.play().catch(() => { URL.revokeObjectURL(url); onDone(false); });
  },
  stop() {
    try { this.el?.pause(); } catch { /* noop */ }
  },
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
//
// One narration chain runs per session: _next pulls a block, _speakChunks
// speaks its chunks one by one, and each chunk's completion drives the next
// step. `_session` identifies the live session; every await re-checks it, so
// a stop/restart mid-await can't leave a second chain running. `_cur` is the
// chunk in flight — replacing it (skip, pause, stop) makes the old chunk's
// completion callback stale.
const asBlock = (v) => (typeof v === "string" ? { text: v } : v);

export const ttsController = {
  playing: false,
  onStateChange: null,
  _getRenderer: null,
  _gen: null,
  _session: null,   // token of the live session; null when stopped
  _cur: null,       // chunk in flight: { chunks, i, block, done }
  _resumeAt: null,  // chunk to pick up from after a pause
  _pulling: false,  // _next is awaiting the renderer
  _peek: null,      // look-ahead result of _gen.next(), consumed by _pull
  _history: [],     // blocks started in the current section, for skip-back
  _sleepAt: null,   // timestamp, "chapter", or null

  async init() {
    Object.assign(settings, await kvGet(SETTINGS_KEY, {}));
  },
  get settings() { return settings; },
  async saveSettings() { await kvSet(SETTINGS_KEY, { ...settings }); },

  get engine() { return settings.engine === "piper" ? piper : web; },

  async start(getRenderer, meta) {
    if (this._starting || this.playing) return; // double-tap during init
    if (this._session) this.stop();
    this._starting = true;
    this._getRenderer = getRenderer;
    this._meta = meta;
    this._fails = 0;
    this._empty = 0;
    this._spoke = 0;
    try {
      // unlock + start keepalive while still inside the tap's activation window
      this.engine.unlock?.();
      keepalive.start();
      this._media(meta);
      await this.init();
      const r = this._renderer();
      // let the renderer forget what a previous session already spoke, so
      // re-reading a chapter (or restarting after a jump) works
      r?.beginTts?.();
      const gen = r?.textBlocks?.();
      if (!gen) { toast("Nothing to read aloud here"); this.stop(); return; }
      this._session = {};
      this._gen = gen;
      this._peek = null;
      this._history = [];
      this._origin = r.bookmark?.() ?? null;
      this._moved = false;
      this.playing = true;
      this.onStateChange?.(true);
      this._playbackState("playing");
      this._next();
    } finally { this._starting = false; }
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

  _renderer() { return this._getRenderer?.(); },

  async _next() {
    const session = this._session;
    if (!session) return;
    const r = this._renderer();
    if (!r) return this.stop();
    this._pulling = true;
    let block;
    try { block = await this._pull(r, session); }
    finally { if (this._session === session) this._pulling = false; }
    if (!block || this._session !== session) return;
    this._spoke++;
    const chunks = chunk(String(block.text));
    this._history.push({ chunks, block });
    if (this._history.length > 50) this._history.shift();
    // a block the page top cut through starts part-way in
    this._hlFrom = block.hlFrom ?? 0;
    this._speakChunks(chunks, Math.min(block.startChunk ?? 0, chunks.length), block);
  },

  // Next speakable block, advancing section by section as each runs dry.
  // Returns null when the session ended (it has already been stopped).
  async _pull(r, session) {
    for (;;) {
      const res = await (this._peek || this._gen.next()).catch(() => ({ done: true }));
      this._peek = null;
      if (this._session !== session) return null;
      if (!res.done) { this._empty = 0; return asBlock(res.value); }
      r.clearHighlight?.();
      if (this._sleepAt === "chapter") {
        toast("Sleep timer ended");
        this.stop();
        return null;
      }
      // Several sections in and not a word spoken: the book has no text
      // layer (a scan, a comic). Put the reader back where they were rather
      // than leave them pages away from it.
      if (!this._spoke && this._empty >= 6) {
        const origin = this._origin;
        toast("Nothing to read aloud here");
        this.stop();
        if (origin) r.gotoBookmark?.(origin);
        return null;
      }
      if (++this._empty > 40) { this.stop(); return null; } // nothing speakable left
      const more = await r.advance?.();
      if (this._session !== session) return null;
      if (!more) { this.stop(); return null; }
      await sleep(350); // let the renderer settle
      if (this._session !== session) return null;
      this._history = []; // the old section's elements are gone
      this._gen = r.textBlocks?.();
      if (!this._gen) { this.stop(); return null; }
    }
  },

  // Pull the next block early and synthesise its first chunk, so a neural
  // voice doesn't go quiet at every paragraph break.
  _lookahead() {
    if (this._peek || !this._gen) return;
    const session = this._session;
    this._peek = this._gen.next().catch(() => ({ done: true }));
    this._peek.then((res) => {
      if (this._session !== session || res.done) return;
      const b = asBlock(res.value);
      piper.prefetch(chunk(String(b.text))[b.startChunk ?? 0]);
    });
  },

  _speakChunks(chunks, i, block) {
    const session = this._session;
    if (!session) return;
    if (i >= chunks.length) return this._next();
    // paused while this step was pending — park it for resume()
    if (!this.playing) { this._resumeAt = { chunks, i, block }; return; }
    // timed sleep expires between chunks (and on 'end of chapter' in _pull)
    if (typeof this._sleepAt === "number" && Date.now() >= this._sleepAt) {
      toast("Sleep timer ended");
      return this.stop();
    }
    const text = chunks[i];
    const cur = { chunks, i, block, done: false };
    this._cur = cur;
    // where each chunk sits in the block, so skip-back and resume re-find it
    const at = (block._at ||= []);
    if (at[i] != null) this._hlFrom = at[i];
    this._chunkStart = null;
    const res = this._renderer()?.highlight?.(block, text, this._hlFrom ?? 0);
    if (res) {
      this._hlFrom = res.end;
      this._chunkStart = at[i] = res.start;
    }
    const onDone = (ok) => {
      if (this._cur !== cur) return; // superseded by a skip, pause or stop
      if (ok) {
        cur.done = true;
        this._fails = 0;
        return this._speakChunks(chunks, i + 1, block);
      }
      // Not heard. Never move past words that weren't spoken: retry this
      // sentence, and if the engine keeps refusing, pause right here so the
      // next tap on play (a user gesture iOS will honour) picks it up.
      if (++this._fails >= 3) {
        this._fails = 0;
        this.pause();
        toast("Read-aloud couldn't play — tap play to try again", { error: true });
        return;
      }
      setTimeout(() => {
        if (this._cur !== cur || !this.playing) return;
        this._cur = null;
        this._speakChunks(chunks, i, block);
      }, 400);
    };
    // word-level sync: narrow the highlight to the word being spoken.
    // charIndex is relative to this chunk — offset by where the chunk starts
    // in the block's joined text.
    const onBoundary = (ci, cl) => {
      const rr = this._renderer();
      if (this._cur === cur && rr?.highlight && this._chunkStart != null)
        rr.highlight(block, text.slice(ci, ci + cl), this._chunkStart + ci);
    };
    const onProgress = (p) => {
      const el = $("tts-status");
      if (!el || p == null) return;
      // piper reports {url, loaded, total}; tts:// marks inference progress
      if (p.url?.startsWith("tts://"))
        el.textContent = `Generating… ${p.loaded}/${p.total}`;
      else if (p.total)
        el.textContent = `Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`;
      else el.textContent = "Downloading voice…";
    };
    if (settings.engine === "piper") {
      piper.speak(text, onDone, onProgress, () => this._cur !== cur)
        .then(() => {
          // playing now — generate what comes next while it does
          if (this._cur !== cur) return;
          if (i + 1 < chunks.length) piper.prefetch(chunks[i + 1]);
          else this._lookahead();
        })
        .catch((err) => {
          if (this._cur !== cur) return;
          console.warn("piper failed, falling back to device voice", err);
          toast("Neural voice failed — using device voice", { error: true });
          settings.engine = "web";
          this._speakChunks(chunks, i, block);
        });
    } else {
      web.speak(text, onDone, onBoundary);
    }
    $("tts-status").textContent = settings.engine === "piper" ? "Neural voice" : "Reading aloud";
  },

  /**
   * Skip to the previous/next sentence. Crosses into the neighbouring
   * paragraph at either end; back at the very first one it restarts it.
   */
  skip(dir) {
    const session = this._session;
    const c = this._cur ?? this._resumeAt;
    if (!session || !c) return;
    let to = { chunks: c.chunks, i: c.i + dir, block: c.block };
    if (to.i < 0) {
      const h = this._history;
      if (h.length > 1 && h[h.length - 1].block === c.block) {
        h.pop();
        const p = h[h.length - 1];
        to = { chunks: p.chunks, i: p.chunks.length - 1, block: p.block };
      } else to.i = 0;
    }
    if (to.i >= to.chunks.length) to = null; // past the end → next paragraph
    this._cur = null; // the interrupted chunk's completion is now stale
    this._fails = 0;
    web.stop();
    piper.stop();
    if (!this.playing) { this._resumeAt = to; return; }
    // Chrome drops a speak() issued in the same tick as cancel()
    setTimeout(() => {
      if (this._session !== session || this._cur) return;
      if (to) this._speakChunks(to.chunks, to.i, to.block);
      else this._next();
    }, settings.engine === "web" ? 60 : 0);
  },

  /** minutes → timestamp, "chapter" for end-of-section, null to clear */
  setSleep(v) {
    this._sleepAt = v === "chapter" ? "chapter" : v == null ? null : Date.now() + v * 60000;
  },

  // Pausing cancels the utterance and resume() restarts that sentence.
  // speechSynthesis.pause() is a no-op on Android and unreliable elsewhere,
  // and a stalled chain couldn't be restarted by resuming the engine.
  pause() {
    if (!this.playing) return;
    this.playing = false;
    const c = this._cur;
    if (c && !c.done) this._resumeAt = c;
    this._cur = null;
    web.stop();
    piper.stop();
    keepalive.stop();
    this.onStateChange?.(false);
    this._playbackState("paused");
  },

  /**
   * The reader navigated by hand (page turn, swipe, slider, contents).
   * While paused, that means "read from here" on the next play. Only
   * explicit navigation counts — comparing positions misfired whenever iOS
   * resized the viewport and the paginator re-laid out the page.
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
    this.playing = true;
    keepalive.start();
    this.engine.unlock?.();
    this.onStateChange?.(true);
    this._playbackState("playing");
    const at = this._resumeAt;
    this._resumeAt = null;
    if (at) {
      if (at.block._at?.[at.i] != null) this._hlFrom = at.block._at[at.i];
      this._speakChunks(at.chunks, at.i, at.block);
    } else if (!this._pulling && !this._cur) {
      this._next();
    }
  },

  toggle() {
    if (this.playing) this.pause();
    else this.resume();
  },

  stop() {
    this._session = null;
    this.playing = false;
    this._gen = null;
    this._peek = null;
    this._cur = null;
    this._resumeAt = null;
    this._moved = false;
    this._pulling = false;
    this._history = [];
    this._sleepAt = null;
    this._renderer()?.clearHighlight?.();
    web.stop();
    piper.stop();
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

// ---------------------------------------------------------------------------
// Voice picker
// ---------------------------------------------------------------------------

const SAMPLE_TEXT =
  "Chapter one. The lamplight fell across the open page, and the story began.";

const uiLang = () => navigator.language || "en-US";
const normLang = (l) => String(l || "").replace(/_/g, "-").toLowerCase();
const baseLang = (l) => normLang(l).split("-")[0];

let displayNames;
const langLabel = (code) => {
  const c = normLang(code);
  if (!c) return "";
  try {
    displayNames ||= new Intl.DisplayNames([uiLang()], { type: "language" });
    return displayNames.of(c) || c;
  } catch { return c; }
};

// Voices the reader is most likely to want first: exact locale, then same
// language, then everything else alphabetically.
const byRelevance = (a, b) =>
  a.rank - b.rank || a.title.localeCompare(b.title);
const rankLang = (lang) =>
  normLang(lang) === normLang(uiLang()) ? 0 : baseLang(lang) === baseLang(uiLang()) ? 1 : 2;

// getVoices() is empty until the engine has enumerated them, which on iOS
// happens after first paint — wait briefly rather than showing "no voices".
const webVoices = () => new Promise((resolve) => {
  const have = speechSynthesis.getVoices();
  if (have.length) return resolve(have);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve(speechSynthesis.getVoices());
  };
  speechSynthesis.addEventListener?.("voiceschanged", finish, { once: true });
  setTimeout(finish, 1500);
});

const piperCatalog = async () => {
  const mod = await import("../vendor/piper/voices_static-D_OtJDHM.js");
  return Object.values(mod.default);
};

const piperStored = async () => {
  try {
    const mod = await import("../vendor/piper/piper-tts-web.js");
    return new Set(await mod.stored());
  } catch { return new Set(); }
};

const piperSize = (v) =>
  Object.values(v.files || {}).reduce((n, f) => n + (f.size_bytes || 0), 0);

export const listVoices = async () => {
  if (settings.engine === "piper") {
    try {
      const [list, stored] = await Promise.all([piperCatalog(), piperStored()]);
      return list.map((v) => ({
        title: `${v.name} · ${v.quality}`,
        sub: [langLabel(v.language?.code), v.language?.country_english, fmtBytes(piperSize(v))]
          .filter(Boolean).join(" · "),
        badge: stored.has(v.key) ? "On device" : "",
        checked: v.key === settings.piperVoice,
        value: v.key,
        rank: rankLang(v.language?.code),
      })).sort(byRelevance);
    } catch {
      return [];
    }
  }
  const voices = await webVoices();
  return voices.map((v) => ({
    title: v.name,
    sub: [langLabel(v.lang), v.localService ? "On device" : "Online"]
      .filter(Boolean).join(" · "),
    badge: v.default ? "System" : "",
    checked: v.voiceURI === settings.voiceURI,
    value: v.voiceURI,
    rank: rankLang(v.lang),
  })).sort(byRelevance);
};

// --- preview ----------------------------------------------------------------
// Speaks a sample in a voice without committing to it. Settings are staged and
// rolled back, so backing out of the sheet leaves the saved voice untouched.

let previewing = null; // { setLabel } while a preview is running

export const stopPreview = () => {
  const p = previewing;
  previewing = null;
  web.stop();
  piper.stop();
  p?.setLabel("▶");
};

export const previewVoice = async (value, setLabel = () => {}) => {
  if (ttsController.playing) {
    toast("Pause read-aloud to preview a voice");
    return;
  }
  if (previewing) { // second tap on the playing row (or a switch) stops it
    const same = previewing.setLabel === setLabel;
    stopPreview();
    if (same) return;
  }
  const token = { setLabel };
  previewing = token;
  const saved = { voiceURI: settings.voiceURI, piperVoice: settings.piperVoice };
  const live = () => previewing === token;
  setLabel("■");
  try {
    if (settings.engine === "piper") {
      settings.piperVoice = value;
      await piper.ensure((p) => {
        if (live() && p?.total && !p.url?.startsWith("tts://"))
          setLabel(`${Math.round((p.loaded / p.total) * 100)}%`);
      });
      if (!live()) return;
      setLabel("…"); // synthesising
      await new Promise((res) => {
        piper.speak(SAMPLE_TEXT, res, null, () => !live()).catch(res);
      });
    } else {
      settings.voiceURI = value;
      web.unlock();
      await new Promise((res) => web.speak(SAMPLE_TEXT, res));
    }
  } catch (err) {
    console.warn("voice preview failed", err);
    if (live()) toast("Couldn't preview that voice", { error: true });
  } finally {
    Object.assign(settings, saved); // staged only — the pick is what commits
    if (live()) previewing = null;
    setLabel("▶");
  }
};

/** Friendly name of the voice currently in use, for the settings row. */
export const voiceLabel = async () => {
  if (settings.engine === "piper") {
    try {
      const v = (await piperCatalog()).find((x) => x.key === settings.piperVoice);
      return v ? `${v.name} · ${v.quality}` : settings.piperVoice;
    } catch { return settings.piperVoice; }
  }
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === settings.voiceURI);
  return v ? v.name : "Default";
};

export const pickVoice = async () => {
  const items = await listVoices();
  if (!items.length) { toast("No voices available"); return; }
  const note = settings.engine === "piper"
    ? "Tap ▶ to hear a voice. Each neural voice downloads once, then runs offline."
    : "Tap ▶ to hear a voice.";
  listSheet("Voice", items.map((item) => ({
    ...item,
    action: {
      label: "▶",
      title: `Preview ${item.title}`,
      onAction: (it, btn) => previewVoice(it.value, (t) => { btn.textContent = t; }),
    },
  })), async (val) => {
    stopPreview();
    if (settings.engine === "piper") settings.piperVoice = val;
    else settings.voiceURI = val;
    piper.session = null; // force re-init with the new voice
    await ttsController.saveSettings();
    toast("Voice updated");
  }, { search: true, note, onClose: stopPreview });
};

export const pickTtsSleep = () => {
  const active = ttsController._sleepAt;
  listSheet("Sleep timer", [
    { title: "Off", value: null, checked: active == null },
    { title: "End of chapter", value: "chapter", checked: active === "chapter" },
    { title: "5 minutes", value: 5 },
    { title: "15 minutes", value: 15 },
    { title: "30 minutes", value: 30 },
    { title: "45 minutes", value: 45 },
    { title: "60 minutes", value: 60 },
  ], (v) => {
    ttsController.setSleep(v);
    toast(v == null ? "Sleep timer off" : v === "chapter" ? "Stops at end of chapter" : `Sleeping in ${v} min`);
  });
};
