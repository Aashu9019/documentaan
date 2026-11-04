import './style.css';
import '@fontsource/dancing-script';
import '@fontsource/great-vibes';
import '@fontsource/caveat';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFDocument, rgb, degrees, StandardFonts, LineCapStyle, BlendMode, PDFHexString,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup,
} from '@cantoo/pdf-lib';
import { t, applyI18n, toggleLang } from './i18n.js';
import { openSignatureDialog } from './signature.js';
import { isDesktop, nativeOpen, nativeSave, readPath, baseName, setTitle, onExternalOpen, guardClose } from './native.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// ---------------------------------------------------------------- state
const S = {
  bytes: null,          // base PDF bytes (annotations not yet burned in)
  name: 'document.pdf',
  handle: null,         // File System Access handle for in-place save
  password: undefined,
  pdf: null,            // pdf.js document
  vps: [],              // viewport at scale 1 per page
  annots: [],           // annots[pageIndex] = [...]
  scale: 1,
  tool: 'select',
  selected: null,       // { page, a }
  placing: null,        // signature waiting to be placed
  dirty: false,
  protect: null,
  history: [], future: [],
  texts: null,          // search cache
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pagesEl = $('#pages'), viewer = $('#viewer'), thumbsEl = $('#thumbs');
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const HIGHLIGHT = '#ffe14d';
// Standard PDF fonts only cover Latin-1; anything else (e.g. Devanagari) is rendered as an image.
const latinSafe = (s) => /^[\x20-\x7E\xA0-\xFF\n]*$/.test(s);

export function toast(msg, ms = 2200) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------- modal
export function modal(title, html, { wide } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"${wide ? ' style="width:min(760px,100%)"' : ''}><h2>${esc(title)}</h2>${html}</div>`;
  $('#modalRoot').appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  applyI18n(bg);
  return { el: bg.firstElementChild, close };
}

// ---------------------------------------------------------------- history
function snapshot() { return { bytes: S.bytes, annots: clone(S.annots) }; }
function pushHistory() { S.history.push(snapshot()); if (S.history.length > 40) S.history.shift(); S.future = []; S.dirty = true; }
async function restore(snap) {
  const reload = snap.bytes !== S.bytes;
  S.bytes = snap.bytes; S.annots = snap.annots; S.selected = null;
  if (reload) await loadPdf(S.bytes, { keepAnnots: true });
  else renderAllOverlays();
}
async function undo() { if (!S.history.length) return; S.future.push(snapshot()); await restore(S.history.pop()); }
async function redo() { if (!S.future.length) return; S.history.push(snapshot()); await restore(S.future.pop()); }

// ---------------------------------------------------------------- open / load
async function openFile() {
  if (S.dirty && !confirm(t('unsaved'))) return;
  if (isDesktop) {
    try { const f = await nativeOpen(); if (f) openBytes(f.bytes, f.name, f.path); } catch (e) { toast('Open failed: ' + e, 4000); }
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const f = await h.getFile();
      return openBytes(new Uint8Array(await f.arrayBuffer()), f.name, h);
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#fileInput').click();
}
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name, null);
});

async function openBytes(bytes, name, handle) {
  S.name = name || 'document.pdf'; S.handle = handle; S.password = undefined; S.protect = null;
  S.history = []; S.future = []; S.dirty = false; S.annots = [];
  try { await loadPdf(bytes, {}); } catch (e) { console.error(e); toast('Could not open PDF: ' + e.message, 4000); return; }
  // Encrypted source? Store a decrypted copy so editing works.
  if (S.password !== undefined) {
    try { const d = await PDFDocument.load(bytes, { password: S.password }); S.bytes = await d.save(); } catch (e) { console.warn(e); }
  }
  $('#fileName').textContent = S.name; setTitle(`${S.name} — Documentaan`);
}

async function loadPdf(bytes, { keepAnnots }) {
  const task = pdfjs.getDocument({ data: bytes.slice(), password: S.password });
  task.onPassword = (update) => {
    const pw = prompt(t('pwPrompt'));
    if (pw === null) { task.destroy(); return; }
    S.password = pw; update(pw);
  };
  const pdf = await task.promise;
  if (S.pdf) S.pdf.destroy();
  S.pdf = pdf; S.bytes = bytes; S.texts = null;
  S.vps = [];
  for (let i = 1; i <= pdf.numPages; i++) S.vps.push((await pdf.getPage(i)).getViewport({ scale: 1 }));
  if (!keepAnnots || S.annots.length !== pdf.numPages) {
    const old = S.annots; S.annots = S.vps.map((_, i) => (keepAnnots && old[i]) || []);
  }
  $('#empty').classList.add('hidden');
  $$('#btnSave,#btnPrint').forEach((b) => (b.disabled = false));
  $('#pageCount').textContent = '/ ' + pdf.numPages;
  $('#pageInput').max = pdf.numPages;
  if (!keepAnnots) fitWidth(true); else layoutPages();
  renderThumbs();
}

