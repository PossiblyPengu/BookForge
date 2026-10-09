import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve("docs");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const p = path.normalize(path.join(ROOT, url === "/" ? "index.html" : url));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); res.end(); }
    else { res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(b); }
  });
}).listen(3892, async () => {
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto("http://localhost:3892/");
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: "shot-light.png" });
  await browser.close(); server.close(); console.log("done");
});
