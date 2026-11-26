// Edit existing PDF text. A PDF stores text as positioned runs, not paragraphs,
// so we group runs into editable "blocks" (a line, a table cell, a number...),
// and on save cover the original and redraw the new text in a matching
// standard font, squeezed to the original width.
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const cache = new Map(); // pageIndex -> blocks

export function resetBlocks() { cache.clear(); }

function fontStyle(page, item, styles) {
  let real = '';
  try { if (page.commonObjs.has(item.fontName)) real = page.commonObjs.get(item.fontName)?.name || ''; } catch {}
  // Prefer the embedded font's real name (e.g. "ABCDEF+TimesNewRomanPSMT"); pdf.js's generic
  // family is only a fallback because it often says "sans-serif" for every font.
  const name = real.toLowerCase().replace(/^[a-z]{6}\+/, '');
  const all = name || (styles[item.fontName]?.fontFamily || '').toLowerCase();
  const family = /courier|mono|consolas|menlo/.test(all) ? 'mono'
    : /times|georgia|cambria|garamond|book|roman|minion|palatino|(^|[^s])serif/.test(all) && !/sans/.test(all) ? 'serif' : 'sans';
  return {
    family,
    fontName: real,
    bold: /bold|black|heavy|semibold|demi/.test(all),
    italic: /italic|oblique/.test(all),
    ascent: styles[item.fontName]?.ascent || 0.8,
    descent: Math.abs(styles[item.fontName]?.descent || -0.22),
  };
}

/** Editable text blocks of one page, in page coordinates at scale 1 (top-left origin). */
export async function getBlocks(pdf, i) {
  if (cache.has(i)) return cache.get(i);
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  // Fonts are only known after the page's operator list is loaded.
  await page.getOperatorList().catch(() => {});
  const { items, styles } = await page.getTextContent();
  const blocks = [];
  let cur = null;
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    // pdf.js fills the gap between table cells with one wide space item: treat it as a cell boundary.
    if (!it.str.trim() && it.str && it.width > Math.abs(it.transform[3] || 10) * 0.8) { cur = null; continue; }
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) { cur = null; continue; } // rotated text: skip
    const size = Math.abs(tx[3]) || Math.hypot(tx[2], tx[3]);
    if (!size) continue;
    const x = tx[4], baseline = tx[5], w = it.width * (vp.scale || 1);
    const st = fontStyle(page, it, styles);
    const sameLine = cur && Math.abs(cur.baseline - baseline) < size * 0.25 && Math.abs(cur.size - size) < size * 0.15;
    const gap = cur ? x - (cur.x + cur.w) : 0;
    if (sameLine && gap < size * 0.9 && gap > -size * 0.5) {
      // A small gap means a space that Word did not encode as a character.
      if (gap > size * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
      cur.text += it.str; cur.w = x + w - cur.x;
    } else if (it.str.trim()) {
      cur = { x, baseline, w, size, text: it.str, ...st };
      blocks.push(cur);
    }
    if (it.hasEOL) cur = null;
  }
  blocks.forEach((b, k) => {
    b.text = b.text.replace(/\s+$/, '');
    b.id = `${i}:${k}`;
    b.y = b.baseline - b.size * b.ascent;
    b.h = b.size * (b.ascent + b.descent);
  });
  const clean = blocks.filter((b) => b.text.trim());
  cache.set(i, clean);
  return clean;
}

// ---- standard-font metrics (shared by the live preview and by saving)
const STD = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};
export const stdFontName = (b) => STD[b.family][(b.bold ? 1 : 0) + (b.italic ? 2 : 0)];
export const CSS_FAMILY = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };

let metricsDoc = null; const metrics = new Map();
async function metricFont(name) {
  if (!metricsDoc) metricsDoc = await PDFDocument.create();
  if (!metrics.has(name)) metrics.set(name, await metricsDoc.embedFont(name));
  return metrics.get(name);
}
const latinSafe = (s) => /^[\x20-\x7E\xA0-\xFF]*$/.test(s);

/** Horizontal squeeze that makes the standard font as wide as the original one. */
export async function squeezeFor(b) {
  if (!latinSafe(b.text)) return 1;
  const f = await metricFont(stdFontName(b));
  const natural = f.widthOfTextAtSize(b.text, b.size);
  if (!natural) return 1;
  return Math.max(0.7, Math.min(1.15, b.w / natural));
}

/** Read the background and ink colours of a block from the rendered page canvas. */
export function sampleColors(canvas, b, k) {
  const fallback = { bg: '#ffffff', color: '#000000' };
  if (!canvas || !canvas.width) return fallback;
  const pad = 2;
  const x0 = Math.max(0, Math.floor((b.x - pad) * k)), y0 = Math.max(0, Math.floor((b.y - pad) * k));
  const x1 = Math.min(canvas.width, Math.ceil((b.x + b.w + pad) * k)), y1 = Math.min(canvas.height, Math.ceil((b.y + b.h + pad) * k));
  if (x1 - x0 < 2 || y1 - y0 < 2) return fallback;
  let data;
  try { data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, y1 - y0); } catch { return fallback; }
  const { width: W, height: H } = data, d = data.data;
  const counts = new Map();
  const px = (x, y) => { const o = (y * W + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
  // Background = most common exact colour along the border of the box.
  const vote = (c) => { const key = c.join(); counts.set(key, (counts.get(key) || 0) + 1); };
  for (let x = 0; x < W; x++) { vote(px(x, 0)); vote(px(x, H - 1)); }
  for (let y = 0; y < H; y++) { vote(px(0, y)); vote(px(W - 1, y)); }
  const top = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0][0].split(',').map(Number);
  // Ink = the pixel furthest from the background.
  let best = 0, ink = [0, 0, 0];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const c = px(x, y), dist = Math.abs(c[0] - top[0]) + Math.abs(c[1] - top[1]) + Math.abs(c[2] - top[2]);
    if (dist > best) { best = dist; ink = c; }
  }
  const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  return { bg: hex(top), color: best > 60 ? hex(ink) : '#000000' };
}
