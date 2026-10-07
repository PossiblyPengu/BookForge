/**
 * player.js — audiobook player.
 *
 * Handles single-file books with embedded chapters (m4b) and multi-file
 * books (mp3 folder imports grouped at import time). Tracks a global
 * position across files, integrates MediaSession for lock-screen
 * controls, and persists progress.
 */

import {
  $, fmtDuration, debounce, listSheet, coverUrl, fillCover, coverTint, toast, onPageHidden,
} from "./util.js";
import { getFile, putBook, kvGet, kvSet } from "./db.js";
import { registerAudioOwner, claimAudio } from "./audio-focus.js";
import { syncProgress, syncSession } from "./bookmaster.js";
import { recordSession } from "./stats.js";

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
  await putBook(b).catch((err) => console.warn("position save failed", err));
  syncProgress(b);
}, 2000);

// Where the open stretch of listening began — { fraction, at }, or null when
// no stretch is running (paused, closed, or the page hid). The "percent" is
// the book-wide position fraction, like progress reports.
let bmSessionStart = null;

const currentFraction = () =>
  player.duration ? Math.min(1, position() / player.duration) : 0;

const beginBookmasterSession = () => {
  if (player.book && !bmSessionStart)
    bmSessionStart = { fraction: currentFraction(), at: Date.now() };
};

/**
 * The stretch since bmSessionStart becomes a BookMaster session if the book
 * moved half a percent — a pause before anything played doesn't count. The
 * stretch ends either way: resumed listening is a new one, so the paused or
 * hidden gap in between is never counted as listening time and no stretch is
 * counted twice.
 */
const endBookmasterSession = () => {
  const b = player.book;
  if (!b || !bmSessionStart) return;
  const start = bmSessionStart;
  bmSessionStart = null;
  const fraction = currentFraction();
  if ((fraction - start.fraction) * 100 < 0.5) return;
  const session = {
    percentStart: start.fraction * 100,
    percentEnd: fraction * 100,
    minutes: (Date.now() - start.at) / 60000,
    at: Date.now(),
  };
  recordSession(b, session);
  syncSession(b, session);
};

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

