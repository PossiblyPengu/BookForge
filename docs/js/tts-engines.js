/**
 * tts-engines.js — speech backends for read-aloud, and their settings.
 *
 * Two shapes of engine:
 *   audio  — synth(text) → Promise<Blob>. The controller plays the clips
 *            through one <audio> element, which is real media playback:
 *            it keeps going on the iOS lock screen, drives the Media
 *            Session controls, and pauses/resumes mid-sentence.
 *              piper  — on-device VITS voices (WASM), ~2× faster than real
 *                       time even single-threaded in WebKit
 *              kokoro — higher quality, but only keeps up on WebGPU
 *   speech — speak(text, onDone, onBoundary) via speechSynthesis.
 *              web    — system voices, no download. iOS only speaks after
 *                       a user gesture and is unreliable in the background,
 *                       so it's the fallback there, not the default.
 */

import { kvGet, kvSet } from "./db.js";

const SETTINGS_KEY = "tts-settings";
export const settings = {
  v: 2,
  engine: "auto", // "auto" | "web" | "piper" | "kokoro"
  voiceURI: "",
  piperVoice: "en_US-lessac-medium",
  kokoroVoice: "af_heart",
  rate: 1,
};

let loaded = null;
export const loadSettings = () => (loaded ||= (async () => {
  const saved = await kvGet(SETTINGS_KEY, {});
  // v1 saved the whole object on any change, so engine "web" there was
  // almost always the old default rather than a choice. Move it to "auto".
  if (saved && saved.v !== 2 && saved.engine === "web") saved.engine = "auto";
  Object.assign(settings, saved, { v: 2 });
  if (settings.engine === "kokoro" && !kokoro.available()) settings.engine = "auto";
})());
export const saveSettings = () => kvSet(SETTINGS_KEY, { ...settings });

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** The engine "auto" stands for on this device. */
export const autoEngine = () => (isIOS() ? "piper" : "web");
export const engineId = () => (settings.engine === "auto" ? autoEngine() : settings.engine);
export const currentEngine = () => engines[engineId()] || web;

/** The saved voice for the engine in use (voiceURI / piper key / kokoro id). */
export const currentVoice = () => ({
  web: settings.voiceURI, piper: settings.piperVoice, kokoro: settings.kokoroVoice,
})[engineId()];
export const setCurrentVoice = (v) => {
  const id = engineId();
  if (id === "piper") settings.piperVoice = v;
  else if (id === "kokoro") settings.kokoroVoice = v;
  else settings.voiceURI = v;
};

