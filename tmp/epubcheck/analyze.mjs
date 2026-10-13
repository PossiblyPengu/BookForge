// EPUB TTS-decoration analyser: does what Readium's ContentTokenizer +
// decorator.js rangeFromLocator do, against a real EPUB file.
// Usage: node analyze.mjs <book.epub|zip> [spine-index]

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------- minimal ZIP reader ----------
function unzip(path) {
  const buf = readFileSync(path);
  // End of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    files.set(name, { method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return {
    names: [...files.keys()],
    read(name) {
      const e = files.get(name);
      if (!e) return null;
      const nlen = buf.readUInt16LE(e.lho + 26);
      const elen = buf.readUInt16LE(e.lho + 28);
      const data = buf.subarray(e.lho + 30 + nlen + elen, e.lho + 30 + nlen + elen + e.csize);
      return e.method === 8 ? inflateRawSync(data) : data;
    },
  };
}

// ---------- tiny XML helpers (good enough for container.xml / OPF) ----------
function attr(tag, name) {
  const m = tag.match(new RegExp(name + `\\s*=\\s*"([^"]*)"|` + name + `\\s*=\\s*'([^']*)'`));
  return m ? (m[1] ?? m[2]) : null;
}
function tags(xml, name) {
  return xml.match(new RegExp(`<${name}(?=[\\s>/])[^>]*>`, "g")) ?? [];
}
const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
   .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

// ---------- DOM-ish text extraction (like textContent, and like the ContentTokenizer) ----------
// We walk the markup: block elements and <br/> flush text (the tokenizer emits a segment per
// contiguous text run); inline elements pass through.
const BLOCK = new Set("address article aside blockquote body br caption center col colgroup dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul".split(" "));
// script/style text is part of DOM textContent but the tokenizer skips nothing — SwiftSoup
// still sees their text nodes. Keep them for textContent; report them separately.

function decodeEntities(s) {
  return unescapeXml(s);
}

// Strip tags -> produce an array of {text, blockStack} text-node events is overkill; instead do:
//  - contentText: concatenated text of all text nodes (entities decoded), as textContent would give
//  - tokenizerText: same but with whitespace normalized the way appendNormalisedText does
//  - segments: contiguous runs between block boundaries (the ContentTokenizer's segments)
function extract(xhtml) {
  // remove <![CDATA[ ]]> wrappers but keep their text
  let s = xhtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // drop comments and doctype/processing instructions
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<!(?!-)[^>]*>/g, "").replace(/<\?[^>]*\?>/g, "");
  const events = []; // {kind:'text'|'flush', text?}
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { events.push({ kind: "text", text: s.slice(i) }); break; }
    if (lt > i) events.push({ kind: "text", text: s.slice(i, lt) });
    const gt = s.indexOf(">", lt);
    if (gt < 0) break;
    const tag = s.slice(lt + 1, gt);
    const name = tag.replace(/^\//, "").split(/[\s/>]/)[0].toLowerCase();
    if (!tag.startsWith("/") && BLOCK.has(name)) events.push({ kind: "flush" });
    if (name === "br") events.push({ kind: "flush" });
    i = gt + 1;
    // skip self-closing content already handled; script/style keep their inner text in textContent
  }
  // textContent: every text event, entities decoded, verbatim
  const contentText = events.filter(e => e.kind === "text").map(e => decodeEntities(e.text)).join("");
  // segments: between flushes; whitespace-normalized (tokenizer) — block runs merged into one segment each
  const segments = [];
  let acc = "";
  for (const e of events) {
    if (e.kind === "text") acc += decodeEntities(e.text);
    else {
      const norm = acc.replace(/\s+/g, " ").trim();
      if (norm) segments.push({ raw: acc, text: norm });
      acc = "";
    }
  }
  const norm = acc.replace(/\s+/g, " ").trim();
  if (norm) segments.push({ raw: acc, text: norm });
  return { contentText, segments };
}

// ---------- content-document DOM text (what hypothesis anchors in) ----------
// hypothesis's TextQuoteAnchor uses the element's text — we approximate root=document.body:
// drop head, script and style (script/style DO count in textContent of body only if inside body)
function bodyText(xhtml) {
  let s = xhtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<!(?!-)[^>]*>/g, "").replace(/<\?[^>]*\?>/g, "");
  const bodyMatch = s.match(/<body[\s\S]*?<\/body\s*>/i) ?? s.match(/<body[\s\S]*/i);
  let body = bodyMatch ? bodyMatch[0] : s;
  // drop script/style elements entirely for the "visible text" view
  body = body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return body.replace(/<[^>]+>/g, "").replace(/[ \t]*\n[ \t]*/g, "\n");
}

