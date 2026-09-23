/**
 * tts-voices.js — voice picker, previews and the sleep-timer sheet.
 */

import { toast, listSheet, fmtBytes } from "./util.js";
import {
  settings, saveSettings, engineId, currentVoice, setCurrentVoice,
  web, piper, kokoro, KOKORO_VOICES,
} from "./tts-engines.js";
import { ttsController, playClip, stopClip, unlockClip } from "./tts.js";

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
  const id = engineId();
  if (id === "kokoro") {
    return KOKORO_VOICES.map(([value, name, sub]) => ({
      title: name, sub, value, checked: value === settings.kokoroVoice, rank: 0,
    }));
  }
  if (id === "piper") {
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
// Speaks a sample in a voice without committing to it. The voice is staged and
// rolled back, so backing out of the sheet leaves the saved voice untouched.

let previewing = null; // { setLabel } while a preview is running

export const stopPreview = () => {
  const p = previewing;
  previewing = null;
  web.stop();
  stopClip();
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
  const saved = currentVoice();
  const live = () => previewing === token;
  const id = engineId();
  setLabel("■");
  try {
    setCurrentVoice(value);
    if (id === "web") {
      web.unlock();
      await new Promise((res) => web.speak(SAMPLE_TEXT, res));
    } else {
      unlockClip(); // inside the tap, so iOS lets the clip play later
      const eng = id === "kokoro" ? kokoro : piper;
      await eng.ensure((p) => {
        if (live() && p?.total && !p.url?.startsWith("tts://"))
          setLabel(`${Math.round((p.loaded / p.total) * 100)}%`);
      });
      if (!live()) return;
      setLabel("…"); // synthesising
      const blob = await eng.synth(SAMPLE_TEXT);
      if (!live()) return;
      setLabel("■");
      await playClip(blob);
    }
  } catch (err) {
    console.warn("voice preview failed", err);
    if (live()) toast("Couldn't preview that voice", { error: true });
  } finally {
    setCurrentVoice(saved); // staged only — the pick is what commits
    if (live()) previewing = null;
    setLabel("▶");
  }
};

/** Friendly name of the voice currently in use, for the settings row. */
export const voiceLabel = async () => {
  const id = engineId();
  if (id === "kokoro") return KOKORO_VOICES.find(([v]) => v === settings.kokoroVoice)?.[1] || settings.kokoroVoice;
  if (id === "piper") {
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
  const note = engineId() === "web"
    ? "Tap ▶ to hear a voice."
    : "Tap ▶ to hear a voice. Each neural voice downloads once, then runs offline.";
  listSheet("Voice", items.map((item) => ({
    ...item,
    action: {
      label: "▶",
      title: `Preview ${item.title}`,
      onAction: (it, btn) => previewVoice(it.value, (t) => { btn.textContent = t; }),
    },
  })), async (val) => {
    stopPreview();
    setCurrentVoice(val);
    piper.reset(); // next ensure() loads the picked voice
    await saveSettings();
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
