/**
 * player.js — audiobook player.
 *
 * Handles single-file books with embedded chapters (m4b) and multi-file
 * books (mp3 folder imports grouped at import time). Tracks a global
 * position across files, integrates MediaSession for lock-screen
 * controls, and persists progress.
 */

import { $, fmtDuration, debounce, listSheet, coverUrl, toast } from "./util.js";
import { getFile, putBook, kvGet, kvSet } from "./db.js";

const audio = new Audio();
audio.preload = "auto";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [
  { title: "Off", value: 0 },
  { title: "5 minutes", value: 5 },
  { title: "15 minutes", value: 15 },
  { title: "30 minutes", value: 30 },
  { title: "45 minutes", value: 45 },
  { title: "60 minutes", value: 60 },
  { title: "End of chapter", value: -1 },
];

const player = {
  book: null,
  urls: [],          // blob URL per file
  fileStarts: [],    // cumulative start offset per fileIndex
  fileIndex: 0,
  chapters: [],      // {title, fileIndex, start, end, globalStart}
  duration: 0,
  sleepAt: null,     // timestamp ms or 'chapter'
  onClose: null,
  onUpdate: null,    // for mini-player
};

const savePos = debounce(async () => {
  const b = player.book;
  if (!b) return;
  b.progress = { fraction: player.duration ? position() / player.duration : 0, positionSec: position() };
  b.lastOpenedAt = Date.now();
  await putBook(b);
}, 2000);

const position = () =>
  (player.fileStarts[player.fileIndex] || 0) + (audio.currentTime || 0);

const currentChapter = () => {
  const pos = position();
  let cur = null;
  for (const ch of player.chapters) {
    if (ch.globalStart <= pos + 0.5) cur = ch; else break;
  }
  return cur;
};

const setIcon = (id, playing) => {
  $(id).innerHTML = playing
    ? '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
};

let seekPreview = null; // slider value while dragging — don't fight the user

const updateUI = () => {
  const pos = position();
  const dur = player.duration || audio.duration || 0;
  if (seekPreview == null) {
    $("player-slider").value = dur ? Math.round((pos / dur) * 1000) : 0;
    $("player-elapsed").textContent = fmtDuration(pos);
  }
  $("player-remaining").textContent = "-" + fmtDuration(Math.max(0, dur - pos));
  const ch = currentChapter();
  $("player-chapter-name").textContent = ch?.title || "—";
  setIcon("player-play", !audio.paused);
  try { navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing"; } catch { /* noop */ }
  player.onUpdate?.();
};

const loadFile = async (i, offset = 0, autoplay = false) => {
  player.fileIndex = i;
  audio.src = player.urls[i];
  await new Promise((res) => {
    if (audio.readyState >= 1) return res();
    audio.addEventListener("loadedmetadata", res, { once: true });
    audio.addEventListener("error", res, { once: true });
  });
  audio.currentTime = offset;
  if (autoplay) await audio.play().catch(() => {});
};

/** Seek to a global (book-wide) position in seconds. */
const seekGlobal = async (t) => {
  const starts = player.fileStarts;
  let i = 0;
  while (i < starts.length - 1 && starts[i + 1] <= t) i++;
  await loadFile(i, Math.max(0, t - starts[i]), true);
};

const playPause = async () => {
  if (audio.paused) await audio.play().catch(() => toast("Playback failed", { error: true }));
  else audio.pause();
  updateUI();
};

const skip = (sec) => { seekGlobal(Math.max(0, Math.min(player.duration, position() + sec))); };
const skipChapter = (dir) => {
  const pos = position();
  if (dir > 0) {
    const next = player.chapters.find((c) => c.globalStart > pos + 1);
    if (next) seekGlobal(next.globalStart);
  } else {
    const ch = currentChapter();
    // >3s into a chapter → restart it; else go to previous
    if (ch && pos - ch.globalStart > 3) seekGlobal(ch.globalStart);
    else {
      const idx = player.chapters.indexOf(ch);
      if (idx > 0) seekGlobal(player.chapters[idx - 1].globalStart);
      else seekGlobal(0);
    }
  }
};

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export const openPlayer = async (book, { onClose, onUpdate } = {}) => {
  player.onClose = onClose || (() => {});
  player.onUpdate = onUpdate || (() => {});
  player.book = book;
  book.lastOpenedAt = Date.now();
  await putBook(book);

  // load blobs
  player.urls.forEach((u) => URL.revokeObjectURL(u));
  player.urls = [];
  for (const key of book.fileKeys || [book.fileKey]) {
    const blob = await getFile(key);
    if (!blob) { toast("Audio file missing", { error: true }); return; }
    player.urls.push(URL.createObjectURL(blob));
  }

  // chapter global offsets
  const chapters = book.audio?.chapters?.length
    ? book.audio.chapters
    : [{ title: book.title, fileIndex: 0, start: 0, end: book.audio?.durationSec || 0 }];
  const fileDur = [];
  for (const ch of chapters) fileDur[ch.fileIndex] = Math.max(fileDur[ch.fileIndex] || 0, ch.end || 0);
  player.fileStarts = [];
  let acc = 0;
  for (let i = 0; i < player.urls.length; i++) { player.fileStarts[i] = acc; acc += fileDur[i] || 0; }
  player.chapters = chapters.map((c) => ({
    ...c,
    globalStart: player.fileStarts[c.fileIndex] + (c.start || 0),
    globalEnd: player.fileStarts[c.fileIndex] + (c.end || 0),
  })).sort((a, b) => a.globalStart - b.globalStart);
  player.duration = acc || book.audio?.durationSec || 0;
  player.sleepAt = null;

  // UI
  $("player-title").textContent = book.title;
  $("player-author").textContent = book.author || "";
  const cov = $("player-cover");
  cov.textContent = "";
  const cu = coverUrl(book);
  if (cu) { const img = document.createElement("img"); img.src = cu; img.alt = ""; cov.appendChild(img); }
  else cov.innerHTML = '<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

  // restore persisted playback speed
  const speed = await kvGet("audio-speed");
  if (speed && SPEEDS.includes(speed)) {
    audio.playbackRate = speed;
    $("player-speed").textContent = `${speed}×`;
  }

  $("view-player").hidden = false;
  await seekGlobal(book.progress?.positionSec || 0);
  updateUI();
  wireMediaSession();
};

export const closePlayer = async () => {
  audio.pause();
  savePos();
  await new Promise((r) => setTimeout(r, 50));
  player.urls.forEach((u) => URL.revokeObjectURL(u));
  player.urls = [];
  player.book = null;
  $("view-player").hidden = true;
  navigator.mediaSession && (navigator.mediaSession.metadata = null);
  const cb = player.onClose;
  player.onClose = null;
  cb?.();
};

const wireMediaSession = () => {
  if (!("mediaSession" in navigator)) return;
  const b = player.book;
  const art = coverUrl(b);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: b.title,
    artist: b.author || "",
    album: b.title,
    artwork: art ? [{ src: art, sizes: "512x512" }] : [],
  });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
  h("play", () => audio.play());
  h("pause", () => audio.pause());
  h("seekbackward", () => skip(-15));
  h("seekforward", () => skip(30));
  h("previoustrack", () => skipChapter(-1));
  h("nexttrack", () => skipChapter(1));
};

