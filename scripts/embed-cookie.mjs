import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const asset = new URL('../public/cookie-contour.svg', import.meta.url);
const page = new URL('../public/index.html', import.meta.url);
const svg = readFileSync(asset, 'utf8').replace(/<\?xml[^>]*\?>\s*/g, '').trim();
// The committed drawing must remain self-contained passive vector markup.
if (/<(?:script|style|foreignObject|image|use)\b|\bon\w+\s*=|\bhref\s*=|<!DOCTYPE/i.test(svg)) {
  throw new Error('Cookie SVG must contain only local vector artwork.');
}
if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>')) throw new Error('Invalid cookie SVG.');
const pattern = /<!-- COOKIE_CONTOUR_START -->[\s\S]*?<!-- COOKIE_CONTOUR_END -->/;
const html = readFileSync(page, 'utf8');
if (!pattern.test(html)) throw new Error('Cookie placeholder is missing from index.html.');
writeFileSync(page, html.replace(pattern, `<!-- COOKIE_CONTOUR_START -->\n        ${svg}\n        <!-- COOKIE_CONTOUR_END -->`));
console.log(`Embedded the cookie drawing into ${fileURLToPath(page)}.`);