// ---------------------------------------------------------------- page layout + rendering
let observer;
function layoutPages() {
  const keepPage = currentPage();
  pagesEl.innerHTML = '';
  observer?.disconnect();
  observer = new IntersectionObserver((ents) => ents.forEach((en) => en.isIntersecting && renderPage(+en.target.dataset.i)), { root: viewer, rootMargin: '600px' });
  S.vps.forEach((vp, i) => {
    const d = document.createElement('div');
    d.className = 'page'; d.dataset.i = i;
    d.style.width = vp.width * S.scale + 'px'; d.style.height = vp.height * S.scale + 'px';
    d.innerHTML = `<canvas class="pdf"></canvas><div class="overlay"></div>`;
    pagesEl.appendChild(d);
    observer.observe(d);
    bindOverlay(d.querySelector('.overlay'), i);
    renderOverlay(i);
  });
  $('#zoomLabel').textContent = Math.round(S.scale * 100) + '%';
  updateCursor();
  if (keepPage > 0) requestAnimationFrame(() => gotoPage(keepPage, false));
}

const renderTasks = new Map();
async function renderPage(i) {
  const d = pagesEl.children[i]; if (!d || d.dataset.rendered === String(S.scale)) return;
  d.dataset.rendered = String(S.scale);
  const page = await S.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: S.scale * dpr() });
  const c = d.querySelector('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  renderTasks.get(i)?.cancel();
  const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  renderTasks.set(i, task);
  try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
}

function setZoom(s) { S.scale = Math.max(0.25, Math.min(4, s)); if (S.pdf) layoutPages(); }
function fitWidth(initial) {
  if (!S.vps.length) return;
  const w = viewer.clientWidth - 48;
  const s = w / Math.max(...S.vps.map((v) => v.width));
  setZoom(initial ? Math.min(s, 1.5) : s);
}

function currentPage() {
  const kids = [...pagesEl.children]; if (!kids.length) return 0;
  const mid = viewer.scrollTop + viewer.clientHeight / 3;
  let best = 0;
  kids.forEach((k, i) => { if (k.offsetTop <= mid) best = i; });
  return best + 1;
}
function gotoPage(n, smooth = true) {
  const k = pagesEl.children[n - 1]; if (!k) return;
  viewer.scrollTo({ top: k.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
}
viewer.addEventListener('scroll', () => {
  const n = currentPage(); $('#pageInput').value = n;
  $$('.thumb', thumbsEl).forEach((th, i) => th.classList.toggle('current', i === n - 1));
});

// ---------------------------------------------------------------- thumbnails
async function renderThumbs() {
  thumbsEl.innerHTML = '';
  for (let i = 0; i < S.vps.length; i++) {
    const th = document.createElement('div');
    th.className = 'thumb'; th.draggable = true; th.dataset.i = i;
    th.innerHTML = `<canvas></canvas><div class="num">${i + 1}</div>
      <div class="ops"><button data-op="rot" title="${t('rotate')}">⟳</button><button data-op="del" title="${t('del')}">✕</button></div>`;
    thumbsEl.appendChild(th);
  }
  for (let i = 0; i < S.vps.length; i++) {
    const page = await S.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 240 / S.vps[i].width });
    const c = thumbsEl.children[i]?.querySelector('canvas'); if (!c) return;
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
  }
}
let dragFrom = -1;
thumbsEl.addEventListener('click', (e) => {
  const th = e.target.closest('.thumb'); if (!th) return;
  const i = +th.dataset.i, op = e.target.dataset.op;
  if (op === 'rot') rotatePage(i);
  else if (op === 'del') deletePage(i);
  else gotoPage(i + 1);
});
thumbsEl.addEventListener('dragstart', (e) => { dragFrom = +e.target.closest('.thumb').dataset.i; });
thumbsEl.addEventListener('dragover', (e) => { e.preventDefault(); $$('.thumb', thumbsEl).forEach((x) => x.classList.toggle('drag-over', x === e.target.closest('.thumb'))); });
thumbsEl.addEventListener('drop', (e) => {
  e.preventDefault(); $$('.thumb', thumbsEl).forEach((x) => x.classList.remove('drag-over'));
  const th = e.target.closest('.thumb'); if (!th || dragFrom < 0) return;
  const to = +th.dataset.i; if (to !== dragFrom) movePage(dragFrom, to); dragFrom = -1;
});

// ---------------------------------------------------------------- PDF mutation helpers
async function loadLib(bytes = S.bytes) { return PDFDocument.load(bytes, { ignoreEncryption: true }); }

async function mutate(fn) {
  if (!S.bytes) return toast(t('needPdf'));
  pushHistory();
  try {
    const doc = await loadLib();
    await fn(doc);
    await loadPdf(await doc.save(), { keepAnnots: true });
  } catch (e) { console.error(e); toast('Error: ' + e.message, 4000); S.history.pop(); }
}

async function bakeIntoBase() { // burn annotations into base bytes
  if (!S.annots.some((a) => a.length)) return;
  S.bytes = await bake({ forSave: false }); S.annots = S.annots.map(() => []); toast(t('bake'));
}

async function rotatePage(i) {
  pushHistory(); await bakeIntoBase();
  const doc = await loadLib(); const p = doc.getPage(i);
  p.setRotation(degrees((p.getRotation().angle + 90) % 360));
  await loadPdf(await doc.save(), { keepAnnots: true });
}
async function deletePage(i) {
  if (S.vps.length <= 1) return;
  await mutate((doc) => { doc.removePage(i); S.annots.splice(i, 1); });
}
async function movePage(from, to) {
  await mutate(async (doc) => {
    const order = [...S.vps.keys()]; const [m] = order.splice(from, 1); order.splice(to, 0, m);
    const out = await PDFDocument.create();
    (await out.copyPages(doc, order)).forEach((p) => out.addPage(p));
    S.annots = order.map((k) => S.annots[k]);
    doc.save = () => out.save();
  });
}
async function insertBlank() {
  const i = Math.max(0, currentPage() - 1);
  await mutate((doc) => {
    const { width, height } = doc.getPage(i).getSize();
    doc.insertPage(i + 1, [width, height]); S.annots.splice(i + 1, 0, []);
  });
  gotoPage(i + 2);
}

