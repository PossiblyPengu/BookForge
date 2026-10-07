/**
 * app.js — boot, tab routing, settings, mini-player.
 */

import {
  $, initSheets, toast, fmtBytes, fillCover, listSheet, closeSheet, isSheetOpen,
  isIOS, isStandalone, confirmSheet,
} from "./util.js";
import { kvGet, kvSet, storageEstimate, orphanedFiles, deleteFiles } from "./db.js";
import {
  initLibrary, refreshLibrary, wireImportUI, initDetail, initEditSheet,
  checkSharedFiles, wireFileHandler, initContinue, initSelect, isSelecting,
  resumeBook, shrinkOversizedCovers,
} from "./library.js";
import { initReader, openReader } from "./reader.js";
import { initPlayer, openPlayer, playerState, reopenPlayer, closePlayer } from "./player.js";
import { ttsController } from "./tts.js";
import { initStats } from "./stats.js";
import {
  pickVoice, voiceLabel, previewVoice, stopPreview, savedVoices, openSavedVoices, watchSavedVoices,
} from "./tts-voices.js";
import { currentVoice, kokoro, piper } from "./tts-engines.js";
import { deliverBackup, restoreBackup } from "./backup.js";
import {
  bookmasterLink, bookmasterUnlink, bookmasterUser, finishBookmasterLink, initPresence,
} from "./bookmaster.js";
import { bmPull } from "./bm-pull.js";
import { VERSION, BUILD } from "./version.js";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

let oledOn = false;
const applyTheme = (mode) => {
  const dark = mode === "dark" ||
    (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = !dark ? "light" : oledOn ? "black" : "dark";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", { light: "#f6f1e8", dark: "#171411", black: "#000000" }[theme]);
  window.dispatchEvent(new Event("app-theme-change"));
};

const initTheme = async () => {
  oledOn = await kvGet("app-oled", false);
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

  const oledVal = $("set-oled-val");
  const showOled = () => { oledVal.textContent = oledOn ? "On" : "Off"; };
  showOled();
  $("set-oled").addEventListener("click", async () => {
    oledOn = !oledOn;
    await kvSet("app-oled", oledOn);
    showOled();
    applyTheme(await kvGet("app-theme", "auto"));
  });
};

// ---------------------------------------------------------------------------
// Help: install, shortcuts, credits
// ---------------------------------------------------------------------------

// Chromium fires this when the app is installable; iOS never does, so there
// the row explains Add to Home Screen instead.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const state = $("set-install-state");
  if (state) state.textContent = "Install";
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  const state = $("set-install-state");
  if (state) state.textContent = "Installed";
});

const showInstallHelp = async () => {
  if (isStandalone()) {
    listSheet("Already installed", [{ title: "OK", value: true }], () => {}, {
      note: "Pageturner is running as an installed app on this device.",
    });
    return;
  }
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    prompt.prompt();
    const { outcome } = await prompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    if (outcome !== "accepted") installPrompt = prompt; // they may try again
    return;
  }
  const steps = isIOS()
    ? [
      { title: "1 · Open this page in Safari", sub: "Other iOS browsers can’t add to the Home Screen" },
      { title: "2 · Tap the Share button", sub: "The square with an arrow, in the toolbar" },
      { title: "3 · Choose “Add to Home Screen”", sub: "Scroll the share sheet to find it" },
      { title: "4 · Open Pageturner from your Home Screen", sub: "It then runs full-screen and offline" },
    ]
    : [
      { title: "Look for the install icon in the address bar", sub: "Chrome, Edge and Brave show one on installable sites" },
      { title: "Or open the browser menu", sub: "“Install app”, or “Add to Home screen” on Android" },
    ];
  listSheet("Install Pageturner", steps.map((s) => ({ ...s, value: null })), () => {}, {
    note: "Installing gives you a Home Screen icon, full-screen reading and offline access. Your library is stored on the device either way.",
  });
};