// ---------- simulate the synthesizer: sentence split ----------
function sentences(text) {
  // close enough to ContentTokenizer: split on sentence-ending punctuation
  const out = [];
  const re = /[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0].replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

// ---------- main ----------
const path = process.argv[2];
const onlySpine = process.argv[3] ? +process.argv[3] : null;
const zip = unzip(path);

console.log("== entries:", zip.names.length);
const containerXml = zip.read("META-INF/container.xml")?.toString("utf8");
if (!containerXml) { console.log("NO container.xml"); process.exit(1); }
const opfPath = attr(tags(containerXml, "rootfile")[0], "full-path");
console.log("== OPF:", opfPath);
const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
const opf = zip.read(opfPath).toString("utf8");

// fixed-layout? rendition:layout or apple fixed-format meta
const fxl = /(rendition:layout|layout)\s*>\s*pre-paginated|apple-fixed-format\s+content="true"/i.test(opf)
  || tags(opf, "meta").some(t => /pre-paginated/i.test(t));
console.log("== fixed layout:", fxl ? "YES (!!)" : "no");

const manifest = new Map();
for (const t of tags(opf, "item")) {
  const id = attr(t, "id"), href = attr(t, "href"), mt = attr(t, "media-type"), props = attr(t, "properties");
  if (id && href) manifest.set(id, { href: unescapeXml(href), mt, props: props ?? "" });
}
const spine = tags(opf, "itemref").map(t => attr(t, "idref")).filter(Boolean);
console.log(`== spine: ${spine.length} items`);
for (const [id, it] of manifest) {
  if (it.props) console.log("   manifest props:", id, it.props, it.href);
}

// media overlays?
const smil = zip.names.filter(n => /\.smil$/i.test(n));
if (smil.length) console.log("== has SMIL media overlays:", smil.length);

// suspicious-character / markup scan over all spine docs
const suspicious = [
  ["soft hyphen U+00AD", /\u00AD/],
  ["zero-width space U+200B", /\u200B/],
  ["ZWJ U+200D", /\u200D/],
  ["BOM/ZWNBSP U+FEFF", /\uFEFF/],
  ["nbsp", / |\u00A0/],
  ["<script>", /<script/i],
  ["<svg>", /<svg/i],
  ["<ruby>", /<ruby/i],
  ["<wbr>", /<wbr/i],
  ["epub:type=pagebreak", /epub:type="pagebreak"|role="doc-pagebreak"/i],
];

let totalSeg = 0, unanchored = [], shortHL = [];
for (let si = 0; si < spine.length; si++) {
  const item = manifest.get(spine[si]);
  if (!item) continue;
  const filePath = opfDir ? `${opfDir}/${item.href}` : item.href;
  const raw = zip.read(decodeURIComponent(filePath));
  if (!raw) { console.log(`!! missing ${filePath}`); continue; }
  const xhtml = raw.toString("utf8");
  if (si === 0 || onlySpine === si) {
    const hits = suspicious.filter(([, re]) => re.test(xhtml)).map(([n]) => n);
    console.log(`\n== ${filePath} (${item.mt}) — suspects: ${hits.join(", ") || "none"}`);
  }
  if (onlySpine != null && si !== onlySpine) continue;
  const { contentText, segments } = extract(xhtml);
  const domText = decodeEntities(bodyText(xhtml)).replace(/\s+/g, " ");
  totalSeg += segments.length;
  let misses = 0;
  for (const seg of segments) {
    for (const sent of sentences(seg.text)) {
      // utterance locator: text.highlight = sent (normalized); anchor in element text (≈domText)
      const normDom = domText.replace(/\s+/g, " ");
      if (!normDom.includes(sent)) {
        misses++;
        if (unanchored.length < 12) unanchored.push({ file: filePath, sent: sent.slice(0, 90) });
      }
      // word highlights
      for (const w of sent.split(/\s+/)) {
        const word = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (word && word.length <= 2) shortHL.push(word);
      }
    }
  }
  if (misses) console.log(`   ${filePath}: ${misses} sentence(s) NOT verbatim-anchorable`);
}
console.log(`\n== segments across book: ${totalSeg}`);
if (unanchored.length) {
  console.log("== example sentences that do not appear verbatim in normalized DOM text:");
  for (const u of unanchored) console.log("   ", u.file, "→", JSON.stringify(u.sent));
} else {
  console.log("== every sampled sentence appears in the DOM text — anchoring should succeed");
}
console.log("== 1-2 char word highlights (fragile anchors):", shortHL.slice(0, 20).join(", ") || "few");