// ---------------------------------------------------------------- annotations: geometry
function bbox(a) {
  if (a.points) {
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const pad = Math.max(a.width || 2, 4);
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (a.type === 'note') return { x: a.x, y: a.y, w: 20, h: 20 };
  if (a.type === 'text') return { x: a.x, y: a.y, w: 0, h: 0 };
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}
function translate(a, a0, dx, dy) {
  if (a.points) a.points = a0.points.map(([x, y]) => [x + dx, y + dy]);
  else { a.x = a0.x + dx; a.y = a0.y + dy; }
}
function resize(a, a0, dx, dy, el) {
  if (a.type === 'text') { const w0 = el._w0; a.size = Math.max(4, a0.size * (w0 + dx) / w0); return; }
  if (a.points) {
    const b = bbox(a0), sx = Math.max(0.05, (b.w + dx) / b.w), sy = Math.max(0.05, (b.h + dy) / b.h);
    a.points = a0.points.map(([x, y]) => [b.x + (x - b.x) * sx, b.y + (y - b.y) * sy]); return;
  }
  a.w = Math.max(6, a0.w + dx);
  a.h = a.type === 'img' ? a.w * a0.h / a0.w : Math.max(6, a0.h + dy);
}

// ---------------------------------------------------------------- annotations: rendering
function renderAllOverlays() { S.annots.forEach((_, i) => renderOverlay(i)); }
function renderOverlay(i) {
  const ov = pagesEl.children[i]?.querySelector('.overlay'); if (!ov) return;
  ov.innerHTML = '';
  const k = S.scale;
  (S.annots[i] || []).forEach((a, idx) => {
    const b = bbox(a), el = document.createElement('div');
    el.className = 'an ' + a.type; el.dataset.idx = idx;
    el.style.left = b.x * k + 'px'; el.style.top = b.y * k + 'px';
    if (a.type === 'text') {
      el.textContent = a.text; el.style.fontSize = a.size * k + 'px'; el.style.color = a.color;
    } else if (a.type === 'note') {
      el.innerHTML = `🗨<div class="tip">${esc(a.text)}</div>`;
      el.style.transform = `scale(${k})`; el.style.transformOrigin = '0 0';
    } else {
      el.style.width = b.w * k + 'px'; el.style.height = b.h * k + 'px';
      if (a.type === 'img') el.innerHTML = `<img src="${a.src}" alt="">`;
      else el.innerHTML = svgFor(a, b, k);
    }
    if (S.selected && S.selected.page === i && S.selected.a === a) {
      el.classList.add('sel');
      if (a.type !== 'note') el.insertAdjacentHTML('beforeend', '<div class="handle"></div>');
    }
    ov.appendChild(el);
  });
}
function svgFor(a, b, k) {
  const w = b.w * k, h = b.h * k, sw = (a.width || 2) * k;
  let inner = '';
  if (a.points) {
    const d = a.points.map(([x, y], j) => `${j ? 'L' : 'M'}${((x - b.x) * k).toFixed(1)} ${((y - b.y) * k).toFixed(1)}`).join(' ');
    inner = `<path d="${d}" fill="none" stroke="${a.color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (a.type === 'rect') inner = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" fill="none" stroke="${a.color}" stroke-width="${sw}"/>`;
  else if (a.type === 'ellipse') inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="none" stroke="${a.color}" stroke-width="${sw}"/>`;
  else if (a.type === 'highlight') inner = `<rect width="${w}" height="${h}" fill="${a.color}" opacity=".45" style="mix-blend-mode:multiply"/>`;
  else if (a.type === 'whiteout') inner = `<rect width="${w}" height="${h}" fill="#fff"/>`;
  else if (a.type === 'mark') {
    const pts = markLines(a.kind).map((seg) => seg.map(([x, y]) => `${x * w},${y * h}`).join(' '));
    inner = pts.map((p) => `<polyline points="${p}" fill="none" stroke="${a.color}" stroke-width="${Math.max(1.5, w / 9)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  }
  return `<svg width="${w}" height="${h}" style="position:absolute;inset:0;overflow:visible">${inner}</svg>`;
}
const markLines = (kind) => kind === 'check'
  ? [[[0.12, 0.55], [0.4, 0.85], [0.9, 0.15]]]
  : [[[0.15, 0.15], [0.85, 0.85]], [[0.85, 0.15], [0.15, 0.85]]];

// ---------------------------------------------------------------- annotations: interaction
const color = () => $('#color').value;
const strokeW = () => +$('#size').value;
const fontSz = () => +$('#fontSize').value;

function setTool(tool) {
  S.tool = tool; S.placing = tool === 'place' ? S.placing : null;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'select') { S.selected = null; renderAllOverlays(); }
  updateCursor();
}
function updateCursor() {
  $$('.overlay').forEach((o) => {
    o.classList.toggle('drawing', !['select', 'place'].includes(S.tool));
    o.classList.toggle('placing', S.tool === 'place');
  });
  pagesEl.classList.toggle('select-mode', S.tool === 'select');
}

function bindOverlay(ov, i) {
  const pt = (e) => { const r = ov.getBoundingClientRect(); return [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale]; };
  ov.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.an');
    if (!el) return;
    const a = S.annots[i][+el.dataset.idx];
    if (a.type === 'text') editText(i, a);
    if (a.type === 'note') { const v = prompt(t('notePrompt'), a.text); if (v !== null) { pushHistory(); a.text = v; renderOverlay(i); } }
  });
  ov.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.isContentEditable) return;
    const [x, y] = pt(e), list = S.annots[i];
    const tool = S.tool;

    if (tool === 'place' && S.placing) {
      pushHistory();
      const { src, w, h } = S.placing;
      const a = { type: 'img', x: x - w / 2, y: y - h / 2, w, h, src };
      list.push(a); S.selected = { page: i, a }; setTool('select'); renderOverlay(i); return;
    }
    if (tool === 'select') {
      const el = e.target.closest('.an');
      if (!el) { if (S.selected) { S.selected = null; renderAllOverlays(); } return; }
      const a = list[+el.dataset.idx];
      const prev = S.selected; S.selected = { page: i, a };
      if (prev && prev.page !== i) renderOverlay(prev.page);
      const isHandle = e.target.classList.contains('handle');
      const a0 = clone(a); let moved = false;
      const elNow = () => ov.querySelector(`.an[data-idx="${list.indexOf(a)}"]`);
      renderOverlay(i);
      const e0 = elNow(); if (e0) e0._w0 = e0.offsetWidth / S.scale || 1;
      const w0 = e0?._w0;
      ov.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const [x2, y2] = pt(ev), dx = x2 - x, dy = y2 - y;
        if (!moved && Math.hypot(dx, dy) < 1) return;
        if (!moved) { pushHistory(); moved = true; }
        if (isHandle) resize(a, a0, dx, dy, { _w0: w0 }); else translate(a, a0, dx, dy);
        renderOverlay(i);
      };
      const up = () => { ov.removeEventListener('pointermove', move); ov.removeEventListener('pointerup', up); };
      ov.addEventListener('pointermove', move); ov.addEventListener('pointerup', up);
      e.preventDefault(); return;
    }
    e.preventDefault();
    if (tool === 'text') { pushHistory(); const a = { type: 'text', x, y: y - fontSz() * 0.6, text: '', size: fontSz(), color: color() }; list.push(a); renderOverlay(i); editText(i, a, true); return; }
    if (tool === 'date') { pushHistory(); list.push({ type: 'text', x, y: y - fontSz() * 0.6, text: new Date().toLocaleDateString(), size: fontSz(), color: color() }); renderOverlay(i); return; }
    if (tool === 'note') { const v = prompt(t('notePrompt')); if (v) { pushHistory(); list.push({ type: 'note', x: x - 10, y: y - 10, text: v }); renderOverlay(i); } return; }
    if (tool === 'check' || tool === 'cross') { pushHistory(); const s = Math.max(12, fontSz() * 1.2); list.push({ type: 'mark', kind: tool, x: x - s / 2, y: y - s / 2, w: s, h: s, color: color() }); renderOverlay(i); return; }

    // drag-to-draw tools
    pushHistory();
    let a;
    if (tool === 'pen') a = { type: 'pen', points: [[x, y]], color: color(), width: strokeW() };
    else if (tool === 'line') a = { type: 'line', points: [[x, y], [x, y]], color: color(), width: strokeW() };
    else a = { type: tool, x, y, w: 1, h: 1, color: tool === 'highlight' ? HIGHLIGHT : color(), width: strokeW() };
    list.push(a);
    ov.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const [x2, y2] = pt(ev);
      if (tool === 'pen') a.points.push([x2, y2]);
      else if (tool === 'line') a.points[1] = ev.shiftKey ? snap45(x, y, x2, y2) : [x2, y2];
      else { a.x = Math.min(x, x2); a.y = Math.min(y, y2); a.w = Math.abs(x2 - x); a.h = Math.abs(y2 - y); }
      renderOverlay(i);
    };
    const up = () => {
      ov.removeEventListener('pointermove', move); ov.removeEventListener('pointerup', up);
      const b = bbox(a);
      if ((a.points && a.points.length < 2) || (!a.points && (b.w < 3 || b.h < 3))) { list.splice(list.indexOf(a), 1); S.history.pop(); }
      renderOverlay(i);
    };
    ov.addEventListener('pointermove', move); ov.addEventListener('pointerup', up);
  });
}
function snap45(x, y, x2, y2) {
  const ang = Math.round(Math.atan2(y2 - y, x2 - x) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x2 - x, y2 - y);
  return [x + Math.cos(ang) * d, y + Math.sin(ang) * d];
}
function editText(i, a, isNew) {
  if (!isNew) pushHistory();
  const ov = pagesEl.children[i].querySelector('.overlay');
  const el = ov.querySelector(`.an[data-idx="${S.annots[i].indexOf(a)}"]`); if (!el) return;
  el.contentEditable = 'true'; el.focus();
  const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
  el.addEventListener('blur', () => {
    a.text = el.innerText.replace(/\n$/, '');
    if (!a.text.trim()) S.annots[i].splice(S.annots[i].indexOf(a), 1);
    renderOverlay(i);
  }, { once: true });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.blur(); e.stopPropagation(); });
}
function deleteSelected() {
  if (!S.selected) return;
  pushHistory();
  const { page, a } = S.selected; const l = S.annots[page]; l.splice(l.indexOf(a), 1);
  S.selected = null; renderOverlay(page);
}