const SHORTCUTS = [
  { keys: "← →", what: "Turn the page", where: "Reading" },
  { keys: "Space", what: "Next page", where: "Reading" },
  { keys: "F  or  /", what: "Search this book", where: "Reading" },
  { keys: "T", what: "Table of contents", where: "Reading" },
  { keys: "B", what: "Bookmark this page", where: "Reading" },
  { keys: "+  −", what: "Text size", where: "Reading" },
  { keys: "Esc", what: "Close the sheet, then the book", where: "Reading" },
  { keys: "/", what: "Search the library", where: "Library" },
  { keys: "Esc", what: "Leave selection mode", where: "Library" },
  { keys: "Space", what: "Play or pause", where: "Audiobook" },
  { keys: "Esc", what: "Close the player", where: "Audiobook" },
];

const showShortcuts = () =>
  listSheet("Keyboard shortcuts", SHORTCUTS.map((s) => ({
    title: s.what, sub: s.where, badge: s.keys, value: null,
  })), () => {}, { note: "Shortcuts apply to whichever screen you're on." });

const CREDITS = [
  { title: "foliate-js", sub: "EPUB, MOBI/AZW3, FB2 and comic rendering · MIT", url: "https://github.com/johnfactotum/foliate-js" },
  { title: "PDF.js", sub: "PDF rendering · Apache-2.0", url: "https://github.com/mozilla/pdf.js" },
  { title: "piper-tts-web", sub: "On-device neural voices · MIT", url: "https://github.com/Mintplex-Labs/piper-tts-web" },
  { title: "ONNX Runtime Web", sub: "Neural voice inference · MIT", url: "https://github.com/microsoft/onnxruntime" },
  { title: "music-metadata", sub: "Audio tags and chapters · MIT", url: "https://github.com/Borewit/music-metadata" },
  { title: "node-unrar-js", sub: "CBR comic extraction · MIT", url: "https://github.com/YuJianrong/node-unrar.js" },
  { title: "fflate", sub: "Zip reading and writing · MIT", url: "https://github.com/101arrowz/fflate" },
  { title: "Google Books · Open Library", sub: "Book metadata and cover lookup", url: "https://openlibrary.org" },
];

const showCredits = () =>
  listSheet("Credits & licences", CREDITS.map((c) => ({
    title: c.title, sub: c.sub, value: c.url,
  })), (url) => { if (url) window.open(url, "_blank", "noopener"); }, {
    note: "Pageturner is built on these open-source projects. Every engine is bundled with the app, so nothing about your reading is sent anywhere.",
  });

/**
 * Everything downloaded on demand and re-downloadable, across the three
 * places the engines put it:
 *   pageturner-runtime-*             lazily fetched vendor files (SW cache)
 *   transformers-cache/kokoro-voices the HQ voice model (~330 MB)
 *   OPFS /piper                      Piper voice models (~60 MB each)
 * The app-shell cache is deliberately excluded — dropping it would break
 * offline until the next online visit.
 */
const RECLAIMABLE_CACHES = (name) =>
  /^pageturner-runtime-/.test(name) || name === "pageturner-engines" || name === "pageturner-voices"
  || name === "transformers-cache" || name === "kokoro-voices";

const opfsPiperDir = async (create = false) => {
  const root = await navigator.storage?.getDirectory?.();
  if (!root) return null;
  return root.getDirectoryHandle("piper", { create }).catch(() => null);
};

const reclaimableBytes = async () => {
  let bytes = 0;
  for (const name of (await caches?.keys?.()) || []) {
    if (!RECLAIMABLE_CACHES(name)) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      const len = Number(res.headers.get("content-length"));
      bytes += Number.isFinite(len) && len > 0
        ? len
        : (await res.clone().blob().catch(() => null))?.size || 0;
    }
  }
  const dir = await opfsPiperDir();
  if (dir?.values) {
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      bytes += (await entry.getFile().catch(() => null))?.size || 0;
    }
  }
  return bytes;
};

const reclaim = async () => {
  // a voice file pulled out from under a playing session would stall it
  ttsController.stop();
  // and a live session would otherwise keep thinking its voice is ready
  // while the cache it loaded from is gone — drop it before clearing
  piper.reset();
  const names = ((await caches?.keys?.()) || []).filter(RECLAIMABLE_CACHES);
  await Promise.all(names.map((n) => caches.delete(n)));
  const root = await navigator.storage?.getDirectory?.().catch(() => null);
  await root?.removeEntry?.("piper", { recursive: true }).catch(() => {});
};

