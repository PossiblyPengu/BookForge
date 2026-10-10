/**
 * generate-ios-icon.js
 *
 * Renders the iOS app icon: BookMaster's "book open with text" mark (the glyph
 * the suite already uses for Pageturner) in the evening clay on the near-black
 * ground, as a 1024px opaque full-bleed square — iOS applies its own mask.
 *
 * Usage: node scripts/generate-ios-icon.js
 * Requirements: @resvg/resvg-js (devDependency).
 *
 * resvg writes RGBA; an app icon must carry no alpha channel, so flatten it
 * afterwards (the artwork is fully opaque) — e.g. with ImageMagick:
 *   convert icon-1024.png -alpha off icon-1024.png
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "ios", "Pageturner", "Assets.xcassets", "AppIcon.appiconset");

// lucide "book-open-text" (24×24 grid, ISC licence), centred and scaled to ~58% of the icon
const SCALE = 29;
const OFFSET = 512 - 12 * SCALE;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#111110"/>
  <g transform="translate(${OFFSET}, ${OFFSET}) scale(${SCALE})" fill="none" stroke="#cd844f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 7v14"/>
    <path d="M16 12h2"/>
    <path d="M16 8h2"/>
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
    <path d="M6 12h2"/>
    <path d="M6 8h2"/>
  </g>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(here, "..", "ios", "app-icon.svg"), svg);
fs.writeFileSync(
  path.join(OUT, "icon-1024.png"),
  new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng(),
);
console.log("wrote ios/app-icon.svg and AppIcon.appiconset/icon-1024.png");
