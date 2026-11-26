// Remove original text from a page's content stream inside given rectangles.
// Covering text with a white box is not enough: the old words would still be
// selectable, searchable and copyable. Here every text-showing operator whose
// starting point falls inside a rectangle is replaced by an empty TJ that moves
// the cursor by exactly the same amount, so the rest of the line stays put.
import { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

function tokenize(s) {
  // s: latin1 string. Returns tokens { t: 'num'|'name'|'str'|'hex'|'['|']'|'<<'|'>>'|'op', v, a, b }
  const out = []; let i = 0; const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; } // % comment
    const a = i;
    if (c === 40) { // ( literal string )
      let depth = 1, v = ''; i++;
      while (i < n && depth) {
        const ch = s[i];
        if (ch === '\\') {
          const nx = s[i + 1];
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (nx in map) { v += map[nx]; i += 2; }
          else if (/[0-7]/.test(nx)) { let o = ''; i++; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; v += String.fromCharCode(parseInt(o, 8) & 255); }
          else if (nx === '\r') { i += s[i + 2] === '\n' ? 3 : 2; }
          else if (nx === '\n') { i += 2; }
          else { i++; }
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') { depth--; if (!depth) { i++; break; } }
        v += ch; i++;
      }
      out.push({ t: 'str', v, a, b: i }); continue;
    }
    if (c === 60 && s[i + 1] === '<') { out.push({ t: '<<', a, b: i + 2 }); i += 2; continue; }
    if (c === 62 && s[i + 1] === '>') { out.push({ t: '>>', a, b: i + 2 }); i += 2; continue; }
    if (c === 60) { // <hex>
      const e = s.indexOf('>', i); let h = s.slice(i + 1, e).replace(/\s+/g, '');
      if (h.length % 2) h += '0';
      let v = ''; for (let k = 0; k < h.length; k += 2) v += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
      out.push({ t: 'str', v, a, b: e + 1 }); i = e + 1; continue;
    }
    if (c === 91 || c === 93) { out.push({ t: s[i], a, b: i + 1 }); i++; continue; }
    if (c === 123 || c === 125) { i++; continue; }
    if (c === 47) { i++; while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++; out.push({ t: 'name', v: s.slice(a + 1, i), a, b: i }); continue; }
    while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
    if (i === a) { i++; continue; }
    const word = s.slice(a, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) out.push({ t: 'num', v: parseFloat(word), a, b: i });
    else {
      out.push({ t: 'op', v: word, a, b: i });
      if (word === 'ID') { // inline image data: skip raw bytes up to EI
        const m = /\sEI(?=[\s]|$)/g; m.lastIndex = i; const r = m.exec(s);
        i = r ? r.index + 3 : n;
      }
    }
  }
  return out;
}

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Glyph widths (thousandths of text space) for a font dictionary.
function fontInfo(fontDict) {
  const num = (v) => (v instanceof PDFNumber ? v.asNumber() : 0);
  const sub = fontDict.lookup(PDFName.of('Subtype'))?.toString();
  if (sub === '/Type0') {
    const desc = fontDict.lookup(PDFName.of('DescendantFonts'))?.lookup(0);
    const dw = num(desc?.lookup(PDFName.of('DW'))) || 1000;
    const W = desc?.lookup(PDFName.of('W'));
    const widths = new Map();
    if (W instanceof PDFArray) {
      const arr = W.asArray().map((x) => desc.context.lookup(x));
      for (let k = 0; k < arr.length;) {
        const first = num(arr[k]);
        if (arr[k + 1] instanceof PDFArray) { arr[k + 1].asArray().forEach((w, j) => widths.set(first + j, num(desc.context.lookup(w)))); k += 2; }
        else { const last = num(arr[k + 1]), w = num(arr[k + 2]); for (let g = first; g <= last; g++) widths.set(g, w); k += 3; }
      }
    }
    return { twoByte: true, width: (code) => widths.get(code) ?? dw };
  }
  const first = num(fontDict.lookup(PDFName.of('FirstChar')));
  const W = fontDict.lookup(PDFName.of('Widths'));
  const list = W instanceof PDFArray ? W.asArray().map((x) => num(fontDict.context.lookup(x))) : null;
  const missing = num(fontDict.lookup(PDFName.of('FontDescriptor'))?.lookup?.(PDFName.of('MissingWidth'))) || 500;
  return { twoByte: false, width: (code) => (list && code >= first && code - first < list.length ? list[code - first] : missing) };
}

/**
 * Strip text inside rects (PDF user-space { x, y, w, h }) from a pdf-lib page.
 * Returns the set of rect indices in which text was removed.
 */