let onSettingsShown = () => {}; // set by initHelp, called by showView

const initHelp = async () => {
  $("set-install").addEventListener("click", showInstallHelp);
  if (isStandalone()) $("set-install-state").textContent = "Installed";
  // the welcome screen offers installing too, until it's done
  $("empty-install-btn").hidden = isStandalone();
  $("empty-install-btn").addEventListener("click", showInstallHelp);

  // shortcuts only mean something with a keyboard
  const hasKeyboard = !window.matchMedia?.("(pointer: coarse)").matches;
  $("set-shortcuts").hidden = !hasKeyboard;
  $("set-shortcuts").addEventListener("click", showShortcuts);
  $("set-credits").addEventListener("click", showCredits);

  const sizeEl = $("set-free-space-val");
  const showSize = async () => {
    const bytes = await reclaimableBytes().catch(() => null);
    sizeEl.textContent = bytes == null ? "—" : bytes ? fmtBytes(bytes) : "Nothing to clear";
  };
  // sizing can mean reading files tens of MB each (engine files cached
  // without a length), so only when Settings is open, not at every launch
  onSettingsShown = showSize;
  $("set-free-space").addEventListener("click", async () => {
    const bytes = await reclaimableBytes().catch(() => 0);
    if (!bytes) { toast("Nothing cached to clear"); return; }
    listSheet(`Free up ${fmtBytes(bytes)}?`, [
      { title: "Clear downloaded engines and voices", value: true },
    ], async (ok) => {
      if (!ok) return;
      await reclaim();
      toast(`Freed ${fmtBytes(bytes)}`);
      showSize();
    }, { note: "Books, covers and reading positions are not affected. A voice you use again downloads once more." });
  });

  // Repair: file data in IndexedDB that no book references — interrupted
  // restores and an old deleteBook bug both left these behind.
  const repairVal = $("set-repair-val");
  const countOrphans = async () => {
    const orphans = await orphanedFiles().catch(() => []);
    repairVal.textContent = orphans.length
      ? fmtBytes(orphans.reduce((n, f) => n + (f.size || f.blob?.size || 0), 0))
      : "Clean";
    return orphans;
  };
  $("set-repair").addEventListener("click", async () => {
    repairVal.textContent = "…";
    const orphans = await countOrphans();
    if (!orphans.length) return;
    const bytes = fmtBytes(orphans.reduce((n, f) => n + (f.size || f.blob?.size || 0), 0));
    listSheet(`Remove ${orphans.length} orphaned file${orphans.length === 1 ? "" : "s"} (${bytes})?`, [
      { title: "Repair storage", value: true },
    ], async (ok) => {
      if (!ok) { repairVal.textContent = "—"; return; }
      await deleteFiles(orphans.map((f) => f.key));
      toast(`Repaired storage — freed ${bytes}`);
      repairVal.textContent = "Clean";
      await showStorageHealth();
    }, { note: "These are file leftovers no book in your library points at. Books are not affected." });
  });
  // cheap enough to scan when Settings opens, like the cache size above
  onSettingsShown = () => { showSize(); countOrphans().catch(() => {}); };
};

// ---------------------------------------------------------------------------
// Storage health
// ---------------------------------------------------------------------------

/**
 * The library is the only copy of these books. Two things can lose it and
 * both are invisible by default: the browser evicting non-persistent storage
 * under pressure, and hitting the quota (imports then fail). Say so, and
 * point at the backup that fixes it.
 */
const showStorageHealth = async () => {
  const est = await storageEstimate();
  const row = $("set-storage");
  const note = $("set-storage-note");
  if (!est) {
    row.textContent = "Unknown";
    return;
  }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const used = est.quota ? est.usage / est.quota : 0;
  row.textContent = `${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}`;
  row.classList.toggle("list-value-warn", used > 0.85);

  const messages = [];
  if (used > 0.85) {
    messages.push(`Storage is ${Math.round(used * 100)}% full — imports may start failing. ` +
      "Free up space below, or remove a few books.");
  }
  if (!persisted) {
    messages.push("This browser hasn’t granted persistent storage, so it may clear your " +
      "library if the device runs low on space. Installing the app usually grants it; " +
      "either way, an exported backup is the safe copy.");
  }
  note.textContent = messages.join(" ");
  note.hidden = !messages.length;
};

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