// ---------------------------------------------------------------- bake annotations into PDF (pdf-lib)
function rasterText(text, size, colorHex) {
  const k = 4, lines = text.split('\n'), c = document.createElement('canvas'), g = c.getContext('2d');
  const font = `${size * k}px Helvetica, Arial, "Nirmala UI", "Noto Sans Devanagari", sans-serif`;
  g.font = font;
  const w = Math.max(...lines.map((l) => g.measureText(l).width), 1);
  c.width = Math.ceil(w); c.height = Math.ceil(lines.length * size * 1.2 * k);
  g.font = font; g.fillStyle = colorHex; g.textBaseline = 'top';
  lines.forEach((l, j) => g.fillText(l, 0, j * size * 1.2 * k + size * 0.1 * k));
  return { url: c.toDataURL('image/png'), w: c.width / k, h: c.height / k };
}
const dataUrlBytes = (u) => Uint8Array.from(atob(u.split(',')[1]), (c) => c.charCodeAt(0));

async function bake({ forSave }) {
  const doc = await loadLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const imgCache = new Map();
  const embed = async (src) => {
    if (!imgCache.has(src)) imgCache.set(src, src.startsWith('data:image/jpeg') ? await doc.embedJpg(dataUrlBytes(src)) : await doc.embedPng(dataUrlBytes(src)));
    return imgCache.get(src);
  };
  for (let i = 0; i < S.annots.length; i++) {
    const list = S.annots[i]; if (!list.length) continue;
    const page = doc.getPage(i), vp = S.vps[i], R = vp.rotation % 360;
    const P = (x, y) => vp.convertToPdfPoint(x, y);
    const box = (a) => { const [x1, y1] = P(a.x, a.y), [x2, y2] = P(a.x + a.w, a.y + a.h); return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }; };
    const drawImg = async (src, x, y, w, h) => { const [px, py] = P(x, y + h); page.drawImage(await embed(src), { x: px, y: py, width: w, height: h, rotate: degrees(R) }); };
    const line = (p1, p2, c, th) => page.drawLine({ start: { x: p1[0], y: p1[1] }, end: { x: p2[0], y: p2[1] }, thickness: th, color: c, lineCap: LineCapStyle.Round });

    for (const a of list) {
      const c = a.color ? hexRgb(a.color) : undefined;
      if (a.type === 'rect') { const b = box(a); page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, borderColor: c, borderWidth: a.width }); }
      else if (a.type === 'whiteout') { const b = box(a); page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, color: rgb(1, 1, 1) }); }
      else if (a.type === 'highlight') { const b = box(a); page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, color: c, opacity: 0.45, blendMode: BlendMode.Multiply }); }
      else if (a.type === 'ellipse') { const b = box(a); page.drawEllipse({ x: b.x + b.w / 2, y: b.y + b.h / 2, xScale: b.w / 2, yScale: b.h / 2, borderColor: c, borderWidth: a.width }); }
      else if (a.points) { for (let j = 1; j < a.points.length; j++) line(P(...a.points[j - 1]), P(...a.points[j]), c, a.width); if (a.points.length === 1) line(P(...a.points[0]), P(...a.points[0]), c, a.width); }
      else if (a.type === 'mark') { const th = Math.max(1.5, a.w / 9); markLines(a.kind).forEach((seg) => { for (let j = 1; j < seg.length; j++) line(P(a.x + seg[j - 1][0] * a.w, a.y + seg[j - 1][1] * a.h), P(a.x + seg[j][0] * a.w, a.y + seg[j][1] * a.h), c, th); }); }
      else if (a.type === 'img') await drawImg(a.src, a.x, a.y, a.w, a.h);
      else if (a.type === 'text') {
        const ok = latinSafe(a.text);
        if (ok) {
          const [px, py] = P(a.x, a.y + a.size * 0.93);
          page.drawText(a.text, { x: px, y: py, size: a.size, font, color: c, lineHeight: a.size * 1.2, rotate: degrees(R) });
        } else { const r = rasterText(a.text, a.size, a.color); await drawImg(r.url, a.x, a.y, r.w, r.h); }
      } else if (a.type === 'note') {
        const [x1, y1] = P(a.x, a.y), [x2, y2] = P(a.x + 20, a.y + 20);
        const ref = doc.context.register(doc.context.obj({
          Type: 'Annot', Subtype: 'Text', Rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
          Contents: PDFHexString.fromText(a.text), Name: 'Comment', C: [1, 0.83, 0.23], F: 4, T: PDFHexString.fromText('Documentaan'),
        }));
        page.node.addAnnot(ref);
      }
    }
  }
  if (forSave && S.protect) doc.encrypt(S.protect);
  return doc.save();
}

