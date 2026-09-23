/**
 * app.js — boot, tab routing, settings, mini-player.
 */

import { $, initSheets, toast, fmtBytes, coverUrl } from "./util.js";
import { kvGet, kvSet, storageEstimate, allBooks } from "./db.js";
import {
  initLibrary, refreshLibrary, wireImportUI, initDetail, initEditSheet,
  checkSharedFiles,
} from "./library.js";
import { initReader, openReader } from "./reader.js";
import { initPlayer, openPlayer, playerState, reopenPlayer } from "./player.js";
import { ttsController } from "./tts.js";
import { pickVoice, voiceLabel, previewVoice, stopPreview } from "./tts-voices.js";
import { currentVoice, kokoro } from "./tts-engines.js";
import { deliverBackup, restoreBackup } from "./backup.js";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const applyTheme = (mode) => {
  const dark = mode === "dark" ||
    (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#111110" : "#f2f2f0");
};

const initTheme = async () => {
  const mode = await kvGet("app-theme", "auto");
  applyTheme(mode);
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => kvGet("app-theme", "auto").then((m) => m === "auto" && applyTheme("auto")));
  const seg = $("set-theme");
  seg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.val === mode);
    b.addEventListener("click", async () => {
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      await kvSet("app-theme", b.dataset.val);
      applyTheme(b.dataset.val);
    });
  });
};

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

const initSettings = async () => {
  await ttsController.init();
  const s = ttsController.settings;

  const eng = $("set-tts-engine");
  // the high-quality voice only keeps up on WebGPU — don't offer it elsewhere
  const hq = eng.querySelector("[data-val=kokoro]");
  if (hq) hq.hidden = !kokoro.available();
  eng.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.val === s.engine);
    b.addEventListener("click", async () => {
      eng.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      stopPreview(); // the other engine's voices are a different set
      s.engine = b.dataset.val;
      await ttsController.saveSettings();
      updateVoiceLabel();
    });
  });

  const rate = $("set-tts-rate");
  rate.value = s.rate;
  $("set-tts-rate-val").textContent = `${s.rate}×`;
  rate.addEventListener("input", () => {
    s.rate = parseFloat(rate.value);
    $("set-tts-rate-val").textContent = `${s.rate}×`;
    ttsController.saveSettings();
  });

  $("set-tts-voice").addEventListener("click", async () => {
    stopPreview();
    await pickVoice();
    updateVoiceLabel();
  });

  // hear the current voice at the current speed without opening the picker
  const previewState = $("set-tts-preview-state");
  $("set-tts-preview").addEventListener("click", () =>
    previewVoice(currentVoice(), (t) => { previewState.textContent = t; }));

  const updateVoiceLabel = async () => {
    $("set-tts-voice-name").textContent = await voiceLabel();
  };
  speechSynthesis.onvoiceschanged = updateVoiceLabel;
  updateVoiceLabel();

  // Show which build the service worker is serving, so an installed app
  // can be checked against the latest deploy.
  caches?.keys?.().then((keys) => {
    const build = keys.map((k) => k.match(/^pageturner-cache-v(\d+)$/)?.[1]).find(Boolean);
    if (build) $("set-version").textContent = `2.0.0 (build ${build})`;
  }).catch(() => {});

  const est = await storageEstimate();
  if (est) {
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    $("set-storage").textContent =
      `${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}${persisted ? " · persistent" : ""}`;
  }

  // library backup / restore
  $("backup-export").addEventListener("click", async () => {
    try { await deliverBackup(); }
    catch (err) { console.error(err); toast("Export failed", { error: true }); }
  });
  const backupInput = $("backup-input");
  $("backup-import").addEventListener("click", () => backupInput.click());
  backupInput.addEventListener("change", async () => {
    const f = backupInput.files?.[0];
    backupInput.value = "";
    if (!f) return;
    try {
      const n = await restoreBackup(f);
      await refreshLibrary();
      toast(`Restored ${n} book${n === 1 ? "" : "s"}`);
    } catch (err) {
      console.error(err);
      toast(err.message || "Restore failed", { error: true });
    }
  });
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const VIEWS = { library: "view-library", settings: "view-settings" };
const showView = (name) => {
  if (name !== "settings") stopPreview();
  document.querySelectorAll(".tab-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== name;
};

// ---------------------------------------------------------------------------
// Mini player (shown when audio session is alive but player view closed)
// ---------------------------------------------------------------------------

const updateMini = () => {
  const st = playerState();
  const mini = $("mini-player");
  const playerOpen = !$("view-player").hidden;
  if (!st.book || playerOpen) { mini.hidden = true; return; }
  mini.hidden = false;
  $("mini-title").textContent = st.book.title;
  $("mini-sub").textContent = st.book.author || "Audiobook";
  const mc = $("mini-cover");
  mc.textContent = "";
  const url = coverUrl(st.book);
  if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; mc.appendChild(img); }
  $("mini-play").innerHTML = st.playing
    ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
};

// ---------------------------------------------------------------------------
// Open a book — reader or player
// ---------------------------------------------------------------------------

const openBook = async (book) => {
  if (book.kind === "audio") {
    await openPlayer(book, { onClose: () => { refreshLibrary(); updateMini(); }, onUpdate: updateMini });
  } else {
    await openReader(book, { onClose: () => { refreshLibrary(); updateMini(); } });
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const boot = async () => {
  document.documentElement.dataset.theme = "dark"; // flash of correct bg
  // ask the OS not to evict our IndexedDB library under storage pressure
  navigator.storage?.persist?.().catch(() => {});
  initSheets();
  await initLibrary(openBook);
  initDetail();
  initEditSheet();
  wireImportUI();
  await initTheme();
  await initReader();
  initPlayer();
  await initSettings();
  await refreshLibrary();
  await checkSharedFiles();

  // "Continue Reading" shortcut → reopen the most recent book
  const params = new URLSearchParams(location.search);
  if (params.get("continue")) {
    history.replaceState(null, "", location.pathname);
    const [last] = await allBooks();
    if (last) openBook(last);
  }

  document.querySelectorAll(".tab-item").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));
  showView("library");

  $("mini-player").addEventListener("click", (e) => {
    if (e.target.closest("#mini-play")) return;
    reopenPlayer();
    updateMini();
  });
  $("mini-play").addEventListener("click", () => playerState().toggle?.());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateMini();
  });
};

boot().catch((err) => {
  console.error("Boot failed:", err);
  toast("Failed to start — reload the app", { error: true, ms: 8000 });
});
