/**
 * generate-icons.js
 *
 * Renders docs/icon.svg into the PNG icons required for installability:
 *   - apple-touch-icon (iOS home screen — ignores SVG/manifest icons)
 *   - manifest icons (192/512) in both "any" and "maskable" purposes
 *   - a PNG favicon fallback
 *
 * Usage:
 *   node scripts/generate-icons.js
 *
 * Requirements: @resvg/resvg-js (devDependency).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.join(__dirname, "..", "docs");
const ICONS_DIR = path.join(DOCS_DIR, "icons");
const SVG_PATH = path.join(DOCS_DIR, "icon.svg");

// "any"/favicon icons keep the rounded-square artwork on transparency.
// Apple and maskable icons must be full-bleed opaque squares — the OS
// applies its own rounded mask — so we flatten the rect's corner radius.
const svgAny = fs.readFileSync(SVG_PATH, "utf8");
const svgSolid = svgAny.replace('rx="64"', 'rx="0"');
if (svgSolid === svgAny) {
  console.error("Could not produce solid icon variant — icon.svg changed?");
  process.exit(1);
}

const TARGETS = [
  // iOS home screen (opaque, full-bleed)
  { file: "apple-touch-icon.png", size: 180, svg: svgSolid },
  { file: "apple-touch-icon-120.png", size: 120, svg: svgSolid },
  { file: "apple-touch-icon-152.png", size: 152, svg: svgSolid },
  { file: "apple-touch-icon-167.png", size: 167, svg: svgSolid },
  { file: "apple-touch-icon-180.png", size: 180, svg: svgSolid },
  // Manifest — "any" (rounded artwork ok)
  { file: "icon-192.png", size: 192, svg: svgAny },
  { file: "icon-512.png", size: 512, svg: svgAny },
  // Manifest — "maskable" (full-bleed; note sits inside the 80% safe zone)
  { file: "icon-maskable-192.png", size: 192, svg: svgSolid },
  { file: "icon-maskable-512.png", size: 512, svg: svgSolid },
  // PNG favicon fallback
  { file: "favicon-32.png", size: 32, svg: svgAny },
];

function render(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  return resvg.render().asPng();
}

// ---------------------------------------------------------------------------
// iOS launch images
// ---------------------------------------------------------------------------

/**
 * An installed iOS web app shows a blank white screen while it boots unless
 * an apple-touch-startup-image matches the device exactly — iOS ignores any
 * link whose media query doesn't match, so each size needs its own file.
 *
 * [cssWidth, cssHeight, dpr, label]. Portrait only: iOS falls back to the
 * background colour when launched in landscape, which is rare for a reader
 * and not worth doubling the file count for.
 */
const LAUNCH_DEVICES = [
  [320, 568, 2, "iPhone SE (1st gen)"],
  [375, 667, 2, "iPhone SE (2nd/3rd gen), 8"],
  [414, 736, 3, "iPhone 8 Plus"],
  [375, 812, 3, "iPhone X/XS, 11 Pro, 12/13 mini"],
  [414, 896, 2, "iPhone XR, 11"],
  [414, 896, 3, "iPhone XS Max, 11 Pro Max"],
  [390, 844, 3, "iPhone 12/13/14"],
  [428, 926, 3, "iPhone 12/13 Pro Max, 14 Plus"],
  [393, 852, 3, "iPhone 14 Pro, 15, 16"],
  [430, 932, 3, "iPhone 14 Pro Max, 15/16 Plus"],
  [402, 874, 3, "iPhone 16 Pro"],
  [440, 956, 3, "iPhone 16 Pro Max"],
  [768, 1024, 2, "iPad mini, 9.7\""],
  [810, 1080, 2, "iPad 10.2\""],
  [820, 1180, 2, "iPad Air 10.9\""],
  [834, 1112, 2, "iPad Pro 10.5\""],
  [834, 1194, 2, "iPad Pro 11\""],
  [1024, 1366, 2, "iPad Pro 12.9\""],
];

const BG = "#111110";

/** The app mark centred on the launch background, at the device's pixel size. */
const launchSvg = (w, h) => {
  // the glyph from icon.svg, sized to ~26% of the short edge
  const mark = Math.round(Math.min(w, h) * 0.26);
  const scale = mark / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <g transform="translate(${(w - mark) / 2}, ${(h - mark) / 2}) scale(${scale})"
     fill="none" stroke="#f0a040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </g>
</svg>`;
};

const launchFile = (w, h, dpr) => `icons/launch-${w}x${h}@${dpr}x.png`;

function writeLaunchImages() {
  const written = [];
  for (const [cw, ch, dpr] of LAUNCH_DEVICES) {
    const w = cw * dpr;
    const h = ch * dpr;
    // exact pixel dimensions come from the SVG itself, so render 1:1
    const png = new Resvg(launchSvg(w, h), { fitTo: { mode: "original" } })
      .render().asPng();
    const rel = launchFile(cw, ch, dpr);
    fs.writeFileSync(path.join(DOCS_DIR, rel), png);
    written.push({ rel, w, h, bytes: png.length });
  }
  console.log(`✓ ${written.length} iOS launch images ` +
    `(${(written.reduce((n, x) => n + x.bytes, 0) / 1024).toFixed(0)} KB total)`);
  return written;
}

/**
 * Rewrite the generated block of <link rel="apple-touch-startup-image"> tags
 * in index.html, so the markup can't drift from the files on disk.
 */
function writeLaunchLinks() {
  const indexPath = path.join(DOCS_DIR, "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const START = "    <!-- launch-images:start -->";
  const END = "    <!-- launch-images:end -->";
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0) {
    console.error(`index.html is missing the ${START.trim()} / ${END.trim()} markers`);
    process.exit(1);
  }
  const links = LAUNCH_DEVICES.map(([cw, ch, dpr, label]) =>
    `    <link rel="apple-touch-startup-image" href="${launchFile(cw, ch, dpr)}"\n` +
    `      media="(device-width: ${cw}px) and (device-height: ${ch}px) and ` +
    `(-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" />` +
    ` <!-- ${label} -->`).join("\n");
  const next = html.slice(0, from) + START + "\n" + links + "\n" + html.slice(to);
  if (next !== html) {
    fs.writeFileSync(indexPath, next);
    console.log(`✓ index.html — ${LAUNCH_DEVICES.length} launch-image links`);
  } else {
    console.log("✓ index.html launch-image links already current");
  }
}

function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  for (const { file, size, svg } of TARGETS) {
    const png = render(svg, size);
    fs.writeFileSync(path.join(ICONS_DIR, file), png);
    console.log(`✓ icons/${file} (${size}x${size}, ${png.length} bytes)`);
  }
  console.log(`\nWrote ${TARGETS.length} icons to docs/icons/`);
  writeLaunchImages();
  writeLaunchLinks();
}

main();