// ---------------------------------------------------------------- save / print / download
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function save(saveAs = false) {
  if (!S.bytes) return;
  document.activeElement?.blur?.();
  let out;
  try { out = await bake({ forSave: true }); } catch (e) { console.error(e); return toast('Save failed: ' + e.message, 4000); }
  if (isDesktop) {
    try {
      const path = await nativeSave(out, saveAs ? null : S.handle, S.name);
      if (!path) return;
      S.handle = path; S.name = baseName(path); $('#fileName').textContent = S.name; setTitle(`${S.name} — Documentaan`);
      S.dirty = false; toast(t('saved') + ' ✓');
    } catch (e) { console.error(e); toast('Save failed: ' + e, 5000); }
    return;
  }
  try {
    if (window.showSaveFilePicker) {
      let h = saveAs ? null : S.handle;
      if (!h) h = await window.showSaveFilePicker({ suggestedName: S.name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const w = await h.createWritable(); await w.write(out); await w.close();
      S.handle = h; S.name = h.name; $('#fileName').textContent = S.name;
    } else download(out, S.name);
    S.dirty = false; toast(t('saved') + ' ✓');
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); download(out, S.name); } }
}
async function print() {
  const out = await bake({ forSave: false });
  const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
  const f = Object.assign(document.createElement('iframe'), { src: url, style: 'position:fixed;width:0;height:0;border:0' });
  document.body.appendChild(f);
  f.onload = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 60000); };
}

