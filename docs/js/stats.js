/**
 * stats.js — a local log of finished reading/listening stretches, and the
 * "Reading stats" sheet they feed. Sessions are recorded wherever a real
 * stretch ends (reader close/hide, audio pause/close) — the same threshold
 * BookMaster sync uses, so a quick peek never inflates the numbers.
 */

import { $, openSheet } from "./util.js";
import { allBooks, kvGet, kvSet } from "./db.js";

const fmtMins = (m) =>
  m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${m}m`;

const KEY = "reading-sessions";
const CAP = 2000; // ~a session a day for five years; plenty

/**
 * One completed stretch. `minutes` is wall time with the book open and
 * moving; `at` is the moment the stretch ended.
 */
export const recordSession = async (book, { minutes, at }) => {
  const list = await kvGet(KEY, []);
  list.push({
    b: book.id,
    m: Math.max(1, Math.round(minutes)),
    at: at || Date.now(),
  });
  if (list.length > CAP) list.splice(0, list.length - CAP);
  await kvSet(KEY, list);
};

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Consecutive days ending today (or yesterday) that hold a session. */
const streak = (days) => {
  let n = 0;
  const d = new Date();
  // a day that hasn't had a session *yet* shouldn't break a live streak
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
};

const tile = (num, label) => {
  const el = document.createElement("div");
  el.className = "stat-tile";
  const n = document.createElement("span");
  n.className = "stat-num";
  n.textContent = num;
  const l = document.createElement("span");
  l.className = "stat-label";
  l.textContent = label;
  el.append(n, l);
  return el;
};

export const openStats = async () => {
  const [sessions, books] = await Promise.all([kvGet(KEY, []), allBooks()]);
  const grid = $("stats-grid");
  grid.textContent = "";

  const now = new Date();
  const weekAgo = now.getTime() - 7 * 86400e3;
  const todayKey = dayKey(now);
  const week = sessions.filter((s) => s.at >= weekAgo);
  const weekMin = Math.round(week.reduce((a, s) => a + s.m, 0));
  const todayMin = Math.round(
    sessions.filter((s) => dayKey(s.at) === todayKey).reduce((a, s) => a + s.m, 0));
  const days = new Set(sessions.map((s) => dayKey(s.at)));
  const finished = books.filter((b) => (b.progress?.fraction || 0) >= 0.995).length;
  const totalMin = Math.round(sessions.reduce((a, s) => a + s.m, 0));

  for (const [num, label] of [
    [books.length, "books"],
    [finished, "finished"],
    [fmtMins(todayMin), "today"],
    [fmtMins(weekMin), "this week"],
    [streak(days), "day streak"],
    [fmtMins(totalMin), "all time"],
  ]) grid.appendChild(tile(num, label));

  // last seven days, oldest → newest, with the day letter under each bar
  const bars = $("stats-bars");
  const dayRow = $("stats-days");
  bars.textContent = "";
  dayRow.textContent = "";
  const byDay = new Map();
  for (const s of sessions) {
    const k = dayKey(s.at);
    byDay.set(k, (byDay.get(k) || 0) + s.m);
  }
  const mins = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    mins.push({ d, m: Math.round(byDay.get(dayKey(d)) || 0) });
  }
  const peak = Math.max(1, ...mins.map((x) => x.m));
  for (const { d, m } of mins) {
    const bar = document.createElement("div");
    bar.className = "stats-bar" + (dayKey(d) === todayKey ? " stats-today" : "");
    bar.title = m ? fmtMins(m) : "no reading";
    const fill = document.createElement("i");
    fill.style.height = `${Math.max(4, (m / peak) * 100)}%`;
    if (!m) fill.style.opacity = "0.15";
    bar.appendChild(fill);
    bars.appendChild(bar);
    const lab = document.createElement("span");
    lab.textContent = "SMTWTFS"[d.getDay()];
    dayRow.appendChild(lab);
  }

  $("stats-note").textContent = sessions.length
    ? `${sessions.length} reading session${sessions.length === 1 ? "" : "s"} recorded on this device.`
    : "Sessions are recorded as you read — check back after your first stretch.";
  openSheet("sheet-stats");
};

export const initStats = () => {
  $("set-stats").addEventListener("click", openStats);
};
