/**
 * reader-text.js — TXT / Markdown / HTML renderer.
 * Scroll-based; progress persisted as scroll fraction.
 */

import { debounce, rangeForChunk, extractBlocks, resumePoint } from "./util.js";

// The top bar and the read-aloud bar overlay the scroller; text under them
// isn't really on screen.
const CHROME_TOP = 64;
const CHROME_BOTTOM = 120;

const mdToHtml = (src) => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) { out.push("<p>" + para.join(" ") + "</p>"); para = []; }
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { flush(); continue; }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^[-*_]{3,}$/.test(t)) { flush(); out.push("<hr/>"); continue; }
    if (/^[-*+]\s+/.test(t)) { flush(); out.push("<p>• " + inline(t.replace(/^[-*+]\s+/, "")) + "</p>"); continue; }
    para.push(inline(t));
  }
  flush();
  return out.join("\n");
};

const inline = (s) =>
  s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
   .replace(/\*([^*]+)\*/g, "<em>$1</em>")
   .replace(/`([^`]+)`/g, "<code>$1</code>")
   .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

const txtToHtml = (src) =>
  src.split(/\r?\n\r?\n+/).map((p) => {
    const t = p.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return t ? `<p>${t.replace(/\r?\n/g, " ")}</p>` : "";
  }).join("\n");

export const openTextReader = async (stage, book, fileBlob, { updateProgressUI, saveProgress, userMoved = () => {} }) => {
  const text = await fileBlob.text();
  const isHtml = /\.(html?|htm)$/i.test(book.fileName || "");
  const isMd = /\.(md|markdown)$/i.test(book.fileName || "");

  const wrap = document.createElement("div");
  wrap.className = "text-reader";
  stage.appendChild(wrap);

  if (isHtml) {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "");
    iframe.style.cssText = "width:100%;height:100%;border:0;background:transparent";
    iframe.srcdoc = text;
    wrap.style.padding = "0";
    wrap.appendChild(iframe);
  } else {
    wrap.innerHTML = isMd ? mdToHtml(text) : txtToHtml(text);
  }

  // overlay layer for TTS read-aloud highlighting
  const hlLayer = document.createElement("div");
  hlLayer.className = "tts-hl-layer";
  wrap.appendChild(hlLayer);
  const clearHl = () => { hlLayer.textContent = ""; };
  const highlight = (block, chunkText, searchFrom = 0) => {
    clearHl();
    if (!block?.el) return null;
    const found = rangeForChunk(block.el, chunkText, searchFrom);
    const range = found?.range;
    const rects = range ? [...range.getClientRects()] : [block.el.getBoundingClientRect()];
    const wr = wrap.getBoundingClientRect();
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const d = document.createElement("div");
      d.className = "tts-hl";
      d.style.left = `${r.left - wr.left + wrap.scrollLeft}px`;
      d.style.top = `${r.top - wr.top + wrap.scrollTop}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
      hlLayer.appendChild(d);
    }
    // Follow the spoken line, not the paragraph: a long block's top can be
    // on screen while the words being read have scrolled off the bottom.
    const r0 = rects.find((r) => r.height >= 1);
    if (r0 && (r0.top < wr.top + CHROME_TOP || r0.bottom > wr.bottom - CHROME_BOTTOM))
      wrap.scrollTop += r0.top - wr.top - wrap.clientHeight * 0.3;
    return { start: found?.start ?? searchFrom, end: found?.end ?? searchFrom };
  };

  const scroller = isHtml ? null : wrap;

  const frac = () => {
    if (!scroller) return book.progress?.fraction || 0;
    const max = scroller.scrollHeight - scroller.clientHeight;
    return max > 0 ? scroller.scrollTop / max : 0;
  };
  const onScroll = debounce(() => {
    updateProgressUI(frac(), "");
    saveProgress();
  }, 250);
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  // read-aloud scrolls this too, so only finger/wheel scrolling is the reader's
  for (const ev of ["touchmove", "wheel"]) scroller?.addEventListener(ev, userMoved, { passive: true });

  // restore position after layout settles
  requestAnimationFrame(() => {
    if (scroller && book.progress?.fraction) {
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = book.progress.fraction * max;
    }
    updateProgressUI(frac(), "");
  });

  let ttsStarted = false; // skip blocks scrolled above the viewport on first pass

  return {
    beginTts() { ttsStarted = false; },
    getProgress: () => ({ fraction: frac() }),
    seekFraction: (f) => {
      if (!scroller) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = f * max;
    },
    bookmark: () => ({ fraction: Math.round(frac() * 1000) / 1000 }),
    gotoBookmark: (t) => {
      if (!scroller) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = t.fraction * max;
    },
    turn: (dir) => {
      if (!scroller) return;
      scroller.scrollBy({ top: (dir === "next" ? 1 : -1) * scroller.clientHeight * 0.92, behavior: "smooth" });
    },
    async *textBlocks() {
      if (isHtml) {
        // sandboxed iframe content is unreachable — parse text for speech only (no highlight)
        const hdoc = new DOMParser().parseFromString(text, "text/html");
        for (const b of extractBlocks(hdoc)) yield { el: null, text: b.text };
        return;
      }
      // start read-aloud at the visible position, not the document top
      const chromeUp = !wrap.closest(".chrome-hidden");
      const top = wrap.getBoundingClientRect().top + (chromeUp ? CHROME_TOP : 0);
      const above = (rect) => rect.bottom <= top;
      for (const b of extractBlocks(wrap)) {
        if (!ttsStarted && b.el?.isConnected) {
          const rect = b.el.getBoundingClientRect();
          if (above(rect)) continue;
          if (rect.top < top) {
            // cut by the top of the screen — begin at its first visible sentence
            const at = resumePoint(b.el, b.text, (r) => above(r.getBoundingClientRect()));
            if (!at) continue;
            ttsStarted = true;
            yield { ...b, ...at };
            continue;
          }
        }
        ttsStarted = true;
        yield b;
      }
    },
    advance: () => false, // single-page text — no next section
    highlight,
    clearHighlight: clearHl,
    destroy: () => wrap.remove(),
  };
};