const initSettings = async () => {
  await ttsController.init();
  const s = ttsController.settings;

  const eng = $("set-tts-engine");
  // the high-quality voice only keeps up on WebGPU — don't offer it elsewhere,
  // but say so rather than leaving the choice mysteriously absent
  const hq = eng.querySelector("[data-val=kokoro]");
  if (hq) hq.hidden = !kokoro.available();
  if (!kokoro.available()) {
    $("tts-engine-note").textContent +=
      " The HQ engine isn't offered on this device: it needs WebGPU, and its ~330 MB model is more than iOS lets a page hold.";
  }
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

  // A stepper rather than a slider: speed is picked from a handful of values,
  // and a slider plus a separate readout row took two rows to say one thing.
  const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
  const showRate = () => {
    $("set-tts-rate-val").textContent = `${+s.rate.toFixed(2)}×`;
    $("set-tts-rate-down").disabled = s.rate <= RATE_STEPS[0] + 0.001;
    $("set-tts-rate-up").disabled = s.rate >= RATE_STEPS.at(-1) - 0.001;
  };
  const stepRate = (dir) => {
    // from an in-between value (older builds allowed any), step to the
    // nearest mark in the direction pressed
    const next = dir > 0
      ? RATE_STEPS.find((r) => r > s.rate + 0.001)
      : [...RATE_STEPS].reverse().find((r) => r < s.rate - 0.001);
    if (next == null) return;
    s.rate = next;
    ttsController.saveSettings();
    showRate();
  };
  $("set-tts-rate-down").addEventListener("click", () => stepRate(-1));
  $("set-tts-rate-up").addEventListener("click", () => stepRate(1));
  showRate();

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

  // how many neural voices are kept on this device, and how much room they take
  const updateSaved = async () => {
    const saved = await savedVoices().catch(() => []);
    const bytes = saved.reduce((n, v) => n + v.bytes, 0);
    $("set-voices-saved-val").textContent = saved.length
      ? `${saved.length} · ${fmtBytes(bytes)}` : "None";
    updateVoiceLabel();
  };
  watchSavedVoices(updateSaved);
  updateSaved();
  $("set-voices-saved").addEventListener("click", () => { stopPreview(); openSavedVoices(); });

  // metadata lookups are the app's only outbound calls — this is the switch
  const metaVal = $("set-meta-online-val");
  const showMetaOnline = async () => {
    metaVal.textContent = (await kvGet("meta-online", true)) ? "On" : "Off";
  };
  showMetaOnline();
  $("set-meta-online").addEventListener("click", async () => {
    await kvSet("meta-online", !(await kvGet("meta-online", true)));
    showMetaOnline();
  });

  // BookMaster progress sync — Off hands off to BookMaster's pair flow;
  // linked shows the account and asks before unlinking
  const bmVal = $("set-bookmaster-val");
  const showBookmaster = async () => {
    const u = await bookmasterUser();
    bmVal.textContent = u?.username ? `Linked as ${u.display_name || u.username}` : "Off";
  };
  showBookmaster();
  $("set-bookmaster").addEventListener("click", async () => {
    if (!(await bookmasterUser())?.username) { bookmasterLink(); return; }
    confirmSheet("Unlink BookMaster?", "Unlink", async () => {
      await bookmasterUnlink();
      showBookmaster();
      toast("BookMaster unlinked");
    });
  });

  // The build this copy of the app was released as, and — when they differ —
  // the one the service worker is still serving, so an installed app can be
  // checked against the latest deploy.
  $("set-version").textContent = `${VERSION} (build ${BUILD})`;
  caches?.keys?.().then((keys) => {
    const served = keys
      .map((k) => Number(k.match(/^pageturner-cache-v(\d+)$/)?.[1]))
      .find(Number.isFinite);
    if (served && served !== BUILD)
      $("set-version").textContent = `${VERSION} (build ${served} → ${BUILD})`;
  }).catch(() => {});

  // Layout diagnostics for the iOS standalone viewport bug — only shown when
  // it could matter, so we can see what the device measured.
  if (navigator.standalone || window.matchMedia("(display-mode: standalone)").matches) {
    const el = $("set-version");
    const show = () => {
      const base = el.textContent.replace(/ · ih.*$/, "");
      el.textContent = `${base} · ih ${window.innerHeight} sh ${window.screen.height} chin ${getComputedStyle(document.documentElement).getPropertyValue("--chin").trim()}`;
    };
    show();
    setTimeout(show, 1600);
  }

  await showStorageHealth();

  // library backup / restore
  $("backup-export").addEventListener("click", async () => {
    showRestoring("Preparing backup…");
    try { await deliverBackup(showRestoring); }
    catch (err) { console.error(err); toast(err.message || "Export failed", { error: true, ms: 6000 }); }
    finally { hideRestoring(); }
  });
  const backupInput = $("backup-input");
  $("backup-import").addEventListener("click", () => backupInput.click());
  backupInput.addEventListener("change", async () => {
    const f = backupInput.files?.[0];
    backupInput.value = "";
    if (!f) return;
    // A restore merges by book id: same-id books, and every saved setting,
    // are overwritten. That's rarely what someone expects from "restore", so
    // say it before doing it.
    listSheet("Restore this backup?", [
      { title: "Restore", sub: f.name, value: true },
    ], async (ok) => {
      if (!ok) return;
      showRestoring("Restoring…");
      try {
        const { books, skipped } = await restoreBackup(f, showRestoring);
        await refreshLibrary();
        await showStorageHealth();
        toast(`Restored ${books} book${books === 1 ? "" : "s"}`
          + (skipped ? ` · ${skipped} skipped (file missing from the backup)` : ""), { ms: 6000 });
      } catch (err) {
        console.error(err);
        toast(err.message || "Restore failed", { error: true, ms: 6000 });
      } finally {
        hideRestoring();
      }
    }, {
      note: "Books added since the backup are kept. Books saved in the backup replace "
        + "the copies here, including their reading positions, and your settings are "
        + "restored too.",
    });
  });
};