/** "12 min", "40 s", "1 h 5 min" — how long, at a glance. */
const shortLeft = (sec) => {
  if (sec < 60) return `${Math.ceil(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** What the sleep button says: its countdown while set. */
const sleepLabel = () => {
  if (player.sleepAt === "chapter") return "End of ch.";
  if (player.sleepAt) return shortLeft(Math.max(0, (player.sleepAt - Date.now()) / 1000));
  return "Sleep";
};

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
  const chLeft = ch?.globalEnd ? Math.max(0, ch.globalEnd - pos) : 0;
  $("player-chapter-left").textContent = chLeft ? `· ${shortLeft(chLeft)} left` : "";
  $("player-sleep-label").textContent = sleepLabel();
  $("player-sleep").classList.toggle("on", !!player.sleepAt);
  setIcon("player-play", !audio.paused);
  try { navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing"; } catch { /* noop */ }
  if (player.book) updatePositionState();
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
  if (!player.urls.length || !player.fileStarts?.length) return;
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
  bmSessionStart = { fraction: book.progress?.fraction || 0, at: Date.now() };
  book.lastOpenedAt = Date.now();
  await putBook(book);

  // load blobs
  player.urls.forEach((u) => URL.revokeObjectURL(u));
  player.urls = [];
  for (const key of book.fileKeys || [book.fileKey]) {
    const blob = await getFile(key);
    if (!blob) {
      // leave no half-open player behind — a set player.book with empty urls
      // put a stale, unplayable title on the mini-player
      player.book = null;
      bmSessionStart = null;
      player.onUpdate();
      toast("Audio file missing", { error: true });
      return;
    }
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
  fillCover($("player-cover"), book);
  fillCover($("player-art"), book); // blurred into an ambient backdrop
  // the screen takes a wash of the cover's colour, like a record sleeve
  $("view-player").style.removeProperty("--tint");
  coverTint(book).then((c) => { if (c && player.book === book) $("view-player").style.setProperty("--tint", c); });
  const chaptered = player.chapters.length > 1;
  $("player-chapter-btn").hidden = !chaptered;
  $("player-chapters").hidden = !chaptered;

  // restore persisted playback speed
  const speed = await kvGet("audio-speed");
  if (speed && SPEEDS.includes(speed)) {
    audio.playbackRate = speed;
    $("player-speed-val").textContent = `${speed}×`;
  }

  $("view-player").hidden = false;
  await seekGlobal(book.progress?.positionSec || 0);
  updateUI();
  wireMediaSession();
  // opening counts as starting the audiobook — shelf it on the tracker now,
  // not on the first play (which may never come for a peek)
  syncProgress(book, { force: true });
};

export const closePlayer = async () => {
  audio.pause();
  // Schedule, then run it now. The old code scheduled the 2s debounce and
  // cleared player.book immediately after, so the save always bailed out and
  // the position you stopped at was lost.
  savePos();
  savePos.flush();
  // closing is a forced push — capture the book before player.book clears —
  // and a real stretch of listening becomes a session on the tracker
  endBookmasterSession();
  bmSessionStart = null;
  syncProgress(player.book, { force: true });
  player.urls.forEach((u) => URL.revokeObjectURL(u));
  player.urls = [];
  player.book = null;
  // sheet-style exit, same as the reader: .closing plays the slide-down
  // before hidden lands (display:none !important would cancel the animation)
  const playerEl = $("view-player");
  playerEl.classList.add("closing");
  await new Promise((r) => setTimeout(r, 200));
  // a tap on the mini-player during the slide reopened it — don't hide that
  if (player.book) { playerEl.classList.remove("closing"); return; }
  playerEl.hidden = true;
  playerEl.classList.remove("closing");
  if ("mediaSession" in navigator) {
    // dead handlers used to stay live — a lock-screen "play" after close
    // seeked an empty url list and errored on `audio.src = undefined`
    navigator.mediaSession.metadata = null;
    for (const a of ["play", "pause", "stop", "seekbackward", "seekforward", "previoustrack", "nexttrack", "seekto"]) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch { /* unsupported */ }
    }
    try { navigator.mediaSession.playbackState = "none"; } catch { /* noop */ }
  }
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
  h("stop", () => closePlayer());
  h("seekbackward", (d) => skip(-(d?.seekOffset || 15)));
  h("seekforward", (d) => skip(d?.seekOffset || 30));
  h("previoustrack", () => skipChapter(-1));
  h("nexttrack", () => skipChapter(1));
  // lock-screen scrubbing — the position is book-wide, not per-file
  h("seekto", (d) => {
    if (d?.seekTime == null) return;
    if (d.fastSeek && audio.fastSeek) {
      const local = d.seekTime - (player.fileStarts[player.fileIndex] || 0);
      if (local >= 0 && local <= (audio.duration || 0)) { audio.fastSeek(local); return; }
    }
    seekGlobal(d.seekTime);
  });
  updatePositionState();
};

/**
 * Feed the lock screen the whole book's timeline. Without this there's no
 * progress bar and nothing to scrub — and the numbers have to be the global
 * ones, or a multi-file book reports each file as the whole thing.
 */
const updatePositionState = () => {
  if (!navigator.mediaSession?.setPositionState) return;
  const duration = player.duration || audio.duration || 0;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(position(), 0), duration),
    });
  } catch { /* a position past duration mid-file-switch — next tick fixes it */ }
};

// chapter picker
const openChapters = () => {
  const cur = currentChapter();
  listSheet("Chapters", player.chapters.map((c, i) => ({
    title: c.title,
    sub: fmtDuration(c.globalStart),
    checked: c === cur,
    value: i,
  })), (i) => seekGlobal(player.chapters[i].globalStart).then(() => audio.play()),
  { search: true }); // a long audiobook has more chapters than fit on screen
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
    updateUI(); // the button shows the countdown — update it even while paused
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
  $("player-chapters").addEventListener("click", openChapters);
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
    $("player-speed-val").textContent = `${next}×`;
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
  audio.addEventListener("play", () => {
    claimAudio("audiobook");
    beginBookmasterSession(); // resumed listening starts a new stretch
    updateUI();
  });
  // a pause is a natural checkpoint — force a push past the throttle, and
  // call the stretch a session: this pause may be where listening ended
  audio.addEventListener("pause", () => {
    updateUI();
    endBookmasterSession();
    syncProgress(player.book, { force: true });
  });
  audio.addEventListener("ratechange", updatePositionState);
  // A decode failure or an evicted blob used to just go quiet mid-book.
  audio.addEventListener("error", () => {
    if (!player.book) return;
    const n = player.fileIndex + 1;
    toast(player.urls.length > 1
      ? `Couldn’t play part ${n} of ${player.urls.length} — the file may be damaged`
      : "Couldn’t play this audiobook — the file may be damaged", { error: true, ms: 6000 });
    updateUI();
  });
  audio.addEventListener("ended", async () => {
    const next = player.fileIndex + 1;
    if (next < player.urls.length) await loadFile(next, 0, true);
    else { updateUI(); savePos(); }
  });

  registerAudioOwner("audiobook", () => audio.pause());
  if (!sleepInterval) sleepInterval = setInterval(checkSleep, 5000);
  // losing the last two seconds of an audiobook position is worse than for a
  // book — it's a spot in a narration, not a page — and a hidden page may be
  // the app's last moment, so the stretch counts as a session on the tracker
  onPageHidden(() => { savePos.flush(); endBookmasterSession(); });
  // audio can keep playing while the page is hidden — a return starts the
  // stretch the hide ended
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !audio.paused) beginBookmasterSession();
  });
};

export const playerActive = () => !!player.book;
export const playerState = () => ({
  book: player.book,
  playing: !audio.paused,
  toggle: playPause,
  fraction: player.duration ? Math.min(1, position() / player.duration) : 0,
  chapter: player.chapters.length > 1 ? currentChapter()?.title || "" : "",
});
export const reopenPlayer = () => { if (player.book) $("view-player").hidden = false; };
