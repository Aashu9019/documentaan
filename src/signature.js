import { t } from './i18n.js';
import { listSignatures, saveSignature, deleteSignature } from './store.js';

const FONTS = ['Dancing Script', 'Great Vibes', 'Caveat', 'Segoe Script', 'Brush Script MT'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Crop a canvas to its non-transparent pixels and return { dataUrl, w, h }.
function trim(c) {
  const g = c.getContext('2d'), { width, height } = c, d = g.getImageData(0, 0, width, height).data;
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (d[(y * width + x) * 4 + 3] > 8) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  }
  if (x2 < 0) return null;
  const pad = 6, w = x2 - x1 + 1 + pad * 2, h = y2 - y1 + 1 + pad * 2;
  const o = Object.assign(document.createElement('canvas'), { width: w, height: h });
  o.getContext('2d').drawImage(c, x1 - pad, y1 - pad, w, h, 0, 0, w, h);
  return { dataUrl: o.toDataURL('image/png'), w, h };
}

export async function openSignatureDialog({ modal, toast, ask, onPick }) {
  const m = modal(t('mySignatures'), `
    <div class="sig-grid" id="grid"></div>
    <h3 data-i18n="addSignature"></h3>
    <div class="tabs"><button class="on" data-tab="draw" data-i18n="draw"></button><button data-tab="type" data-i18n="type"></button><button data-tab="upload" data-i18n="upload"></button></div>
    <div data-pane="draw">
      <canvas class="pad" id="pad"></canvas>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        <div class="row">
          <button class="btn" data-ink="#111111" style="color:#111">●</button>
          <button class="btn" data-ink="#1d3fb8" style="color:#1d3fb8">●</button>
          <button class="btn" data-ink="#b81d1d" style="color:#b81d1d">●</button>
        </div>
        <button class="btn" id="clr" data-i18n="clear"></button>
      </div>
    </div>
    <div data-pane="type" hidden>
      <input type="text" id="typed" data-i18n-ph="typeYourName" placeholder="">
      <div class="font-opts" id="fonts"></div>
    </div>
    <div data-pane="upload" hidden>
      <input type="file" id="upl" accept="image/*">
      <label class="check"><input type="checkbox" id="rmbg" checked> <span data-i18n="removeBg"></span></label>
      <canvas id="uplPrev" style="max-width:100%;max-height:160px;display:none;background:#fff;border:1px solid var(--line);border-radius:8px;margin-top:8px"></canvas>
    </div>
    <label data-i18n="name"></label>
    <input type="text" id="nm" data-i18n-ph="signatureName" placeholder="">
    <div class="actions"><button class="btn" id="cls" data-i18n="close"></button><button class="btn primary" id="sv" data-i18n="saveSig"></button></div>
  `, { wide: true });
  const $ = (s) => m.el.querySelector(s);
  let tab = 'draw';

  // ---- saved list (unlimited)
  async function refresh() {
    const sigs = await listSignatures();
    $('#grid').innerHTML = sigs.length ? sigs.map((s) => `
      <div class="sig-card" data-id="${s.id}" title="${esc(s.name)}"><img src="${s.dataUrl}" alt=""><div class="nm">${esc(s.name)}</div>
      <button class="x" data-del="${s.id}" title="${t('delete')}">✕</button></div>`).join('')
      : `<p class="muted" style="grid-column:1/-1">${t('noSigs')}</p>`;
    $('#grid')._sigs = sigs;
  }
  $('#grid').addEventListener('click', async (e) => {
    const del = e.target.dataset.del;
    if (del) { e.stopPropagation(); if (await ask(t('deleteSig'), { ok: t('delete'), danger: true })) { await deleteSignature(del); refresh(); } return; }
    const card = e.target.closest('.sig-card'); if (!card) return;
    const sig = $('#grid')._sigs.find((s) => s.id === card.dataset.id);
    m.close(); onPick(sig);
  });

  // ---- tabs
  m.el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    m.el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    m.el.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === 'draw') sizePad();
  }));

  // ---- draw pad with smoothed, pressure-ish strokes
  const pad = $('#pad'), pg = pad.getContext('2d');
  let ink = '#111111', drawn = false;
  function sizePad() {
    const r = pad.getBoundingClientRect(); if (!r.width) return;
    const old = drawn ? pad.toDataURL() : null;
    pad.width = r.width * 2; pad.height = r.height * 2;
    pg.setTransform(2, 0, 0, 2, 0, 0); pg.lineCap = pg.lineJoin = 'round';
    if (old) { const im = new Image(); im.onload = () => pg.drawImage(im, 0, 0, r.width, r.height); im.src = old; }
  }
  requestAnimationFrame(sizePad);
  let pts = [], lastW = 2.5;
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); pts = [[e.offsetX, e.offsetY, e.timeStamp]]; drawn = true; });
  pad.addEventListener('pointermove', (e) => {
    if (!pts.length) return;
    const p = [e.offsetX, e.offsetY, e.timeStamp], q = pts[pts.length - 1];
    const v = Math.hypot(p[0] - q[0], p[1] - q[1]) / Math.max(1, p[2] - q[2]);
    const w = e.pressure && e.pointerType === 'pen' ? 1 + e.pressure * 3.5 : Math.max(1.2, Math.min(3.6, 3.8 - v * 1.2));
    lastW = lastW * 0.6 + w * 0.4;
    pts.push(p);
    if (pts.length >= 3) {
      const [a, b, c] = pts.slice(-3);
      pg.beginPath(); pg.strokeStyle = ink; pg.lineWidth = lastW;
      pg.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pg.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2); pg.stroke();
    }
  });
  const end = () => { if (pts.length === 1) { pg.beginPath(); pg.fillStyle = ink; pg.arc(pts[0][0], pts[0][1], 1.6, 0, 7); pg.fill(); } pts = []; };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  $('#clr').onclick = () => { pg.clearRect(0, 0, pad.width, pad.height); drawn = false; };
  m.el.querySelectorAll('[data-ink]').forEach((b) => (b.onclick = () => (ink = b.dataset.ink)));

  // ---- typed
  let font = FONTS[0];
  const renderFonts = () => {
    const txt = $('#typed').value || 'Signature';
    $('#fonts').innerHTML = FONTS.map((f) => `<button class="${f === font ? 'on' : ''}" data-font="${f}" style="font-family:'${f}',cursive">${esc(txt)}</button>`).join('');
  };
  $('#typed').addEventListener('input', renderFonts);
  $('#fonts').addEventListener('click', (e) => { const b = e.target.closest('[data-font]'); if (b) { font = b.dataset.font; renderFonts(); } });
  renderFonts();

  // ---- upload
  let upCanvas = null;
  const processUpload = async () => {
    const f = $('#upl').files[0]; if (!f) return;
    const bm = await createImageBitmap(f), k = Math.min(1, 1200 / bm.width);
    const c = $('#uplPrev'); c.width = bm.width * k; c.height = bm.height * k;
    const g = c.getContext('2d'); g.drawImage(bm, 0, 0, c.width, c.height);
    if ($('#rmbg').checked) {
      const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (l > 215) d[i + 3] = 0; else if (l > 170) d[i + 3] = Math.round(d[i + 3] * (215 - l) / 45);
      }
      g.putImageData(id, 0, 0);
    }
    c.style.display = 'block'; upCanvas = c;
  };
  $('#upl').addEventListener('change', processUpload);
  $('#rmbg').addEventListener('change', processUpload);

  // ---- save
  $('#cls').onclick = m.close;
  $('#sv').onclick = async () => {
    let out = null;
    if (tab === 'draw') out = drawn ? trim(pad) : null;
    else if (tab === 'type') {
      const txt = $('#typed').value.trim(); if (!txt) return;
      await document.fonts.load(`120px "${font}"`).catch(() => {});
      const c = document.createElement('canvas'), g = c.getContext('2d'), f = `120px "${font}", cursive`;
      g.font = f; c.width = Math.ceil(g.measureText(txt).width + 60); c.height = 220;
      g.font = f; g.fillStyle = '#111'; g.textBaseline = 'middle'; g.fillText(txt, 30, 110);
      out = trim(c);
    } else if (upCanvas) out = trim(upCanvas);
    if (!out) return toast(t('drawHere'));
    const sigs = await listSignatures();
    await saveSignature({ name: $('#nm').value.trim() || `Signature ${sigs.length + 1}`, ...out });
    $('#nm').value = ''; $('#clr').click(); toast(t('saved') + ' ✓');
    refresh();
  };

  refresh();
}