// ---------------------------------------------------------------- search
let searchT;
$('#searchInput').addEventListener('input', (e) => { clearTimeout(searchT); searchT = setTimeout(() => search(e.target.value.trim()), 250); });
async function search(q) {
  const box = $('#searchResults');
  if (!q || !S.pdf) { box.hidden = true; thumbsEl.hidden = false; return; }
  if (!S.texts) {
    S.texts = [];
    for (let i = 1; i <= S.pdf.numPages; i++) S.texts.push((await (await S.pdf.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  }
  const ql = q.toLowerCase(), hits = [];
  S.texts.forEach((txt, i) => {
    const low = txt.toLowerCase(); let k = low.indexOf(ql);
    while (k >= 0 && hits.length < 300) { hits.push({ i, s: txt.slice(Math.max(0, k - 30), k), m: txt.slice(k, k + q.length), e: txt.slice(k + q.length, k + q.length + 30) }); k = low.indexOf(ql, k + 1); }
  });
  thumbsEl.hidden = true; box.hidden = false;
  box.innerHTML = `<div class="muted" style="margin:4px">${hits.length ? hits.length + ' ' + t('results') : t('noResults')}</div>` +
    hits.map((h) => `<div class="res" data-p="${h.i + 1}"><b>${t('pageOf')} ${h.i + 1}</b><br>…${esc(h.s)}<mark>${esc(h.m)}</mark>${esc(h.e)}…</div>`).join('');
}
$('#searchResults').addEventListener('click', (e) => { const r = e.target.closest('.res'); if (r) gotoPage(+r.dataset.p); });

// ---------------------------------------------------------------- tools
async function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
    inp.onchange = () => res([...inp.files]); inp.click();
  });
}

async function mergePdfs(files) {
  files = files || await pickFiles('application/pdf'); if (!files.length) return;
  const srcs = [];
  for (const f of files) srcs.push({ doc: await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true }), name: f.name });
  if (!S.bytes) {
    const out = await PDFDocument.create();
    for (const s of srcs) (await out.copyPages(s.doc, s.doc.getPageIndices())).forEach((p) => out.addPage(p));
    return openBytes(await out.save(), 'merged.pdf', null);
  }
  await mutate(async (doc) => {
    for (const s of srcs) (await doc.copyPages(s.doc, s.doc.getPageIndices())).forEach((p) => { doc.addPage(p); S.annots.push([]); });
  });
  toast(t('done') + ' ✓');
}

async function imagesToPdf(files) {
  files = files || await pickFiles('image/*'); if (!files.length) return;
  if (S.dirty && !confirm(t('unsaved'))) return;
  const doc = await PDFDocument.create();
  for (const f of files) {
    let img;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (f.type === 'image/jpeg') img = await doc.embedJpg(buf);
    else if (f.type === 'image/png') img = await doc.embedPng(buf);
    else { // convert anything else (webp, gif, bmp...) via canvas
      const bm = await createImageBitmap(f); const c = Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
      c.getContext('2d').drawImage(bm, 0, 0); img = await doc.embedJpg(dataUrlBytes(c.toDataURL('image/jpeg', 0.92)));
    }
    const k = 842 / Math.max(img.width, img.height), w = img.width * k, h = img.height * k;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  openBytes(await doc.save(), 'images.pdf', null);
}

function parseRanges(str, n) {
  const out = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => x.trim());
    const s = Math.max(1, +a || 1), e = Math.min(n, b === undefined ? s : (+b || n));
    for (let k = s; k <= e; k++) out.push(k - 1);
  }
  return out;
}
function splitDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  const n = S.vps.length;
  const m = modal(t('split'), `
    <label data-i18n="ranges"></label><input type="text" id="rg" placeholder="1-${n}">
    <label data-i18n="everyN"></label><input type="number" id="ev" min="1" max="${n}" placeholder="1">
    <div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn" id="sp" data-i18n="splitBtn"></button><button class="btn primary" id="ex" data-i18n="extract"></button></div>`);
  $('#c', m.el).onclick = m.close;
  const base = S.name.replace(/\.pdf$/i, '');
  const build = async (idx) => { const src = await PDFDocument.load(await bake({ forSave: false })); const out = await PDFDocument.create(); (await out.copyPages(src, idx)).forEach((p) => out.addPage(p)); return out.save(); };
  $('#ex', m.el).onclick = async () => {
    const idx = parseRanges($('#rg', m.el).value || `1-${n}`, n); if (!idx.length) return;
    download(await build(idx), `${base}-pages.pdf`); m.close();
  };
  $('#sp', m.el).onclick = async () => {
    const every = Math.max(1, +$('#ev', m.el).value || 1);
    for (let s = 0, part = 1; s < n; s += every, part++) download(await build([...Array(Math.min(every, n - s)).keys()].map((k) => k + s)), `${base}-part${part}.pdf`);
    m.close();
  };
}

