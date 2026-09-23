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

function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  for (const { file, size, svg } of TARGETS) {
    const png = render(svg, size);
    fs.writeFileSync(path.join(ICONS_DIR, file), png);
    console.log(`✓ icons/${file} (${size}x${size}, ${png.length} bytes)`);
  }
  console.log(`\nWrote ${TARGETS.length} icons to docs/icons/`);
}

main();
