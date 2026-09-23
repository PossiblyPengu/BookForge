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
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>C1</title></head>
        <body><h1>Chapter One</h1><p>Hello world. This is a test paragraph.</p>${
          Array.from({ length: 60 }, (_, i) =>
            `<p>Para${String(i + 1).padStart(2, "0")}. ${
            // unique sentences, several per paragraph, so pages break mid-paragraph
            // and a spoken chunk can be located exactly
            Array.from({ length: 5 }, (_, k) => `S${i + 1}x${k} lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`).join(" ")}</p>`).join("")
        }</body></html>`),
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
      "Beta Book/ch1.mp3": S("FAKEMP3B1"), "notes.txt": S("some text here"),
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
    const cur = ttsController._cur;
    const prevText = cur && cur.i > 0 ? cur.chunks[cur.i - 1]
      : ttsController._history.at(-2)?.chunks.at(-1);
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
      await closeReader();
      log(document.getElementById("view-reader").hidden, "pdf reader closes");
    }

    // text format detection
    const { detectFormat: df2 } = await import("./js/detect.js");
    const td = await df2(new File([S("hello world")], "note.txt", { type: "text/plain" }));
    log(td.kind === "text" && td.format === "TXT", `detect txt → ${td.kind}/${td.format}`);

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
    args: ["--disable-gpu", "--no-first-run"],
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