// A restore reads and writes the whole library, which is slow enough on a
// phone to look like nothing is happening.
let restoringEl = null;
const showRestoring = (msg) => {
  if (!restoringEl) {
    restoringEl = document.createElement("div");
    restoringEl.className = "import-progress";
    restoringEl.setAttribute("role", "status");
    restoringEl.innerHTML = '<div class="spinner"></div><span></span>';
    document.body.appendChild(restoringEl);
  }
  restoringEl.querySelector("span").textContent = msg;
};
const hideRestoring = () => { restoringEl?.remove(); restoringEl = null; };

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const VIEWS = { library: "view-library", settings: "view-settings" };
// where each tab was scrolled to — leaving and returning keeps your place
const viewScroll = new Map();
let currentView = null;

const showView = (name) => {
  if (name !== "settings") stopPreview();
  document.querySelectorAll(".tab-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));

  // read the outgoing view's scroll before hiding it — display:none reads 0
  if (currentView && currentView !== name && VIEWS[currentView]) {
    const body = $(VIEWS[currentView]).querySelector(".view-body");
    if (body) viewScroll.set(currentView, body.scrollTop);
  }
  for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== name;

  const incoming = $(VIEWS[name]);
  if (incoming) {
    const body = incoming.querySelector(".view-body");
    if (body && viewScroll.has(name)) body.scrollTop = viewScroll.get(name);
    // .view-enter stays on once set — display:none→flex replays the enter
    // animation on later arrivals, so the first paint (no previous view,
    // nothing to crossfade from) is the only one that mustn't animate
    if (currentView && currentView !== name) incoming.classList.add("view-enter");
  }
  currentView = name;
  if (name === "settings") onSettingsShown();
};

// ---------------------------------------------------------------------------
// Mini player (shown when audio session is alive but player view closed)
// ---------------------------------------------------------------------------

let miniBookId = null;
const updateMini = () => {
  const st = playerState();
  const mini = $("mini-player");
  const playerOpen = !$("view-player").hidden;
  if (!st.book || playerOpen) { mini.hidden = true; return; }
  mini.hidden = false;
  $("mini-title").textContent = st.book.title;
  $("mini-sub").textContent = st.chapter || st.book.author || "Audiobook";
  $("mini-fill").style.width = `${(st.fraction * 100).toFixed(2)}%`;
  // this runs on every timeupdate — only rebuild the cover when the book changes
  if (miniBookId !== st.book.id) {
    miniBookId = st.book.id;
    fillCover($("mini-cover"), st.book);
  }
  $("mini-play").innerHTML = st.playing
    ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
};

// ---------------------------------------------------------------------------
// Open a book — reader or player
// ---------------------------------------------------------------------------

const openBook = async (book, opts = {}) => {
  if (book.kind === "audio") {
    await openPlayer(book, { onClose: () => { refreshLibrary(); updateMini(); }, onUpdate: updateMini });
  } else {
    await openReader(book, {
      onClose: () => { refreshLibrary(); updateMini(); },
      autoListen: opts.listen,
    });
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Keyboard, outside the reader (which owns its own keys while open)
// ---------------------------------------------------------------------------

const initKeyboard = () => {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("view-reader").hidden) return; // reader.js handles keys there
    const typing = e.target?.matches?.("input, textarea, select, [contenteditable]");

    if (e.key === "Escape") {
      if (isSheetOpen()) closeSheet();
      else if (!$("view-player").hidden) closePlayer();
      else if (isSelecting()) $("select-done").click();
      else if (typing) e.target.blur();
      return;
    }
    if (typing || isSheetOpen()) return;

    // player transport
    if (!$("view-player").hidden) {
      const st = playerState();
      if (e.key === " ") { e.preventDefault(); st.toggle?.(); }
      return;
    }
    // library: "/" jumps to the search box, the way it does on the web
    if (e.key === "/") {
      e.preventDefault();
      $("library-search").focus();
      $("library-search").select();
    }
  });
};