async function drawTextSmart(doc, page, text, { x, y, size, color: c, opacity = 1, rotate = 0, font }) {
  const ok = latinSafe(text);
  if (ok) { page.drawText(text, { x, y, size, font, color: hexRgb(c), opacity, rotate: degrees(rotate) }); return font.widthOfTextAtSize(text, size); }
  const r = rasterText(text, size, c); const img = await doc.embedPng(dataUrlBytes(r.url));
  page.drawImage(img, { x, y: y - size * 0.2, width: r.w, height: r.h, opacity, rotate: degrees(rotate) }); return r.w;
}
const textWidth = (font, text, size) => (latinSafe(text) ? font.widthOfTextAtSize(text, size) : rasterText(text, size, "#000").w);

function watermarkDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  const m = modal(t('watermark'), `
    <label data-i18n="wmText"></label><input type="text" id="wt" value="CONFIDENTIAL">
    <label data-i18n="fontSizeL"></label><input type="number" id="ws" value="60">
    <label data-i18n="opacity"></label><input type="number" id="wo" value="0.2" step="0.05" min="0.05" max="1">
    <label>Color</label><input type="color" id="wc" value="#c62f2f">
    <div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn primary" id="ok" data-i18n="apply"></button></div>`);
  $('#c', m.el).onclick = m.close;
  $('#ok', m.el).onclick = async () => {
    const text = $('#wt', m.el).value, size = +$('#ws', m.el).value || 60, opacity = +$('#wo', m.el).value || 0.2, c = $('#wc', m.el).value;
    m.close(); if (!text) return;
    await mutate(async (doc) => {
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (const p of doc.getPages()) {
        const { width, height } = p.getSize(), tw = textWidth(font, text, size), r = Math.PI / 4;
        const x = width / 2 - (Math.cos(r) * tw - Math.sin(r) * size * 0.35) / 2, y = height / 2 - (Math.sin(r) * tw + Math.cos(r) * size * 0.35) / 2;
        await drawTextSmart(doc, p, text, { x, y, size, color: c, opacity, rotate: 45, font });
      }
    });
  };
}

function pageNumbersDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  const m = modal(t('pageNumbers'), `
    <label data-i18n="format"></label><select id="pf"><option value="n">1</option><option value="n/N">1 / N</option><option value="page">Page 1 of N</option><option value="ne">पृष्ठ १ / N</option></select>
    <label data-i18n="position"></label><select id="pp"><option value="bc">Bottom center</option><option value="br">Bottom right</option><option value="tr">Top right</option></select>
    <label data-i18n="fontSizeL"></label><input type="number" id="ps" value="11">
    <div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn primary" id="ok" data-i18n="apply"></button></div>`);
  $('#c', m.el).onclick = m.close;
  $('#ok', m.el).onclick = async () => {
    const f = $('#pf', m.el).value, pos = $('#pp', m.el).value, size = +$('#ps', m.el).value || 11; m.close();
    const dev = (n) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[d]);
    await mutate(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica), N = doc.getPageCount();
      for (const [k, p] of doc.getPages().entries()) {
        const n = k + 1, text = f === 'n' ? `${n}` : f === 'n/N' ? `${n} / ${N}` : f === 'page' ? `Page ${n} of ${N}` : `पृष्ठ ${dev(n)} / ${dev(N)}`;
        const { width, height } = p.getSize(), tw = textWidth(font, text, size);
        const x = pos === 'bc' ? (width - tw) / 2 : width - tw - 36, y = pos === 'tr' ? height - 30 : 22;
        await drawTextSmart(doc, p, text, { x, y, size, color: '#333333', font });
      }
    });
  };
}

function protectDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  const m = modal(t('protect'), `
    <label data-i18n="userPw"></label><input type="password" id="up" autocomplete="new-password">
    <label data-i18n="ownerPw"></label><input type="password" id="op" autocomplete="new-password">
    <label class="check"><input type="checkbox" id="pr" checked> <span data-i18n="allowPrint"></span></label>
    <label class="check"><input type="checkbox" id="cp"> <span data-i18n="allowCopy"></span></label>
    <p class="muted" data-i18n="protectNote"></p>
    <div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn primary" id="ok" data-i18n="apply"></button></div>`);
  $('#c', m.el).onclick = m.close;
  $('#ok', m.el).onclick = () => {
    const up = $('#up', m.el).value; if (!up) return;
    S.protect = { userPassword: up, ownerPassword: $('#op', m.el).value || up + '-owner-' + crypto.randomUUID().slice(0, 8),
      permissions: { printing: $('#pr', m.el).checked ? 'highResolution' : false, copying: $('#cp', m.el).checked, modifying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false } };
    S.dirty = true; m.close(); toast(t('protectNote'));
  };
}

