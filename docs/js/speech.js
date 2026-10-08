/**
 * speech.js — what the voice says, versus what the page shows.
 *
 * The text a block carries is kept raw for highlighting: the DOM range of a
 * sentence is found by matching it verbatim. An engine is happier with
 * different words — no footnote markers, no markdown garnish, no scene-break
 * asterisks (a Web Speech voice will cheerfully read them as "asterisk
 * asterisk asterisk"). cleanSpeech() bridges the two: it returns the text to
 * speak plus `map`, the source index each spoken character came from, so a
 * word-boundary event in the cleaned string can still light the right word
 * on the page.
 *
 *   cleanSpeech(raw) → { say, map, gap, silent }
 *     say    — what to hand the engine
 *     map    — say[i] originates at raw[map[i]]
 *     gap    — ms of silence this chunk wants before it (paragraph/scene)
 *     silent — nothing to voice: a separator is a pause, furniture drops
 */

// --- the rewrite rules -----------------------------------------------------
//
// Each entry finds a span of the raw text and either deletes it ("") or
// replaces it. They all run over the original text together — an earlier
// rule owns its matches, so a markdown link swallows the URL inside it.
const RULES = [
  // markdown: ![alt](src) and [text](href) leave their words
  [/!?\[([^\]]*)\]\([^)\n]*\)/gu, (m) => m[1]],
  // a bare URL is furniture, not words
  [/\b(?:https?:\/\/|www\.)\S+/giu, ""],
  // an email address is a name, not a sentence
  [/\b\S+@\S+\.\S+/gu, ""],
  // bracketed note refs — [12], [iv], [^3] — but not [stage directions]
  [/\[\^?(?:\d{1,4}|[ivxlcdm]{1,6})\]/giu, ""],
  // superscript note marks: word¹ word²³ wordⁿ
  [/[\u00B9\u00B2\u00B3\u2070-\u207E]+/gu, ""],
  // a note sigil right after a word or its closing quote: word* word†
  [/(?<=[\p{L}\p{N}.,!?…"'”’)\]])[*†‡§]+(?=\s|$|[.,!?…])/gu, ""],
  // markdown structure at the start of a chunk: ## , > , - item, 4. item
  [/^\s*(?:#{1,6}\s+|>\s+|(?:[*+\-–—•·◦▪▹]|\d{1,3}[.)])\s+)/gu, ""],
  // a dialogue dash opening a chunk ("— a pause"): it's the pause
  [/^\s*["'“‘]?\s*[—–-]+\s+/gu, ""],
  // emphasis and code markers hugging words: **bold**, _lean_, `code`
  [/[~*•`]{2,}/gu, ""],
  [/(?<![\p{L}\p{N}])[*_~`]+(?=[\p{L}\p{N}])/gu, ""],
  [/(?<=[\p{L}\p{N}])[*_~`]+(?![\p{L}\p{N}])/gu, ""],
  // stray ornaments a text file uses as structure — bullets, pilcrows and
  // rating-star dingbats: a • b, ⁂, ★★★★☆
  [/[•·◦▪▹⁂†‡§¶★☆✦✧✩✪✫✬✭✮✯✰❋❊❉✽✾✿❀❁❂❃❄❅❆]+/gu, ""],
  // a table pipe is a pause, not a letter
  [/\s*\|+\s*/gu, ", "],
  // symbol furniture that names itself aloud: = + ^ ~ @ # _ © ® ™
  [/[=+^~@#_©®™]+/gu, ""],
  // invisible characters — a soft hyphen marks a break point, not a sound
  [/[\u00AD\u200B\u200E\u200F\uFEFF]/gu, ""],
  // ligatures and friends that confuse phonemizers
  [/ﬀ/gu, "ff"], [/ﬁ/gu, "fi"], [/ﬂ/gu, "fl"], [/ﬃ/gu, "ffi"], [/ﬄ/gu, "ffl"],
  [/œ/gu, "oe"], [/æ/gu, "ae"],
  // dashes: each rule's output is final — later rules can't see it, so the
  // spacing is written into the replacement itself. A range dash keeps its
  // meaning as a hyphen between digits ("3–5").
  [/(?<=\d)[–—](?=\d)/gu, "-"],
  [/-{2,}/gu, " — "],
  [/[―–]/gu, " — "],
  [/\s*—\s*/gu, " — "],
  // ellipsis: ..., . . . , …. …… — one mark, one pause
  [/(?:\.\s*){2}\./gu, "…"],
  [/…+/gu, "…"],
  [/\.(?=…)|(?<=…)\./gu, ""],
  // shouted punctuation: !!! → ! , ??? → ? , !?!? → !?
  [/([!?])\1{1,}/gu, (m) => m[1]],
  [/[!?]{3,}/gu, "!?"],
];

/**
 * Run the rules over raw text; returns { say, map } where map ties each
 * spoken character back to its index in the raw string.
 */
const applyRules = (raw) => {
  const edits = [];
  for (const [re, rep] of RULES) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!end) continue;
      // an earlier rule's claim stands — skip edits it overlaps
      if (edits.some((e) => start < e.end && end > e.start)) continue;
      const out = typeof rep === "function" ? rep(m) : rep;
      edits.push({ start, end, out });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let say = "";
  const map = [];
  let pos = 0;
  for (const { start, end, out } of edits) {
    for (let i = pos; i < start; i++) { say += raw[i]; map.push(i); }
    for (let k = 0; k < out.length; k++) { say += out[k]; map.push(start); }
    pos = end;
  }
  for (let i = pos; i < raw.length; i++) { say += raw[i]; map.push(i); }
  return { say, map };
};

/** Collapse doubled spaces and space-before-mark the edits leave behind. */
const tidy = (say, map) => {
  for (let i = 0; i < say.length - 1; i++) {
    if (say[i] === " " && (say[i + 1] === " " || /[,;:.!?…]/.test(say[i + 1]))) {
      say = say.slice(0, i) + say.slice(i + 1);
      map.splice(i, 1);
      i--;
    }
  }
  // whitespace and stranded quotes at the edges are silence, not sounds
  let from = 0;
  let to = say.length;
  while (from < to && /\s/.test(say[from])) from++;
  while (to > from && /[\s'"“”‘’]/.test(say[to - 1])) to--;
  return { say: say.slice(from, to), map: map.slice(from, to) };
};

/** A chunk made of nothing but marks — the * * * between scenes. */
const SEPARATOR = /^[\s*\-–—_=~•·◦▪▹|#.⁂†‡§…·:'"“”‘’]+$/u;
/** A chunk that is one bare number — almost always a printed page number. */
const PAGE_NO = /^\d{1,5}$/;

/**
 * Clean a speakable chunk. `gap` is the silence the chunk asks for ahead of
 * itself — a new paragraph breathes, a scene break breathes longer.
 */
export const cleanSpeech = (raw, { newBlock = false } = {}) => {
  const text = String(raw ?? "");
  const pre = applyRules(text);
  const { say, map } = tidy(pre.say, pre.map);
  // Nothing left to say. A separator is a beat of silence; a bare number or
  // a stray mark is furniture and just drops.
  if (!/[\p{L}\p{N}]/u.test(say)) {
    return SEPARATOR.test(text.trim()) && text.trim().length > 1
      ? { say: "", map: [], gap: 900, silent: true }
      : { say: "", map: [], gap: 0, silent: true };
  }
  if (PAGE_NO.test(say)) return { say: "", map: [], gap: 0, silent: true };
  // every sentence breathes a little; a new paragraph breathes more
  return { say, map, gap: newBlock ? 300 : 120, silent: false };
};

/**
 * The raw-text word a spoken character index lands on — for lighting the
 * right word when the engine reports a boundary inside `say`.
 */
export const wordAt = (text, index) => {
  if (!text) return { word: "", start: 0 };
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { word: text.slice(start, end), start };
};