const boot = async () => {
  document.documentElement.dataset.theme = "dark"; // flash of correct bg
  // ask the OS not to evict our IndexedDB library under storage pressure
  navigator.storage?.persist?.().catch(() => {});
  // one bad init used to kill the whole boot — degrade, don't die
  const step = async (name, fn) => {
    try { await fn(); }
    catch (err) { console.error(`init failed: ${name}`, err); }
  };
  await step("sheets", initSheets);
  await step("library", () => initLibrary(openBook));
  await step("detail", initDetail);
  await step("edit", initEditSheet);
  await step("continue", initContinue);
  await step("select", initSelect);
  await step("import", wireImportUI);
  await step("theme", initTheme);
  await step("reader", initReader);
  await step("player", initPlayer);
  // a BookMaster pair redirect lands back here with ?bm-link=<code> —
  // redeem it before settings init reads the link state for its row
  await step("bookmaster link", finishBookmasterLink);
  // then pull the shelf back down — status, ratings, remote positions —
  // and repaint once the merge lands; a no-op when unlinked
  bmPull().then((c) => { if (c?.books) refreshLibrary(); }).catch(() => {});
  // and tell the suite where this device is — a beat now, one every 45s,
  // a "leaving" when the page goes away
  initPresence();
  await step("stats", initStats);
  await step("settings", initSettings);
  await step("help", initHelp);
  await step("keyboard", initKeyboard);
  await step("refresh", refreshLibrary);
  await step("shared files", checkSharedFiles);
  await step("file handler", wireFileHandler);

  // "Continue Reading" shortcut → reopen the most recent book
  const params = new URLSearchParams(location.search);
  if (params.get("continue")) {
    history.replaceState(null, "", location.pathname);
    const book = await resumeBook().catch(() => null);
    if (book) openBook(book);
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

  // older libraries can hold print-size covers — shrink them once, off-path
  setTimeout(() => {
    shrinkOversizedCovers().catch((err) => console.warn("cover shrink pass failed", err));
  }, 2000);
};

boot().catch((err) => {
  console.error("Boot failed:", err);
  toast("Failed to start — reload the app", { error: true, ms: 8000 });
});