export function stripTextInRects(doc, page, rects) {
  const hit = new Set();
  if (!rects.length) return hit;
  const node = page.node;
  const contents = node.Contents();
  if (!contents) return hit;
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const parts = [];
  for (const r of refs) {
    const st = r instanceof PDFRef ? doc.context.lookup(r) : r;
    if (!(st instanceof PDFRawStream)) return hit; // unknown stream type: leave the page alone
    try { parts.push(decodePDFRawStream(st).decode()); } catch { return hit; }
  }
  const bytes = new Uint8Array(parts.reduce((t, p) => t + p.length + 1, 0));
  let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; bytes[off++] = 10; }
  let src = ''; for (let k = 0; k < bytes.length; k += 8192) src += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));

  const fonts = node.Resources()?.lookup(PDFName.of('Font'));
  const infoCache = new Map();
  const getFont = (name) => {
    if (!infoCache.has(name)) {
      const fd = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(name)) : null;
      infoCache.set(name, fd instanceof PDFDict ? fontInfo(fd) : { twoByte: false, width: () => 500 });
    }
    return infoCache.get(name);
  };
  const inside = (x, y) => rects.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

  const toks = tokenize(src);
  const stack = []; let ctm = [1, 0, 0, 1, 0, 0];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm;
  let font = null, fs = 1, tc = 0, tw = 0, th = 1, tl = 0, rise = 0;
  const edits = []; // [start, end, replacement]
  let ops = []; // operands collected for the current operator
  let removed = 0;

  // Horizontal advance (text space) of one string under the current state.
  const advance = (str) => {
    const f = font || { twoByte: false, width: () => 500 };
    let adv = 0;
    if (f.twoByte) for (let k = 0; k + 1 < str.length; k += 2) adv += (f.width((str.charCodeAt(k) << 8) | str.charCodeAt(k + 1)) / 1000) * fs + tc;
    else for (let k = 0; k < str.length; k++) { const code = str.charCodeAt(k); adv += (f.width(code) / 1000) * fs + tc + (code === 32 ? tw : 0); }
    return adv * th;
  };
  const show = (elems, start, end, lead = '') => {
    // Start point of the run in user space, nudged up into the glyphs' body.
    const trm = mul(tm, ctm);
    const [sx, sy] = apply(trm, fs * 0.05, rise + fs * 0.3);
    let total = 0;
    for (const e of elems) total += typeof e === 'number' ? (-e / 1000) * fs * th : advance(e);
    const ri = inside(sx, sy);
    if (ri >= 0 && fs > 0 && th) {
      hit.add(ri);
      const kern = -(total / (fs * th)) * 1000;
      edits.push([start, end, `${lead}[${kern.toFixed(3)}] TJ`]); removed++;
    }
    tm = mul([1, 0, 0, 1, total, 0], tm);
  };

  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== 'op') { ops.push(tk); continue; }
    const nums = ops.filter((o) => o.t === 'num').map((o) => o.v);
    const start = ops.length ? ops[0].a : tk.a;
    switch (tk.v) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case 'cm': if (nums.length === 6) ctm = mul(nums, ctm); break;
      case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': { const nm = ops.find((o) => o.t === 'name'); font = nm ? getFont(nm.v) : null; fs = nums[0] ?? fs; break; }
      case 'Tc': tc = nums[0] ?? 0; break;
      case 'Tw': tw = nums[0] ?? 0; break;
      case 'Tz': th = (nums[0] ?? 100) / 100; break;
      case 'TL': tl = nums[0] ?? 0; break;
      case 'Ts': rise = nums[0] ?? 0; break;
      case 'Td': tlm = mul([1, 0, 0, 1, nums[0] || 0, nums[1] || 0], tlm); tm = tlm; break;
      case 'TD': tl = -(nums[1] || 0); tlm = mul([1, 0, 0, 1, nums[0] || 0, nums[1] || 0], tlm); tm = tlm; break;
      case 'Tm': if (nums.length === 6) { tlm = nums; tm = nums; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
      case 'Tj': { const s = ops.find((o) => o.t === 'str'); if (s) show([s.v], start, tk.b); break; }
      case "'": { tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; const s = ops.find((o) => o.t === 'str'); if (s) show([s.v], s.a, tk.b, 'T* '); break; }
      case '"': { tw = nums[0] ?? tw; tc = nums[1] ?? tc; tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; const s = ops.find((o) => o.t === 'str'); if (s) show([s.v], start, tk.b, `${tw} Tw ${tc} Tc T* `); break; }
      case 'TJ': {
        const open = ops.findIndex((o) => o.t === '['), close = ops.map((o) => o.t).lastIndexOf(']');
        const elems = ops.slice(open + 1, close < 0 ? undefined : close).filter((o) => o.t === 'str' || o.t === 'num').map((o) => (o.t === 'str' ? o.v : o.v));
        show(elems, start, tk.b); break;
      }
      default: break;
    }
    ops = [];
  }
  if (!edits.length) return hit;

  let outStr = ''; let pos = 0;
  for (const [a, b, rep] of edits.sort((x, y) => x[0] - y[0])) { outStr += src.slice(pos, a) + rep; pos = b; }
  outStr += src.slice(pos);
  const out = new Uint8Array(outStr.length);
  for (let k = 0; k < outStr.length; k++) out[k] = outStr.charCodeAt(k) & 255;
  node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
  void removed;
  return hit;
}