// ---------------------------------------------------------------------------
// shared: a silent clip, used to unlock audio inside a tap and to keep the
// iOS audio session alive between clips
// ---------------------------------------------------------------------------
export const silentWavUrl = (() => {
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

// Synthesis is serialised (one ONNX session can't run two inferences at once)
// and memoised, so upcoming sentences generate while the current one plays
// and a replayed sentence (skip back, retry) doesn't pay for inference again.
const synthQueue = (predict, keyOf) => {
  let queue = Promise.resolve();
  const cache = new Map();
  return (text) => {
    const key = keyOf() + "\u0000" + text;
    let p = cache.get(key);
    if (!p) {
      p = queue = queue.catch(() => {}).then(() => predict(text));
      cache.set(key, p);
      p.catch(() => cache.delete(key));
      while (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return p;
  };
};

// ---------------------------------------------------------------------------
// Web Speech
// ---------------------------------------------------------------------------
export const web = {
  id: "web",
  kind: "speech",
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
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(wd);
      onDone(forced ?? ok);
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
    // Every error means the words weren't heard.
    u.onerror = () => finish(false);
    speechSynthesis.resume(); // iOS can sit stuck in 'paused'
    speechSynthesis.speak(u);
    // Watchdog — in some environments (iOS standalone PWA) speak() silently
    // never starts. Don't hang: bail so the controller can surface it. The
    // ceiling scales with the text and the rate; a flat one cut long chunks
    // off at slow rates.
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
      // Overran its budget: it was heard; move on rather than stall.
      else if (Date.now() - t0 > budget) forced = true;
      else return;
      try { speechSynthesis.cancel(); } catch { /* noop */ }
      finish(forced);
    }, 250);
  },
  // iOS only lets a page speak once speak() has been called inside a user
  // gesture. The real first sentence comes after async work, outside the
  // tap — so speak a silent one now, synchronously.
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
// Piper (lazy)
// ---------------------------------------------------------------------------
//
// ONNX Runtime holds a voice's weights in WebAssembly memory, which never
// shrinks, until the session is released; dropping the object gives nothing
// back. A session that's been replaced (another voice picked or previewed)
// is released as soon as nothing is synthesising with it, so its memory is
// reused by the next voice instead of piling up until iOS kills the page.
const busy = new Map(); // session → predictions in flight
const retired = new WeakSet();
const retire = async (session) => {
  if (!session || retired.has(session)) return;
  retired.add(session);
  if (!busy.get(session)) await session.release?.().catch(() => {});
};

export const piper = {
  id: "piper",
  kind: "audio",
  session: null,
  voiceId: null,
  loading: null,

  ready() { return !!this.session && this.voiceId === settings.piperVoice; },

  async ensure(onProgress) {
    if (this.ready()) return this.session;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import("../vendor/piper/piper-tts-web.js");
      // TtsSession is a singleton — reset it when the voice changed so create()
      // actually loads the new model + config instead of reusing the old one.
      // The old one is freed first (unless it's mid-sentence, then just
      // after), so two models aren't held at once.
      if (this.voiceId !== settings.piperVoice) {
        const old = this.session || mod.TtsSession._instance;
        mod.TtsSession._instance = null;
        this.session = null;
        await retire(old);
      }
      const wasmBase = new URL("../vendor/piper/", import.meta.url).href;
      const ortBase = new URL("../vendor/ort/", import.meta.url).href;
      const voiceId = settings.piperVoice;
      this.session = await mod.TtsSession.create({
        voiceId,
        wasmPaths: {
          onnxWasm: ortBase,
          piperWasm: wasmBase + "piper_phonemize.wasm",
          piperData: wasmBase + "piper_phonemize.data",
        },
        progress: onProgress,
      });
      this.voiceId = voiceId;
      return this.session;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  },

  synth: null, // set below — needs `piper` in scope
  /** Free the loaded model; the next ensure() loads the current voice. */
  reset() {
    const old = this.session;
    this.session = null;
    this.voiceId = null;
    return retire(old);
  },
};
piper.synth = synthQueue(
  async (text) => {
    let session = await piper.ensure();
    if (retired.has(session)) session = await piper.ensure(); // replaced meanwhile
    busy.set(session, (busy.get(session) || 0) + 1);
    try {
      return await session.predict(text);
    } finally {
      const n = busy.get(session) - 1;
      if (n) busy.set(session, n);
      else {
        busy.delete(session);
        if (retired.has(session)) session.release?.().catch(() => {});
      }
    }
  },
  () => settings.piperVoice,
);

// ---------------------------------------------------------------------------
// Kokoro (lazy). Offered only where WebGPU exists: on WASM it runs 3–4×
// slower than real time, which can't sustain read-aloud. Not on iPhone or
// iPad even with WebGPU (iOS 26): the fp32 model is ~330 MB, held once in
// JS and again on the GPU, which is past what iOS lets a web page use.
// ---------------------------------------------------------------------------
export const KOKORO_VOICES = [
  ["af_heart", "Heart", "American English · female"],
  ["af_bella", "Bella", "American English · female"],
  ["af_nicole", "Nicole", "American English · female"],
  ["am_michael", "Michael", "American English · male"],
  ["am_fenrir", "Fenrir", "American English · male"],
  ["bf_emma", "Emma", "British English · female"],
  ["bm_george", "George", "British English · male"],
];

export const kokoro = {
  id: "kokoro",
  kind: "audio",
  tts: null,
  loading: null,
  available: () => typeof navigator !== "undefined" && !!navigator.gpu && !isIOS(),
  ready() { return !!this.tts; },

  async ensure(onProgress) {
    if (this.tts) return this.tts;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import("../vendor/kokoro/kokoro.web.js");
      // self-hosted ONNX runtime: the CSP (and offline use) rule out its CDN
      mod.env.wasmPaths = new URL("../vendor/kokoro/", import.meta.url).href;
      const gpu = !!navigator.gpu;
      this.tts = await mod.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: gpu ? "fp32" : "q8",
        device: gpu ? "webgpu" : "wasm",
        progress_callback: (p) => {
          if (p?.status === "progress") onProgress?.({ url: p.file, loaded: p.loaded, total: p.total });
        },
      });
      return this.tts;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  },

  synth: null,
};
kokoro.synth = synthQueue(
  async (text) => {
    const tts = await kokoro.ensure();
    const audio = await tts.generate(text, { voice: settings.kokoroVoice });
    return audio.toBlob();
  },
  () => settings.kokoroVoice,
);

export const engines = { web, piper, kokoro };