// chapter picker
const openChapters = () => {
  const cur = currentChapter();
  listSheet("Chapters", player.chapters.map((c, i) => ({
    title: c.title,
    sub: fmtDuration(c.globalStart),
    checked: c === cur,
    value: i,
  })), (i) => seekGlobal(player.chapters[i].globalStart).then(() => audio.play()));
};

// sleep timer
const openSleep = () => {
  const now = player.sleepAt === "chapter" ? -1
    : player.sleepAt ? Math.round((player.sleepAt - Date.now()) / 60000) : 0;
  listSheet("Sleep timer", SLEEP_OPTIONS.map((o) => ({
    title: o.title, checked: o.value === now || (o.value === 0 && !player.sleepAt), value: o.value,
  })), (v) => {
    if (v === 0) player.sleepAt = null;
    else if (v === -1) player.sleepAt = "chapter";
    else player.sleepAt = Date.now() + v * 60000;
    toast(v === 0 ? "Sleep timer off" : v === -1 ? "Sleeping at end of chapter" : `Sleeping in ${v} min`);
  });
};

let sleepInterval = null;
const checkSleep = () => {
  if (player.sleepAt === "chapter") {
    const ch = currentChapter();
    if (ch && ch.globalEnd && position() >= ch.globalEnd - 0.5) {
      audio.pause();
      player.sleepAt = null;
      toast("Sleep timer: paused");
    }
  } else if (player.sleepAt && Date.now() >= player.sleepAt) {
    audio.pause();
    player.sleepAt = null;
    toast("Sleep timer: paused");
  }
};

export const initPlayer = () => {
  $("player-close").addEventListener("click", closePlayer);
  $("player-play").addEventListener("click", playPause);
  $("player-back15").addEventListener("click", () => skip(-15));
  $("player-fwd30").addEventListener("click", () => skip(30));
  $("player-prev-ch").addEventListener("click", () => skipChapter(-1));
  $("player-next-ch").addEventListener("click", () => skipChapter(1));
  $("player-chapter-btn").addEventListener("click", openChapters);
  $("player-sleep").addEventListener("click", openSleep);
  $("player-speed").addEventListener("click", () => {
    const cur = SPEEDS.indexOf(audio.playbackRate);
    const next = SPEEDS[(cur + 1) % SPEEDS.length];
    audio.playbackRate = next;
    $("player-speed").textContent = `${next}×`;
    kvSet("audio-speed", next);
  });
  // drag → preview only; commit the seek on release so we don't spam loadFile
  $("player-slider").addEventListener("input", (e) => {
    seekPreview = (e.target.value / 1000) * player.duration;
    $("player-elapsed").textContent = fmtDuration(seekPreview);
  });
  $("player-slider").addEventListener("change", () => {
    if (seekPreview != null) seekGlobal(seekPreview);
    seekPreview = null;
  });

  audio.addEventListener("timeupdate", () => { updateUI(); savePos(); checkSleep(); });
  audio.addEventListener("play", updateUI);
  audio.addEventListener("pause", updateUI);
  audio.addEventListener("ended", async () => {
    const next = player.fileIndex + 1;
    if (next < player.urls.length) await loadFile(next, 0, true);
    else { updateUI(); savePos(); }
  });

  if (!sleepInterval) sleepInterval = setInterval(checkSleep, 5000);
};

export const playerActive = () => !!player.book;
export const playerState = () => ({
  book: player.book,
  playing: !audio.paused,
  toggle: playPause,
});
export const reopenPlayer = () => { if (player.book) $("view-player").hidden = false; };
