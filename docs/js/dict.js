/**
 * dict.js — "Define" on a reader selection. Looks the word up at
 * api.dictionaryapi.dev (free, keyless) and shows a small card of
 * definitions. This is the one deliberate network call in the reader, and
 * it obeys the same "look things up online" switch metadata search does —
 * when that's off, Define doesn't appear at all.
 */

import { $, openSheet, toast } from "./util.js";
import { kvGet } from "./db.js";

const endpoint = (word) =>
  `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

/** True when the selection is a plausible word/short term to look up. */
export const definable = (text) => /^[\w'’\-– ]{1,30}$/.test(text.trim());

const renderEntries = (word, entries) => {
  $("define-word").textContent = entries[0]?.word || word;
  const phon = entries.map((e) => e.phonetic).find(Boolean)
    || entries.flatMap((e) => e.phonetics || []).map((p) => p.text).find(Boolean)
    || "";
  $("define-phon").textContent = phon;
  const list = $("define-list");
  list.textContent = "";
  let shown = 0;
  for (const entry of entries) {
    for (const meaning of entry.meanings || []) {
      for (const def of (meaning.definitions || []).slice(0, 2)) {
        if (shown >= 6) break;
        shown++;
        const item = document.createElement("div");
        item.className = "define-item";
        const pos = document.createElement("div");
        pos.className = "define-pos";
        pos.textContent = meaning.partOfSpeech || "";
        const text = document.createElement("div");
        text.className = "define-text";
        text.textContent = def.definition;
        item.append(pos, text);
        if (def.example) {
          const ex = document.createElement("div");
          ex.className = "define-ex";
          ex.textContent = `“${def.example}”`;
          item.appendChild(ex);
        }
        list.appendChild(item);
      }
    }
  }
  if (!shown) {
    const p = document.createElement("p");
    p.className = "sheet-note";
    p.textContent = "No definitions listed for this word.";
    list.appendChild(p);
  }
};

export const define = async (text) => {
  if (!(await kvGet("meta-online", true))) {
    toast("Online lookups are off — enable them in Settings → Metadata");
    return;
  }
  const word = text.trim().split(/\s+/).slice(0, 3).join(" ");
  $("define-word").textContent = word;
  $("define-phon").textContent = "";
  $("define-list").innerHTML = '<p class="sheet-note">Looking up…</p>';
  openSheet("sheet-define");
  try {
    const res = await fetch(endpoint(word.toLowerCase()));
    if (!res.ok) throw new Error(String(res.status));
    const entries = await res.json();
    renderEntries(word, Array.isArray(entries) ? entries : []);
  } catch {
    $("define-phon").textContent = "";
    $("define-list").innerHTML =
      '<p class="sheet-note">No definition found — check you’re online.</p>';
  }
};
