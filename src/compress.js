// PDF compression that runs fully offline.
// Nearly all of a PDF's weight is embedded images, so we re-encode each image as
// JPEG at a level-dependent quality and resolution. Text, vectors and fonts are
// untouched, so the document stays sharp and searchable. An image is only replaced
// when the new version is actually smaller.
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFBool } from '@cantoo/pdf-lib';

export const LEVELS = {
  low: { quality: 0.82, maxDim: 2400 },     // light compression, near-original quality
  medium: { quality: 0.68, maxDim: 1600 },  // good balance for sharing by email
  high: { quality: 0.5, maxDim: 1100 },     // smallest file, fine for on-screen reading
};

const N = (s) => PDFName.of(s);
const num = (v) => (v instanceof PDFNumber ? v.asNumber() : 0);

function filters(dict) {
  const f = dict.lookup(N('Filter'));
  if (!f) return [];
  if (f instanceof PDFArray) return f.asArray().map((x) => x.toString());
  return [f.toString()];
}

// Number of colour components, or 0 when the colour space is one we do not handle.
function components(dict) {
  const cs = dict.lookup(N('ColorSpace'));
  if (!cs) return 0;
  const name = cs instanceof PDFArray ? cs.lookup(0)?.toString() : cs.toString();
  if (name === '/DeviceRGB' || name === '/CalRGB') return 3;
  if (name === '/DeviceGray' || name === '/CalGray') return 1;
  if (name === '/ICCBased' && cs instanceof PDFArray) {
    const icc = cs.lookup(1);
    const n = num(icc?.dict?.lookup(N('N')));
    return n === 3 || n === 1 ? n : 0;
  }
  return 0; // CMYK, Indexed, Lab, Separation... left as they are
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeImage(obj, kind, w, h, comps) {
  if (kind === 'jpeg') return createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
  const raw = await inflate(obj.contents);
  if (raw.length < w * h * comps) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += comps) {
    const r = raw[j], g = comps === 3 ? raw[j + 1] : r, b = comps === 3 ? raw[j + 2] : r;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

async function encodeJpeg(bitmap, { quality, maxDim }) {
  const k = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}

/**
 * Compress a PDF. Returns { bytes, before, after, images, replaced }.
 * onProgress(done, total) is called while images are processed.
 */
export async function compressPdf(input, level = 'medium', onProgress = () => {}) {
  const opts = LEVELS[level] || LEVELS.medium;
  const doc = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;

  // Soft masks (transparency) must stay single-channel, so never touch them.
  const masks = new Set();
  const candidates = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.lookup(N('Subtype'))?.toString() !== '/Image') continue;
    const sm = d.get(N('SMask')); if (sm) masks.add(sm.toString());
    candidates.push([ref, obj]);
  }

  const work = candidates.filter(([ref, obj]) => {
    const d = obj.dict;
    if (masks.has(ref.toString())) return false;
    if (d.lookup(N('ImageMask')) === PDFBool.True || d.get(N('Mask')) || d.get(N('Decode'))) return false;
    if (obj.contents.length < 12000) return false; // tiny images are not worth it
    const f = filters(d);
    if (f.length !== 1) return false;
    if (f[0] === '/DCTDecode') return components(d) > 0;
    if (f[0] === '/FlateDecode') {
      const parms = d.lookup(N('DecodeParms'));
      if (parms && num(parms.lookup?.(N('Predictor'))) > 1) return false;
      return num(d.lookup(N('BitsPerComponent'))) === 8 && components(d) > 0;
    }
    return false;
  });

  let replaced = 0;
  for (let i = 0; i < work.length; i++) {
    onProgress(i, work.length);
    const [ref, obj] = work[i], d = obj.dict;
    try {
      const w = num(d.lookup(N('Width'))), h = num(d.lookup(N('Height')));
      const kind = filters(d)[0] === '/DCTDecode' ? 'jpeg' : 'flate';
      const bmp = await decodeImage(obj, kind, w, h, components(d));
      if (!bmp) continue;
      const out = await encodeJpeg(bmp, opts);
      bmp.close?.();
      if (out.bytes.length >= obj.contents.length * 0.95) continue; // not worth replacing
      const fields = {
        Type: 'XObject', Subtype: 'Image', Width: out.w, Height: out.h,
        ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
      };
      const ns = ctx.stream(out.bytes, fields); // JPEG bytes are already compressed
      const smask = d.get(N('SMask'));
      if (smask) ns.dict.set(N('SMask'), smask);
      const interp = d.get(N('Interpolate'));
      if (interp) ns.dict.set(N('Interpolate'), interp);
      ctx.assign(ref, ns);
      replaced++;
    } catch (e) {
      console.warn('skipped image', ref.toString(), e);
    }
  }
  onProgress(work.length, work.length);

  const bytes = await doc.save({ useObjectStreams: true });
  // Never hand back something bigger than what came in.
  const best = bytes.length < input.length ? bytes : input;
  return { bytes: best, before: input.length, after: best.length, images: candidates.length, replaced };
}

export function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
