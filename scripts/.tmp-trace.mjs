/**
 * One-off: stub the speech engine, run the real TTS controller, and record
 * the exact order of blocks it speaks. Reveals where it jumps.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("../docs/", import.meta.url));
const PORT = 3895;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
const server = http.createServer(async (req, res) => {
  try {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split("?")[0])));
    const body = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise((r) => server.listen(PORT, r));

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "shell", args: ["--disable-gpu", "--no-first-run", "--mute-audio"] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 900 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle0" });

const out = await page.evaluate(async () => {
  const log = [];
  const { zipSync, strToU8: S } = await import("./vendor/fflate.mjs");
  const chap = (n, count) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${n}</title></head><body><h1>Chapter ${n}</h1>` +
    Array.from({ length: count }, (_, i) => `<p>C${n}P${String(i + 1).padStart(2, "0")}. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit sed do. ".repeat(2)}</p>`).join("") +
    `</body></html>`;
  const epub = zipSync({
    "mimetype": [S("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": S(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": S(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Trace Book</dc:title><dc:language>en</dc:language><dc:identifier id="id">tr-1</dc:identifier></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    "OEBPS/c1.xhtml": S(chap(1, 90)),
    "OEBPS/c2.xhtml": S(chap(2, 10)),
  });
  const file = new File([epub], "trace.epub", { type: "application/epub+zip" });

  const { importFiles } = await import("./js/importer.js");
  const [created] = await importFiles([file]);
  const { getBook } = await import("./js/db.js");
  const { openReader, currentRenderer } = await import("./js/reader.js");
  await openReader(await getBook(created.id));
  await new Promise((r) => setTimeout(r, 2500));

  const fv = document.querySelector("foliate-view");
  const doc = fv.renderer.getContents()[0]?.doc;
  const { extractBlocks } = await import("./js/util.js");
  const order = [...extractBlocks(doc)].map((b) => b.text.split(".")[0]);
  log.push(`chapter 1: ${order.length} blocks, ${fv.renderer.pages} pages`);

  for (let i = 0; i < 3; i++) { await fv.next(); await new Promise((r) => setTimeout(r, 400)); }
  log.push(`page shows: ${fv.lastLocation?.range?.toString().trim().split(".")[0]}`);

  // --- stub the speech engine: every utterance "speaks" in 5ms ---
  const spoken = [];
  class FakeUtterance {
    constructor(t) { this.text = t; }
  }
  const fakeSynth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [],
    addEventListener() {},
    speak(u) {
      spoken.push(u.text);
      this.speaking = true;
      setTimeout(() => { this.speaking = false; u.onstart?.(); u.onend?.(); }, 5);
    },
    cancel() { this.speaking = false; },
    pause() {}, resume() {},
  };
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
  Object.defineProperty(window, "speechSynthesis", { value: fakeSynth, configurable: true, writable: true });

  const { ttsController } = await import("./js/tts.js");
  ttsController.settings.engine = "web";
  const rend = currentRenderer();
  await ttsController.start(() => rend, { title: "Trace" });
  await new Promise((r) => setTimeout(r, 20000));
  ttsController.stop();

  // reduce spoken chunk texts to their block ids (C1P07 etc.)
  const ids = [];
  for (const t of spoken) {
    const m = t.match(/C\d+P\d+|Chapter \d+/);
    const id = m ? m[0] : t.slice(0, 12);
    if (ids[ids.length - 1] !== id) ids.push(id);
  }
  log.push(`spoke ${spoken.length} chunks across ${ids.length} blocks`);
  const nums = ids.filter((i) => /^C1P/.test(i)).map((i) => +i.slice(3));
  const gaps = [];
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i-1] + 1) gaps.push(nums[i-1] + " -> " + nums[i]);
  log.push(`block ids: ${ids.join(" ")}`);
  log.push(gaps.length ? `GAPS: ${gaps.join(", ")}` : "no gaps - fully sequential");
  return log;
});

console.log(out.join("\n"));
if (errs.length) console.log("\nPAGE ERRORS:\n" + errs.slice(0, 8).join("\n"));
await browser.close();
server.close();
