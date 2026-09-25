/**
 * smoke.mjs — headless end-to-end smoke test.
 * Serves docs/ locally, opens index.html in Chrome, then drives the
 * real import pipeline (detect → foliate → importer → IndexedDB)
 * against an in-memory EPUB. No test files ship in docs/.
 *
 * Usage: npm run smoke
 *        CHROME_PATH=/path/to/chrome npm run smoke
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("../docs/", import.meta.url));
const PORT = 3891;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".data": "application/octet-stream",
};

const server = http.createServer(async (req, res) => {
  try {
    const path = normalize(join(ROOT, decodeURIComponent(req.url.split("?")[0])));
    if (!path.startsWith(normalize(ROOT))) throw new Error("traversal");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome");

// Runs in the page. Build a minimal EPUB, run the import pipeline.
const testFn = async (withPiper) => {
  const results = [];
  const log = (ok, msg) => results.push(`${ok ? "PASS" : "FAIL"}: ${msg}`);

  try {
    const { zipSync, strToU8: S } = await import("./vendor/fflate.mjs");
    const epub = zipSync({
      "mimetype": [S("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": S(`<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>`),
      "OEBPS/content.opf": S(`<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Smoke Test Book</dc:title>
            <dc:creator>Test Author</dc:creator>
            <dc:language>en</dc:language>
            <dc:identifier id="id">smoke-1</dc:identifier>
          </metadata>
          <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
          <spine><itemref idref="ch1"/></spine>
        </package>`),
      // long enough to paginate into several pages, so read-aloud's
      // "start at the top of the page I'm on" behaviour is testable
      "OEBPS/ch1.xhtml": S(`<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>C1</title></head>
        <body><h1 id="top">Chapter One</h1><p>Hello world. This is a test paragraph.</p>${
          Array.from({ length: 60 }, (_, i) =>
            `<p>Para${String(i + 1).padStart(2, "0")}. ${
            // unique sentences, several per paragraph, so pages break mid-paragraph
            // and a spoken chunk can be located exactly
            Array.from({ length: 5 }, (_, k) => `S${i + 1}x${k} lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`).join(" ")}</p>`).join("")
        }<p id="refs">A claim needing a source<a id="noteref" epub:type="noteref" href="#fn1">1</a> and <a id="xref" href="#top">a cross-reference</a>.</p>
        <aside id="fn1" epub:type="footnote"><p>Footnoted source text.</p></aside>
        </body></html>`),
    });
    const file = new File([epub], "smoke.epub", { type: "application/epub+zip" });

    const { detectFormat } = await import("./js/detect.js");
    const d = await detectFormat(file);
    log(d.kind === "ebook" && d.format === "EPUB", `detect epub → ${d.kind}/${d.format}`);

    const { makeBook } = await import("./vendor/foliate/view.js");
    const book = await makeBook(file);
    const title = typeof book.metadata?.title === "object"
      ? Object.values(book.metadata.title)[0] : book.metadata?.title;
    log(!!book.sections?.length, `foliate makeBook → ${book.sections?.length} sections, title="${title}"`);

    const { putFile, getFile } = await import("./js/db.js");
    await putFile("probe", new Blob(["hi"]), {});
    log((await getFile("probe"))?.size === 2, "idb probe");

    const { importFiles } = await import("./js/importer.js");
    const created = await importFiles([file]);
    log(created.length === 1 && created[0].title === "Smoke Test Book",
      `importFiles → ${JSON.stringify(created[0]?.title)}`);

    const { getBook } = await import("./js/db.js");
    const stored = await getBook(created[0].id);
    const blob = await getFile(stored.fileKey);
    log(blob && blob.size === file.size, `idb round-trip → file ${blob?.size}b`);

    // 4b. bulk zip import — 2 audiobook folders + a txt → 3 books
    const bulk = zipSync({
      "Series Alpha/01.mp3": S("FAKEMP3A1"), "Series Alpha/02.mp3": S("FAKEMP3A2"),
      "Beta Book/ch1.mp3": S("FAKEMP3B1"),
      // long enough to scroll, so the text renderer's reflow-keeps-your-place
      // behaviour is testable. "text here" stays unique for the search test.
      "notes.txt": S("some text here\n\n" + Array.from(
        { length: 80 },
        (_, i) => `Note paragraph ${i + 1}. ${"filler words to make this wrap and scroll. ".repeat(4)}`,
      ).join("\n\n")),
    });
    const zipFile = new File([bulk], "bulk.zip", { type: "application/zip" });
    const bulkCreated = await importFiles([zipFile]);
    const kinds = bulkCreated.map((b) => b.kind).sort().join(",");
    const titles = bulkCreated.map((b) => b.title).sort().join(" | ");
    log(bulkCreated.length === 3 && kinds === "audio,audio,text",
      `bulk zip → ${bulkCreated.length} books (${titles})`);

    // 5. real reader open path — foliate view renders the imported book
    const { openReader, closeReader } = await import("./js/reader.js");
    await openReader(stored);
    await new Promise((r) => setTimeout(r, 2500)); // let paginator lay out
    const rendered = !!document.querySelector("foliate-view") &&
      !document.getElementById("view-reader").hidden;
    log(rendered, "reader opens foliate-view");

    // The section the reader opens on must be wired too. view.init() renders
    // it and fires "load" synchronously, so listeners registered after init
    // missed it — leaving that section with no tap/key handling, no text
    // selection and no justification. pt-flow is the visible proof it ran.
    {
      const d0 = document.querySelector("foliate-view").renderer
        ?.getContents?.().find((c) => c.doc)?.doc;
      const flowed = d0?.querySelectorAll(".pt-flow").length || 0;
      log(flowed > 0, `opening section is wired (${flowed} paragraphs marked)`);
    }

    // 6. TTS highlight machinery on the live foliate doc
    const { extractBlocks, rangeForChunk } = await import("./js/util.js");
    const { Overlayer } = await import("./vendor/foliate/overlayer.js");
    const fv = document.querySelector("foliate-view");
    const contents = fv.renderer.getContents?.() ?? [];
    const firstDoc = contents.find((c) => c.doc)?.doc;
    const blocks = firstDoc ? [...extractBlocks(firstDoc)] : [];
    const block = blocks[0] ?? null;
    // the section's prose must all come through, not just its heading
    const dense = (s) => (s || "").replace(/\s+/g, "").length;
    const spokenChars = blocks.reduce((n, b) => n + dense(b.text), 0);
    const docChars = dense(firstDoc?.body?.textContent);
    log(docChars > 0 && spokenChars >= docChars,
      `tts blocks → ${blocks.length} blocks, ${spokenChars}/${docChars} chars`);
    const ov = contents.find((c) => c.doc === firstDoc)?.overlayer;
    let hlRects = 0;
    if (block && ov) {
      const found = rangeForChunk(block.el, block.text.split(/\s+/).slice(0, 3).join(" "), 0);
      const range = found?.range ?? (() => { const r = block.doc.createRange(); r.selectNodeContents(block.el); return r; })();
      ov.add("tts", range, Overlayer.highlight, { color: "#f0a040" });
      hlRects = ov.element.querySelectorAll("rect").length;
      ov.remove("tts");
    }
    log(hlRects > 0, `tts highlight → ${hlRects} rects drawn`);

    // 7. pressing play must start at the top of the page on screen, not skip
    //    ahead. Drives the real renderer, so it covers beginTts/textBlocks.
    const { currentRenderer } = await import("./js/reader.js");
    for (let i = 0; i < 3; i++) { await fv.next(); await new Promise((r) => setTimeout(r, 450)); }
    const vis = fv.lastLocation?.range;
    const rend = currentRenderer();
    rend.beginTts();
    const firstBlock = (await rend.textBlocks().next()).value;
    // ground truth: the block containing where the visible range begins
    const BLOCKISH = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|DIV|TD)$/;
    let topEl = vis?.startContainer;
    while (topEl && (topEl.nodeType !== 1 ||
           !BLOCKISH.test((topEl.localName || topEl.tagName || "").toUpperCase())))
      topEl = topEl.parentNode;
    log(!!firstBlock && !!topEl && firstBlock.el === topEl,
      `tts starts at top of page → spoke "${firstBlock?.text.slice(0, 10)}", page top "${(topEl?.textContent || "").trim().slice(0, 10)}"`);

    // 8. the real controller, against a stub speech engine that records what
    //    it's asked to say. Ground truth for "where should speech start" is
    //    the first sentence, in document order, not wholly above the page.
    const { chunk } = await import("./js/util.js");
    const { ttsController } = await import("./js/tts.js");
    const said = [];
    const refused = [];
    const stub = {
      speaking: false, pending: false, paused: false, _u: null, _t: 0,
      getVoices: () => [], resume() {}, pause() {}, addEventListener() {},
      cancel() {
        const u = this._u;
        this._u = null; this.speaking = false; clearTimeout(this._t);
        u?.onerror?.({ error: "interrupted" });
      },
      refuse: 0, // >0: refuse that many utterances the way iOS does (not-allowed)
      speak(u) {
        // the silent gesture-unlock utterance: ends at once, never started
        if (!u.text.trim()) { setTimeout(() => u.onend?.(), 0); return; }
        if (this.refuse > 0) {
          this.refuse--; refused.push(u.text);
          setTimeout(() => u.onerror?.({ error: "not-allowed" }), 0);
          return;
        }
        this._u = u; this.speaking = true; said.push(u.text); u.onstart?.();
        this._t = setTimeout(() => {
          if (this._u !== u) return;
          this._u = null; this.speaking = false; u.onend?.();
        }, 40);
      },
    };
    Object.defineProperty(window, "speechSynthesis", { value: stub, configurable: true });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const liveDoc = () => (fv.renderer.getContents?.() ?? []).find((c) => c.doc)?.doc;
    const expectedStart = () => {
      const loc = fv.lastLocation.range;
      for (const b of extractBlocks(liveDoc())) {
        let from = 0;
        for (const c of chunk(b.text)) {
          const f = rangeForChunk(b.el, c, from);
          if (f && f.range.compareBoundaryPoints(Range.START_TO_END, loc) >= 0) return c;
          if (f) from = f.end;
        }
      }
      return null;
    };
    const getR = () => currentRenderer();

    const want1 = expectedStart();
    const midPara = !!want1 && !/^Para\d+\./.test(want1);
    await ttsController.start(getR, { title: "Smoke" });
    await wait(150);
    log(said[0] === want1,
      `controller starts on first visible sentence${midPara ? " (mid-paragraph)" : ""} → "${said[0]?.slice(0, 12)}", want "${want1?.slice(0, 12)}"`);

    ttsController.pause();
    const cut = said[said.length - 1]; // in flight when paused
    const n = said.length;
    await wait(200);
    log(said.length === n, `pause stops speech → ${said.length - n} chunk(s) after pause`);
    ttsController.resume();
    await wait(20);
    log(said[n] === cut, `resume restarts the interrupted sentence → "${said[n]?.slice(0, 12)}"`);

    await wait(150);
    const before = said[said.length - 1];
    const hist = ttsController._history;
    const prevText = hist[hist.lastIndexOf(ttsController._cur) - 1]?.text;
    const m = said.length;
    ttsController.skip(-1);
    await wait(100);
    log(!!prevText && said[m] === prevText,
      `skip back → "${said[m]?.slice(0, 12)}" (was on "${before?.slice(0, 12)}")`);

    // pause, turn the page by hand, resume → read what's on screen now
    ttsController.pause();
    await wait(700);
    await fv.next(); await wait(500);
    const want2 = expectedStart();
    const k = said.length;
    ttsController.resume();
    await wait(200);
    log(!!want2 && said[k] === want2,
      `resume after a page turn starts on the new page → "${said[k]?.slice(0, 12)}", want "${want2?.slice(0, 12)}"`);
    ttsController.stop();
    const k2 = said.length;
    await wait(150);
    log(said.length === k2 && !ttsController.playing, "stop silences the controller");

    // 8b. iOS refusing an utterance (not-allowed / audio-busy) used to count
    //     as "spoken", so a refusing engine raced silently through the book.
    //     A refused sentence must be retried, not skipped.
    const want3 = expectedStart();
    said.length = 0; refused.length = 0; stub.refuse = 2;
    await ttsController.start(getR, {});
    await wait(1400);
    log(refused.length === 2 && refused.every((t) => t === want3) && said[0] === want3,
      `refused speech is retried, not skipped → refused ${refused.length}× "${refused[0]?.slice(0, 12)}", then spoke "${said[0]?.slice(0, 12)}"`);
    ttsController.stop();

    // 8c. an engine that never plays pauses in place instead of racing ahead
    said.length = 0; refused.length = 0; stub.refuse = 99;
    await ttsController.start(getR, {});
    await wait(1600);
    log(!ttsController.playing && !!ttsController._session && said.length === 0 &&
        refused.length === 3 && refused.every((t) => t === want3),
      `mute engine pauses on the same sentence → ${refused.length} attempts, playing=${ttsController.playing}`);
    ttsController.stop();
    stub.refuse = 0;

    // 8d. audio-engine path (what iPhone uses): sentences are generated
    //     ahead and played as clips through one <audio> element. A fake
    //     engine returns short silent clips, so the real player, queue,
    //     pause-mid-clip and skip-back all run.
    {
      const { engines, settings } = await import("./js/tts-engines.js");
      const silentClip = (ms) => {
        const rate = 8000, n = Math.round(rate * ms / 1000), b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
        const ws = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt "); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 2, true);
        return new Blob([b], { type: "audio/wav" });
      };
      const synthed = [];
      engines.fake = {
        id: "fake", kind: "audio", ready: () => true, ensure: async () => {},
        synth: (text) => { synthed.push(text); return new Promise((r) => setTimeout(() => r(silentClip(250)), 20)); },
      };
      const voiced = [];
      const origVoice = ttsController._voice;
      ttsController._voice = function (s, ses) { if (this.playing && this._cur !== s) voiced.push(s.text); return origVoice.call(this, s, ses); };
      const prevEngine = settings.engine;
      settings.engine = "fake";
      // ground truth: every sentence in document order from the visible start
      const order = [];
      { const loc = fv.lastLocation.range; let started = false;
        for (const b of extractBlocks(liveDoc())) { let from = 0;
          for (const c of chunk(b.text)) { const f2 = rangeForChunk(b.el, c, from);
            if (!started && f2 && f2.range.compareBoundaryPoints(Range.START_TO_END, loc) >= 0) started = true;
            if (started) order.push(c); if (f2) from = f2.end; } } }
      await ttsController.start(getR, {});
      await wait(900);
      const ahead = synthed.length - voiced.length;
      ttsController.pause();
      const pausedClip = !!ttsController._pausedClip;
      const nPaused = voiced.length;
      await wait(400);
      const heldWhilePaused = voiced.length === nPaused;
      ttsController.resume();
      await wait(700);
      const inOrder = voiced.every((t, i) => t === order[i]);
      log(voiced[0] === order[0] && inOrder && voiced.length >= 4,
        `audio engine reads in order from the page → ${voiced.length} sentences, first "${voiced[0]?.slice(0, 12)}"`);
      log(ahead >= 1, `audio engine generates ahead of playback → ${ahead} sentence(s) ahead`);
      log(pausedClip && heldWhilePaused, `pause holds the clip mid-sentence → pausedClip=${pausedClip}, silent while paused=${heldWhilePaused}`);
      const k3 = voiced.length;
      const back = ttsController._history.at(-2)?.text;
      ttsController.skip(-1);
      await wait(150);
      log(!!back && voiced[k3] === back, `audio skip back → "${voiced[k3]?.slice(0, 12)}", want "${back?.slice(0, 12)}"`);
      ttsController.stop();
      ttsController._voice = origVoice;
      settings.engine = prevEngine;
      delete engines.fake;
    }

    // 8a2. Read-aloud and the audiobook player are separate engines that both
    //      take over the Media Session. Starting one while the other played
    //      left two voices talking at once.
    {
      const { claimAudio, registerAudioOwner } = await import("./js/audio-focus.js");
      await ttsController.start(getR, {});
      await wait(400);
      const wasPlaying = ttsController.playing;
      claimAudio("audiobook"); // what the player does on its play event
      await wait(150);
      log(wasPlaying && !ttsController.playing,
        `starting an audiobook pauses read-aloud (was ${wasPlaying}, now ${ttsController.playing})`);

      // and it pauses rather than stops, so the sentence survives for resume
      log(!!ttsController._session,
        "read-aloud keeps its session, so it can be resumed");

      // the reverse direction: read-aloud claims focus off the audiobook
      let bookPaused = 0;
      registerAudioOwner("audiobook", () => { bookPaused++; });
      ttsController.resume();
      await wait(300);
      log(bookPaused > 0, `read-aloud pauses the audiobook (${bookPaused} pause call)`);
      ttsController.stop();
    }

    // 8a3. The progress slider used to seek on every input event, which for
    //      an EPUB is a section load per pixel dragged. Preview on input,
    //      commit on release.
    {
      const el = (id) => document.getElementById(id);
      const slider = el("reader-slider");
      const startCfi = fv.lastLocation?.cfi;
      let seeks = 0;
      const realGoToFraction = fv.goToFraction.bind(fv);
      fv.goToFraction = (f) => { seeks++; return realGoToFraction(f); };

      for (const v of [300, 400, 500, 600]) {
        slider.value = v;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await wait(200);
      const duringDrag = seeks;
      const previewed = el("reader-pct").textContent;

      slider.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(900);
      log(duringDrag === 0 && seeks === 1 && previewed === "60%",
        `slider previews while dragging, seeks once on release (${duringDrag} during, ${seeks} total, showed ${previewed})`);
      log(fv.lastLocation?.cfi !== startCfi, "the committed seek actually moved");
      fv.goToFraction = realGoToFraction;
    }

    // 8b. in-book search: drives the real renderer capability, so it covers
    //     foliate's section-by-section scan, the excerpt shape the results
    //     list renders, and that a hit's target can be navigated to.
    {
      const rend2 = currentRenderer();
      const groups = [];
      let progressed = false;
      for await (const r of rend2.search("Para07")) {
        if (r.progress != null) progressed = true;
        if (r.items?.length) groups.push(r);
      }
      const hits = groups.flatMap((g) => g.items);
      const ex = hits[0]?.excerpt;
      log(hits.length === 1 && ex?.match === "Para07" && !!hits[0].target?.cfi,
        `search "Para07" → ${hits.length} hit, match=${JSON.stringify(ex?.match)}, progress=${progressed}`);

      // a phrase spanning normalised whitespace still matches, and every
      // occurrence is reported rather than just the first
      const many = [];
      for await (const r of rend2.search("lorem ipsum dolor")) if (r.items) many.push(...r.items);
      log(many.length > 10, `search phrase → ${many.length} hits`);

      // navigating to a hit lands on the section it was found in
      const before = fv.lastLocation?.cfi;
      await rend2.goToSearch(hits[0].target);
      await new Promise((r) => setTimeout(r, 600));
      log(!!fv.lastLocation?.cfi, `search hit navigates (cfi ${before ? "changed" : "set"})`);
      rend2.clearSearch();
    }

    // 8b2. footnotes open in place, and every other jump leaves a way back.
    //      Before this, tapping a note sent you to the endnotes with no back
    //      control anywhere in the reader.
    {
      const el = (id) => document.getElementById(id);
      const doc2 = fv.renderer.getContents?.().find((c) => c.doc)?.doc;
      const noteref = doc2?.getElementById("noteref");

      noteref?.click();
      for (let i = 0; i < 40 && el("sheet-note").hidden; i++) await wait(100);
      const noteOpen = !el("sheet-note").hidden;
      // the note's own text is rendered into a detached view inside the sheet
      let noteText = "";
      for (let i = 0; i < 30; i++) {
        const nv = el("note-body").querySelector("foliate-view");
        noteText = nv?.renderer?.getContents?.().find((c) => c.doc)?.doc?.body?.textContent || "";
        if (noteText.includes("Footnoted")) break;
        await wait(100);
      }
      log(noteOpen && noteText.includes("Footnoted source text") &&
          el("note-kind").textContent === "Footnote",
        `footnote popover → ${JSON.stringify(noteText.trim().slice(0, 28))}, kind "${el("note-kind").textContent}"`);

      // following a note from the popover leaves a Back chip
      el("note-goto").click();
      await wait(800);
      log(el("sheet-note").hidden && !el("reader-back").hidden,
        "Go to note closes the popover and offers Back");

      // and Back returns to where the note was tapped
      el("reader-back").click();
      await wait(800);
      log(el("reader-back").hidden, "Back returns and clears the chip");

      // a plain cross-reference navigates, but also leaves a way back
      const doc3 = fv.renderer.getContents?.().find((c) => c.doc)?.doc;
      doc3?.getElementById("xref")?.click();
      await wait(800);
      log(!el("reader-back").hidden, "a cross-reference leaves a Back chip");
      el("reader-back").click();
      await wait(600);

      // selecting text offers more than one action, and Copy carries the
      // passage plus the book it came from
      const doc4 = fv.renderer.getContents?.().find((c) => c.doc)?.doc;
      const para = doc4?.querySelector("p");
      const sel = doc4?.getSelection?.();
      const r = doc4.createRange();
      r.selectNodeContents(para);
      sel.removeAllRanges();
      sel.addRange(r);
      para.dispatchEvent(new Event("mouseup", { bubbles: true }));
      await wait(250);
      const chip = document.querySelector(".sel-chip");
      const labels = [...(chip?.querySelectorAll(".sel-chip-btn") || [])].map((b) => b.textContent);
      log(labels.includes("Highlight") && labels.includes("Copy"),
        `selection chip → ${JSON.stringify(labels)}`);

      let copied = "";
      navigator.clipboard.writeText = async (t) => { copied = t; };
      [...chip.querySelectorAll(".sel-chip-btn")].find((b) => b.textContent === "Copy").click();
      await wait(200);
      log(copied.includes("Hello world") && copied.includes("Smoke Test Book"),
        `copy includes the passage and the source → ${JSON.stringify(copied.slice(-24))}`);
      log(!document.querySelector(".sel-chip"), "the chip closes after acting");
    }

    // 8c. the search UI itself: the sheet's tab, input and results list are
    //     wired by initReader() during boot, so this covers the element ids
    //     and the incremental rendering as well as the query path.
    {
      const el = (id) => document.getElementById(id);
      el("reader-toc-btn").click();
      el("contents-tabs").querySelector('[data-val="search"]').click();
      const onSearchTab = !el("contents-search-wrap").hidden && !!el("contents-search-status");
      const input = el("contents-search");
      input.value = "Para21";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      // wait for the scan to finish rather than a fixed delay
      for (let i = 0; i < 60 && !/result|No matches/.test(el("contents-search-status").textContent); i++)
        await new Promise((r) => setTimeout(r, 100));
      const rows = el("contents-results").querySelectorAll(".contents-item").length;
      const marked = el("contents-results").querySelector("mark")?.textContent;
      log(onSearchTab && rows === 1 && marked === "Para21",
        `search UI → ${rows} row, mark=${JSON.stringify(marked)}, status="${el("contents-search-status").textContent}"`);

      // clearing the box empties the list again
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      log(!el("contents-results").querySelector(".contents-item"), "clearing the query empties the results");

      // Escape closes the sheet, not the book
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      log(el("sheet-contents").hidden && !el("view-reader").hidden,
        "Escape closes the sheet and leaves the book open");
    }

    await closeReader();
    log(document.getElementById("view-reader").hidden, "reader closes");

    // 9. PDF read-aloud: wrapped lines rejoin into sentences, end-of-line
    //    hyphens are undone, page numbers are skipped, and it runs on to the
    //    next page. Builds a two-page PDF by hand.
    {
      const ops = (lines, n) => "BT /F1 12 Tf 14 TL 72 720 Td " +
        lines.map((l) => (l ? `(${l}) Tj T*` : "T*")).join(" ") +
        ` ET BT /F1 10 Tf 300 40 Td (${n}) Tj ET`;
      const c1 = ops(["The first paragraph wraps onto a", "second line. It has an infor-",
        "mation word.", "", "Another paragraph."], 1);
      const c2 = ops(["Page two text."], 2);
      const res = "/Resources << /Font << /F1 7 0 R >> >>";
      const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R ${res} >>`,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ${res} >>`,
        `<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`,
        `<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let pdf = "%PDF-1.4\n";
      const offs = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
      const xref = pdf.length;
      pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
        offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const [pb] = await importFiles([new File([S(pdf)], "smoke.pdf", { type: "application/pdf" })]);
      await openReader(await getBook(pb.id));
      await wait(1200);
      said.length = 0;
      await ttsController.start(getR, {});
      await wait(1500);
      const want = ["The first paragraph wraps onto a second line.", "It has an information word.",
        "Another paragraph.", "Page two text."];
      log(JSON.stringify(said) === JSON.stringify(want) && !ttsController.playing,
        `pdf read-aloud → ${JSON.stringify(said)}`);

      // PDF search: its own text-extraction path, page labels and targets
      ttsController.stop();
      const pdfGroups = [];
      for await (const r of getR().search("paragraph")) if (r.items) pdfGroups.push(r);
      const pdfHits = pdfGroups.flatMap((g) => g.items);
      log(pdfHits.length === 2 && pdfGroups[0].label === "Page 1" &&
          pdfHits[0].target.page === 1 && /paragraph/i.test(pdfHits[0].excerpt.match),
        `pdf search "paragraph" → ${pdfHits.length} hits on ${pdfGroups.map((g) => g.label).join(", ")}`);
      // a hit on page 2 carries that page as its target
      const p2 = [];
      for await (const r of getR().search("Page two")) if (r.items) p2.push(...r.items);
      log(p2.length === 1 && p2[0].target.page === 2,
        `pdf search finds page 2 → target page ${p2[0]?.target.page}`);

      // Rotation: a canvas is sized when it renders and renderPage() skips
      // anything already rendered, so pages used to stay at the old scale.
      // Changing the stage width stands in for turning the device.
      {
        const stage = document.getElementById("reader-stage");
        const canvasWidth = () =>
          document.querySelector(".pdf-page canvas")?.width || 0;
        const before = canvasWidth();
        // both dimensions, as a real rotation does — the page is fitted with
        // Math.min(width, height), so either one alone may not be the limit
        stage.style.width = "420px";
        stage.style.height = "320px";
        window.dispatchEvent(new Event("resize"));
        let after = before;
        for (let i = 0; i < 40; i++) {
          await wait(100);
          after = canvasWidth();
          if (after && after !== before) break;
        }
        stage.style.width = "";
        stage.style.height = "";
        window.dispatchEvent(new Event("resize"));
        await wait(600);
        log(before > 0 && after > 0 && after !== before,
          `pdf re-renders on rotation → canvas ${before}px becomes ${after}px`);
      }

      await closeReader();
      log(document.getElementById("view-reader").hidden, "pdf reader closes");
    }

    // 10. text-renderer search: the third search implementation, over the
    //     rendered blocks rather than a paginated or page-image document.
    {
      const notes = bulkCreated.find((b) => b.kind === "text");
      await openReader(await getBook(notes.id));
      await wait(600);
      const hits = [];
      for await (const r of getR().search("text here")) if (r.items) hits.push(...r.items);
      log(hits.length === 1 && hits[0].excerpt.match === "text here" &&
          typeof hits[0].target.top === "number",
        `text search → ${hits.length} hit, match=${JSON.stringify(hits[0]?.excerpt.match)}`);

      // Changing the text size reflows a scroll-based document, which moves
      // the pixel offset — the reader has to be put back at its fraction.
      {
        const wrap = document.querySelector(".text-reader");
        const max = () => wrap.scrollHeight - wrap.clientHeight;
        if (max() > 0) {
          wrap.scrollTop = max() * 0.5;
          wrap.dispatchEvent(new Event("scroll"));
          await wait(400); // let the 250ms scroll debounce record the fraction
          const before = wrap.scrollTop / max();
          document.getElementById("font-plus").click();
          document.getElementById("font-plus").click();
          await wait(300);
          const after = max() > 0 ? wrap.scrollTop / max() : 0;
          log(Math.abs(after - before) < 0.02,
            `text size keeps the place → ${before.toFixed(3)} then ${after.toFixed(3)}`);
          document.getElementById("font-minus").click();
          document.getElementById("font-minus").click();
        } else {
          log(true, "text size keeps the place (document too short to scroll)");
        }
      }
      await closeReader();
    }

    // text format detection
    const { detectFormat: df2 } = await import("./js/detect.js");
    const td = await df2(new File([S("hello world")], "note.txt", { type: "text/plain" }));
    log(td.kind === "text" && td.format === "TXT", `detect txt → ${td.kind}/${td.format}`);

    // 11. "Continue reading" — the books above were opened and read into, so
    //     the card should offer the most recent one and open it in one tap.
    {
      const { refreshLibrary } = await import("./js/library.js");
      await refreshLibrary();
      const card = document.getElementById("continue-card");
      const shown = !card.hidden;
      const title = document.getElementById("continue-title").textContent;
      const pctWidth = document.getElementById("continue-fill").style.width;
      log(shown && !!title && /%$/.test(pctWidth),
        `continue card → ${JSON.stringify(title)} at ${pctWidth}`);

      // searching hides it: it's a shortcut, not a search result
      const search = document.getElementById("library-search");
      search.value = "zzz-no-match";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const hiddenWhileSearching = card.hidden;
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      log(hiddenWhileSearching && !card.hidden, "continue card hides while searching");

      // one tap opens the book it names
      card.click();
      await wait(1500);
      const opened = !document.getElementById("view-reader").hidden ||
        !document.getElementById("view-player").hidden;
      log(opened, "continue card opens the book in one tap");
      const { closeReader: cr } = await import("./js/reader.js");
      await cr();
    }

    // 11b. Mark-as-finished / start-over. A book abandoned partway used to be
    //      stuck in the Continue card with no way to clear it.
    {
      const el = (id) => document.getElementById(id);
      const { openDetail, refreshLibrary } = await import("./js/library.js");
      const { getBook } = await import("./js/db.js");
      const before = await getBook(stored.id);
      const startFrac = before.progress?.fraction || 0;

      await openDetail(stored.id);
      el("detail-progress-btn").click();
      await wait(120);
      const rows = [...el("sheet-list-body").querySelectorAll(".sheet-list-item")]
        .map((b) => b.textContent);
      const finish = [...el("sheet-list-body").querySelectorAll(".sheet-list-item")]
        .find((b) => b.textContent.includes("finished"));
      finish.click();
      for (let i = 0; i < 40 && (await getBook(stored.id)).progress?.fraction !== 1; i++) await wait(100);
      const done = await getBook(stored.id);
      log(startFrac > 0 && startFrac < 1 && done.progress.fraction === 1,
        `mark as finished → ${startFrac.toFixed(2)} becomes ${done.progress.fraction} (rows ${JSON.stringify(rows)})`);

      // a finished book drops out of the Continue card
      await refreshLibrary();
      const continueTitle = el("continue-card").hidden
        ? null : el("continue-title").textContent;
      log(continueTitle !== stored.title,
        `finished book leaves the Continue card (now ${JSON.stringify(continueTitle)})`);

      // and starting over clears the position
      await openDetail(stored.id);
      el("detail-progress-btn").click();
      await wait(120);
      [...el("sheet-list-body").querySelectorAll(".sheet-list-item")]
        .find((b) => b.textContent.includes("beginning")).click();
      for (let i = 0; i < 40 && (await getBook(stored.id)).progress?.fraction !== 0; i++) await wait(100);
      const reset = await getBook(stored.id);
      log(reset.progress.fraction === 0 && !reset.lastOpenedAt,
        `start over clears progress → ${reset.progress.fraction}, lastOpened ${reset.lastOpenedAt}`);
      (await import("./js/util.js")).closeSheet();
    }

    // 12. Selection mode — bulk delete is destructive, so verify it ticks the
    //     right books, reports the count, and removes exactly those.
    {
      const el = (id) => document.getElementById(id);
      const { refreshLibrary, isSelecting } = await import("./js/library.js");
      const { allBooks } = await import("./js/db.js");
      await refreshLibrary();
      const startCount = (await allBooks()).length;

      el("select-btn").click();
      const entered = isSelecting() && !el("select-bar").hidden &&
        el("select-done") && !el("select-done").hidden && el("select-btn").hidden;
      log(entered, `selection mode opens (${startCount} books)`);

      // nothing ticked yet → the destructive action is unavailable
      log(el("select-delete").disabled && el("library-nav-title").textContent === "Select books",
        "delete is disabled until something is ticked");

      // tick the first two cards
      const cards = [...el("library-grid").querySelectorAll(".book-card")];
      cards[0].click();
      cards[1].click();
      const ticked = el("library-grid").querySelectorAll(".book-card.selected").length;
      log(ticked === 2 && el("select-delete").textContent === "Delete 2" &&
          el("library-nav-title").textContent === "2 selected",
        `two ticked → "${el("select-delete").textContent}", title "${el("library-nav-title").textContent}"`);

      // select all / none round-trips
      el("select-all").click();
      const allOn = el("library-grid").querySelectorAll(".book-card.selected").length;
      el("select-all").click();
      const allOff = el("library-grid").querySelectorAll(".book-card.selected").length;
      log(allOn === cards.length && allOff === 0,
        `select all → ${allOn}, then none → ${allOff}`);

      // delete two for real, through the confirm sheet
      const doomed = [...el("library-grid").querySelectorAll(".book-card")].slice(0, 2);
      const doomedIds = doomed.map((c) => c.dataset.id);
      doomed.forEach((c) => c.click());
      el("select-delete").click();
      await wait(120);
      // the confirm sheet's only row is the destructive one
      el("sheet-list-body").querySelector(".sheet-list-item").click();
      for (let i = 0; i < 50 && (await allBooks()).length > startCount - 2; i++) await wait(100);
      const after = await allBooks();
      const goneBoth = doomedIds.every((id) => !after.some((b) => b.id === id));
      log(after.length === startCount - 2 && goneBoth && !isSelecting(),
        `bulk delete → ${startCount} - 2 = ${after.length}, selection mode closed`);
    }

    // 12b. Saved voices. Piper used to save voices to OPFS with
    //      createWritable(), which Safari lacks — so iPhone and iPad downloaded
    //      the ~60 MB voice every session. Voices now live in the Cache API.
    //      A stand-in voice is seeded here rather than downloading 60 MB.
    {
      const el = (id) => document.getElementById(id);
      const piperMod = await import("./vendor/piper/piper-tts-web.js");
      const KEY = "en_US-amy-low";
      const url = `${piperMod.HF_BASE}/${piperMod.PATH_MAP[KEY]}`;
      const voices = await caches.open("pageturner-voices");
      await voices.put(url, new Response(new Blob(["fake model"]), { headers: { "content-length": "10" } }));
      await voices.put(`${url}.json`, new Response("{}"));
      log((await piperMod.stored()).includes(KEY), `a voice in the Cache API is listed as stored (${KEY})`);

      // voices saved to OPFS by earlier builds (Chrome, where it worked) still count
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("piper", { create: true });
      const LEGACY = "en_GB-alan-low";
      const fh = await dir.getFileHandle(`${LEGACY}.onnx`, { create: true });
      const w = await fh.createWritable(); await w.write("legacy"); await w.close();
      log((await piperMod.stored()).includes(LEGACY), "voices saved by earlier builds (OPFS) are still found");

      // the Saved voices sheet lists both, with sizes, and can remove one
      const tv = await import("./js/tts-voices.js");
      await tv.openSavedVoices();
      await wait(150);
      const rows = [...el("sheet-list-body").querySelectorAll(".sheet-list-row")];
      const titles = rows.map((r) => r.querySelector(".item-title")?.textContent || "");
      log(rows.length === 2 && titles.some((t) => /Amy/i.test(t)) && /on this device/.test(el("sheet-list-body").textContent),
        `Saved voices sheet → ${JSON.stringify(titles)}`);
      const amyRow = rows.find((r) => /Amy/i.test(r.textContent));
      amyRow.querySelector(".sheet-list-action").click();
      for (let i = 0; i < 30 && (await piperMod.stored()).includes(KEY); i++) await wait(100);
      log(!(await piperMod.stored()).includes(KEY) && !(await voices.match(url)),
        "Remove deletes the voice from the device");
      (await import("./js/util.js")).closeSheet();
      await piperMod.remove(LEGACY);
      log(!(await piperMod.stored()).includes(LEGACY), "removing a legacy OPFS voice works too");
    }

    // 13. Backup round trip. The exporter was rewritten to assemble the zip
    //     by reference instead of copying the library into memory, so check
    //     the whole cycle: export → lose a book → restore → same bytes back.
    {
      const { exportLibrary, restoreBackup } = await import("./js/backup.js");
      const { readZip } = await import("./js/zip.js");
      const { allBooks, getFile, deleteBook, getBook: gb } = await import("./js/db.js");
      const books = await allBooks();
      const victim = books.find((b) => b.fileKey);
      const originalBytes = new Uint8Array(await (await getFile(victim.fileKey)).arrayBuffer());

      const { blob } = await exportLibrary();
      const names = (await readZip(blob)).map((e) => e.name);
      log(names[0] === "data.json" && names.some((n) => n.startsWith("files/")),
        `backup exports a readable zip → ${names.length} entries, data.json first`);

      await deleteBook(victim.id);
      const missing = !(await gb(victim.id));
      const n = await restoreBackup(new File([blob], "backup.zip"));
      const back = await gb(victim.id);
      const restoredBytes = new Uint8Array(await (await getFile(back?.fileKey)).arrayBuffer());
      const same = restoredBytes.length === originalBytes.length &&
        restoredBytes.every((b, i) => b === originalBytes[i]);
      log(missing && back?.title === victim.title && same && n === books.length,
        `restore brings a deleted book back byte-for-byte (${restoredBytes.length} bytes, ${n} books)`);

      // backups made before this change were deflated by fflate — they must
      // still restore
      const { zipSync, strToU8 } = await import("./vendor/fflate.mjs");
      const oldId = "old-format-book";
      const oldZip = zipSync({
        "data.json": strToU8(JSON.stringify({
          v: 1, app: "pageturner", books: [{ id: oldId, kind: "text", format: "TXT",
            title: "From an old backup", fileKey: "file:old", fileName: "old.txt" }],
          kv: {}, fileMeta: { "file:old": { name: "old.txt", size: 11, type: "text/plain" } },
        })),
        "files/file%3Aold": strToU8("old content"),
      }, { level: 6 });
      await restoreBackup(new File([oldZip], "old-backup.zip"));
      const oldBook = await gb(oldId);
      const oldText = await (await getFile("file:old"))?.text();
      log(oldBook?.title === "From an old backup" && oldText === "old content",
        `old deflated backups still restore → ${JSON.stringify(oldText)}`);

      // and a file that isn't a backup at all gets a sentence, not a stack
      let msg = "";
      try { await restoreBackup(new File(["hello"], "notes.txt")); } catch (e) { msg = e.message; }
      log(/isn.t a Pageturner backup/.test(msg), `non-backup is refused plainly → ${JSON.stringify(msg)}`);
    }

    // optional: neural TTS — downloads ~60MB voice model on first run
    if (withPiper) {
      const mod = await import("./vendor/piper/piper-tts-web.js");
      const wasmBase = new URL("./vendor/piper/", location.href).href;
      const ortBase = new URL("./vendor/ort/", location.href).href;
      const session = await mod.TtsSession.create({
        voiceId: "en_US-lessac-medium",
        wasmPaths: {
          onnxWasm: ortBase,
          piperWasm: wasmBase + "piper_phonemize.wasm",
          piperData: wasmBase + "piper_phonemize.data",
        },
        progress: (() => { let last = -1; return (p) => {
          const pct = p.total ? Math.floor(p.loaded / p.total * 20) * 5 : 0;
          if (pct !== last) { last = pct; console.log(`SMOKE STEP: voice dl ${pct}%`); }
        }; })(),
      });
      log(!!session, "piper session created (model downloaded)");
      const wav = await session.predict("Hello world.");
      log(wav instanceof Blob && wav.size > 1000, `piper predict → ${wav?.size}b wav`);
    }
  } catch (err) {
    log(false, `${err.message} :: ${(err.stack || "").split("\n")[1] || ""}`);
  }
  return results;
};

const main = async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    // clips play without a real tap in the audio-engine checks
    args: ["--disable-gpu", "--no-first-run", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
      else if (m.text().startsWith("SMOKE STEP")) console.log(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    // boot the real app — catches module-load/console errors
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle0" });
    const bootErrors = consoleErrors.filter((e) => !e.includes("favicon"));
    console.log(bootErrors.length
      ? `BOOT: ${bootErrors.length} console error(s)\n  ${bootErrors.join("\n  ")}`
      : "BOOT: clean");

    const results = await page.evaluate(testFn, !!process.env.SMOKE_PIPER);
    for (const r of results) console.log(r);
    const failed = results.some((r) => r.startsWith("FAIL"));
    process.exitCode = failed || bootErrors.length ? 1 : 0;
    console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
  } finally {
    await browser.close();
    server.close();
  }
};

main().catch((e) => { console.error(e); process.exitCode = 1; server.close(); });
