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

import { $, toast, listSheet } from "./util.js";
import { kvGet, kvSet } from "./db.js";

const SETTINGS_KEY = "tts-settings";
const settings = { engine: "web", voiceURI: "", piperVoice: "en_US-lessac-medium", rate: 1 };

const chunk = (text, max = 240) => {
  const out = [];
  for (const piece of text.split(/(?<=[.!?…;:])\s+|(?<=\n)/)) {
    let p = piece.trim();
    while (p.length > max) {
      let cut = p.lastIndexOf(" ", max);
      if (cut < 40) cut = max;
      out.push(p.slice(0, cut));
      p = p.slice(cut);
    }
    if (p) out.push(p);
  }
  return out;
};

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
  speak(text, onDone, onBoundary) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = settings.rate;
    const v = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voiceURI);
    if (v) u.voice = v;
    let done = false;
    const finish = (cont) => {
      if (done) return;
      done = true;
      clearInterval(wd);
      onDone(cont);
    };
    // word-level sync where supported (Chrome; iOS Safari may never fire it)
    if (onBoundary) u.onboundary = (e) => {
      if (e.charIndex != null) onBoundary(e.charIndex, e.charLength || 0);
    };
    u.onend = () => finish(true);
    u.onerror = (e) => finish(e.error !== "interrupted" && e.error !== "canceled");
    speechSynthesis.resume(); // iOS can sit stuck in 'paused'
    speechSynthesis.speak(u);
    // Watchdog — in some environments (iOS standalone PWA) speak() silently
    // never starts. Don't hang: bail so the controller can surface it.
    const t0 = Date.now();
    const wd = setInterval(() => {
      if (speechSynthesis.paused) return; // legit pause — keep waiting
      const idle = !speechSynthesis.speaking && !speechSynthesis.pending;
      if ((idle && Date.now() - t0 > 3000) || Date.now() - t0 > 45000) {
        try { speechSynthesis.cancel(); } catch { /* noop */ }
        finish(false);
      }
    }, 500);
  },
  unlock() { try { speechSynthesis.resume(); } catch { /* noop */ } },
  stop() { try { speechSynthesis.cancel(); } catch { /* noop */ } },
  pause() { try { speechSynthesis.pause(); } catch { /* noop */ } },
  resume() { try { speechSynthesis.resume(); } catch { /* noop */ } },
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
      // TtsSession is a singleton — reset it when the voice changed so init()
      // actually loads the new model + config instead of reusing the old one.
      if (this.session && this.voiceId !== settings.piperVoice) {
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

  async speak(text, onDone, onProgress, isStale) {
    const session = await this.ensure(onProgress);
    const blob = await session.predict(text);
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
  pause() { this.el?.pause(); },
  resume() { this.el?.play().catch(() => {}); },
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export const ttsController = {
  playing: false,
  onStateChange: null,
  _getRenderer: null,
  _gen: null,
  _cancelled: false,
  _sleepAt: null, // timestamp, "chapter", or null

  async init() {
    Object.assign(settings, await kvGet(SETTINGS_KEY, {}));
  },
  get settings() { return settings; },
  async saveSettings() { await kvSet(SETTINGS_KEY, { ...settings }); },

  get engine() { return settings.engine === "piper" ? piper : web; },

  async start(getRenderer, meta) {
    if (this._starting || this.playing) return; // double-tap during init
    this._starting = true;
    this._getRenderer = getRenderer;
    this._meta = meta;
    this._cancelled = false;
    this._fails = 0;
    try {
      // unlock + start keepalive while still inside the tap's activation window
      this.engine.unlock?.();
      keepalive.start();
      this._media(meta);
      await this.init();
      this._gen = this._renderer()?.textBlocks?.();
      if (!this._gen) { toast("Nothing to read aloud here"); keepalive.stop(); return; }
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
      h("play", () => this.toggle());
      h("pause", () => this.toggle());
      h("previoustrack", () => this.skip(-1));
      h("nexttrack", () => this.skip(1));
    } catch { /* noop */ }
  },
  _playbackState(s) {
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = s; } catch { /* noop */ }
  },

  _renderer() { return this._getRenderer?.(); },

  async _next() {
    if (this._cancelled || !this.playing) return;
    const r = this._renderer();
    if (!r) return this.stop();
    const { value, done } = await this._gen.next().catch(() => ({ done: true }));
    if (this._cancelled) return;
    if (done) {
      r.clearHighlight?.();
      if (this._sleepAt === "chapter") {
        toast("Sleep timer ended");
        return this.stop();
      }
      // section exhausted — advance to next page/section if possible
      const more = await r.advance?.();
      if (more === false) return this.stop();
      await new Promise((res) => setTimeout(res, 350)); // let renderer settle
      this._gen = r.textBlocks?.();
      if (!this._gen) return this.stop();
      return this._next();
    }
    const block = typeof value === "string" ? { text: value } : value;
    this._hlFrom = 0;
    const chunks = chunk(String(block.text));
    this._speakChunks(chunks, 0, block);
  },

  _speakChunks(chunks, i, block) {
    if (this._cancelled || !this.playing || i >= chunks.length) {
      if (!this._cancelled && this.playing) this._next();
      return;
    }
    // timed sleep expires between chunks (and on 'end of chapter' in _next)
    if (typeof this._sleepAt === "number" && Date.now() >= this._sleepAt) {
      toast("Sleep timer ended");
      return this.stop();
    }
    const text = chunks[i];
    const cur = { chunks, i, block };
    this._cur = cur;
    const r = this._renderer();
    if (r?.highlight) {
      const res = r.highlight(block, text, this._hlFrom ?? 0);
      if (res) {
        this._hlFrom = res.end;
        this._chunkStart = res.start;
      }
    }
    const onDone = (cont) => {
      // stale callback (e.g. piper predict resolved after a skip) — ignore
      if (this._cancelled || this._cur !== cur) return;
      if (this._skipTo != null) { this._doSkip(); return; }
      if (cont) {
        this._fails = 0;
        this._speakChunks(chunks, i + 1, block);
      } else {
        // engine failed to produce sound — bail after a few silent chunks
        // instead of flipping through the whole book muted
        if (++this._fails >= 3) {
          toast("Speech isn't producing audio on this device", { error: true });
          return this.stop();
        }
        this._next();
      }
    };
    // word-level sync: narrow the highlight to the word being spoken.
    // charIndex is relative to this chunk — offset by where the chunk starts
    // in the block's joined text.
    const onBoundary = (ci, cl) => {
      const rr = this._renderer();
      if (rr?.highlight && this._chunkStart != null)
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
      piper.speak(text, onDone, onProgress, () => this._cur !== cur || this._cancelled).catch((err) => {
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

  /** Skip to the previous/next chunk within the current block. */
  skip(dir) {
    const c = this._cur;
    if (!c || this._skipTo != null || this._cancelled) return;
    const ni = Math.max(0, Math.min(c.chunks.length, c.i + dir));
    if (ni === c.i) return;
    this._skipTo = ni;
    this.engine.stop(); // web → fires onerror → onDone; piper → silent, handled below
    if (settings.engine === "piper") this._doSkip();
  },

  _doSkip() {
    const ni = this._skipTo;
    this._skipTo = null;
    const c = this._cur;
    if (!c) return;
    this._fails = 0;
    if (ni >= c.chunks.length) return this._next();
    this._speakChunks(c.chunks, ni, c.block);
  },

  /** minutes → timestamp, "chapter" for end-of-section, null to clear */
  setSleep(v) {
    this._sleepAt = v === "chapter" ? "chapter" : v == null ? null : Date.now() + v * 60000;
  },

  toggle() {
    if (this.playing) {
      this.playing = false;
      this.onStateChange?.(false);
      this._playbackState("paused");
      this.engine.pause();
      return;
    }
    // paused session → resume it; dead session (stopped) → start fresh
    if (this._gen && !this._cancelled) {
      this.playing = true;
      this.onStateChange?.(true);
      this._playbackState("playing");
      this.engine.resume();
    } else if (this._getRenderer) {
      this.start(this._getRenderer, this._meta);
    }
  },

  stop() {
    this._cancelled = true;
    this.playing = false;
    this._gen = null;
    this._cur = null;
    this._skipTo = null;
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
// Voice picker (settings + TTS bar)
// ---------------------------------------------------------------------------

export const listVoices = async () => {
  if (settings.engine === "piper") {
    try {
      const mod = await import("../vendor/piper/voices_static-D_OtJDHM.js");
      return Object.values(mod.default).map((v) => ({
        title: `${v.language?.name_english || ""} — ${v.name} (${v.quality})`.trim(),
        sub: v.key,
        checked: v.key === settings.piperVoice,
        value: v.key,
      }));
    } catch {
      return [];
    }
  }
  const voices = speechSynthesis.getVoices();
  return voices.map((v) => ({
    title: `${v.name} — ${v.lang}`,
    checked: v.voiceURI === settings.voiceURI,
    value: v.voiceURI,
  }));
};

export const pickVoice = async () => {
  const items = await listVoices();
  if (!items.length) { toast("No voices available"); return; }
  listSheet("Voice", items, async (val) => {
    if (settings.engine === "piper") settings.piperVoice = val;
    else settings.voiceURI = val;
    piper.session = null; // force re-init with new voice
    await ttsController.saveSettings();
    toast("Voice updated");
  }, { search: true });
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