async function formsDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  const doc = await loadLib(), fields = doc.getForm().getFields();
  if (!fields.length) return toast(t('noFields'), 3000);
  const rows = fields.map((f, k) => {
    const nm = esc(f.getName()); let input = '';
    if (f instanceof PDFTextField) input = `<input type="text" data-k="${k}" value="${esc(f.getText() || '')}">`;
    else if (f instanceof PDFCheckBox) input = `<input type="checkbox" data-k="${k}" ${f.isChecked() ? 'checked' : ''}>`;
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList) { const sel = f.getSelected()[0]; input = `<select data-k="${k}"><option></option>${f.getOptions().map((o) => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; }
    else if (f instanceof PDFRadioGroup) { const sel = f.getSelected(); input = `<select data-k="${k}"><option></option>${f.getOptions().map((o) => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; }
    else return '';
    return `<div class="field-row"><span title="${nm}">${nm}</span>${input}</div>`;
  }).join('');
  const m = modal(t('fillForm'), `<div>${rows}</div><div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn primary" id="ok" data-i18n="apply"></button></div>`, { wide: true });
  $('#c', m.el).onclick = m.close;
  $('#ok', m.el).onclick = async () => {
    const vals = $$('[data-k]', m.el).map((el) => [+el.dataset.k, el.type === 'checkbox' ? el.checked : el.value]); m.close();
    await mutate((d) => {
      const fs = d.getForm().getFields();
      for (const [k, v] of vals) {
        const f = fs[k];
        try {
          if (f instanceof PDFTextField) f.setText(v);
          else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck();
          else if (f instanceof PDFDropdown || f instanceof PDFOptionList) v ? f.select(v) : f.clear();
          else if (f instanceof PDFRadioGroup) v ? f.select(v) : f.clear();
        } catch (e) { console.warn(f.getName(), e); }
      }
    });
    toast(t('done') + ' ✓');
  };
}
async function flatten() {
  if (!S.bytes) return toast(t('needPdf'));
  await mutate((doc) => doc.getForm().flatten()); toast(t('done') + ' ✓');
}

// ---------------------------------------------------------------- signatures
function signDialog() {
  if (!S.bytes) return toast(t('needPdf'));
  openSignatureDialog({ modal, toast, onPick: (sig) => {
    let w = 170, h = w * sig.h / sig.w;
    if (h > 80) { h = 80; w = h * sig.w / sig.h; }
    S.placing = { src: sig.dataUrl, w, h };
    setTool('place'); toast(t('clickToPlace'), 3000);
  } });
}

// ---------------------------------------------------------------- wiring
const actions = {
  merge: () => mergePdfs(), split: splitDialog, images: () => imagesToPdf(), insertBlank,
  watermark: watermarkDialog, pageNumbers: pageNumbersDialog, protect: protectDialog, forms: formsDialog, flatten,
};
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) { $('#toolsMenu').hidden = true; actions[act.dataset.act]?.(); return; }
  if (!e.target.closest('.menu')) $('#toolsMenu').hidden = true;
});
$('#btnTools').onclick = () => ($('#toolsMenu').hidden = !$('#toolsMenu').hidden);
$('#btnOpen').onclick = openFile; $('#btnOpen2').onclick = openFile;
$('#btnSave').onclick = () => save(false);
$('#btnPrint').onclick = print;
$('#btnSign').onclick = signDialog;
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#zoomIn').onclick = () => setZoom(S.scale * 1.2);
$('#zoomOut').onclick = () => setZoom(S.scale / 1.2);
$('#zoomFit').onclick = () => fitWidth(false);
$('#pageInput').onchange = (e) => gotoPage(+e.target.value);
$$('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$('#btnLang').onclick = () => { toggleLang(); if (S.pdf) renderThumbs(); };
$('#btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('dc-theme', dark ? 'dark' : 'light'); } catch {}
};
try {
  const th = localStorage.getItem('dc-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = th;
} catch {}

document.addEventListener('keydown', (e) => {
  const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); return; }
  if (mod && e.key.toLowerCase() === 'p' && S.bytes) { e.preventDefault(); print(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.scale * 1.2); }
  else if (mod && e.key === '-') { e.preventDefault(); setZoom(S.scale / 1.2); }
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'Escape') { setTool('select'); S.selected = null; renderAllOverlays(); }
});
viewer.addEventListener('wheel', (e) => { if (e.ctrlKey && S.pdf) { e.preventDefault(); setZoom(S.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
window.addEventListener('resize', () => {});
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// drag & drop files anywhere
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); $('.drop')?.classList.add('over'); } });
window.addEventListener('dragleave', () => $('.drop')?.classList.remove('over'));
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault(); $('.drop')?.classList.remove('over');
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)), imgs = files.filter((f) => f.type.startsWith('image/'));
  if (pdfs.length === 1 && !S.bytes) { if (!S.dirty || confirm(t('unsaved'))) openBytes(new Uint8Array(await pdfs[0].arrayBuffer()), pdfs[0].name, null); }
  else if (pdfs.length) mergePdfs(pdfs);
  else if (imgs.length) imagesToPdf(imgs);
});

applyI18n();

// Desktop app: open PDFs passed by Windows (double-click / "Open with") and guard unsaved close.
onExternalOpen(async (path) => {
  if (S.dirty && !confirm(t('unsaved'))) return;
  try { openBytes(await readPath(path), baseName(path), path); } catch (e) { toast('Open failed: ' + e, 4000); }
});
guardClose(() => S.dirty, t('unsaved'));
