// Template library: reusable designs (cover letters, certificates, letterheads...)
// stored on this device. A template is a base PDF plus editable layers (text,
// images, shapes), so it can be re-opened and changed at any time.
import { PDFDocument } from '@cantoo/pdf-lib';
import { t } from './i18n.js';
import { listTemplates, getTemplate, putTemplate, deleteTemplate } from './store.js';

export const DEFAULT_CATEGORIES = ['cover', 'certificate', 'letterhead', 'invoice', 'other'];
export const catLabel = (c) => (DEFAULT_CATEGORIES.includes(c) ? t('cat_' + c) : c);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

let api, activeCat = 'all';

/** api: { modal, toast, ask, pickFiles, openTemplate(tpl, mode) } */
export function initTemplates(a) {
  api = a;
  document.getElementById('tplGrid').addEventListener('click', onGridClick);
  document.getElementById('tplChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]'); if (!c) return;
    activeCat = c.dataset.cat; renderGallery();
  });
  document.getElementById('btnNewTpl').onclick = newTemplateDialog;
  renderGallery();
}

export async function allCategories() {
  const list = await listTemplates();
  const custom = [...new Set(list.map((x) => x.category).filter((c) => c && !DEFAULT_CATEGORIES.includes(c)))];
  return [...DEFAULT_CATEGORIES, ...custom];
}

export async function renderGallery() {
  const grid = document.getElementById('tplGrid'), chips = document.getElementById('tplChips');
  if (!grid) return;
  const list = await listTemplates();
  const cats = await allCategories();
  const count = (c) => list.filter((x) => x.category === c).length;
  chips.innerHTML = [['all', t('allCats'), list.length], ...cats.map((c) => [c, catLabel(c), count(c)])]
    .filter(([c, , n]) => c === 'all' || n || DEFAULT_CATEGORIES.includes(c))
    .map(([c, label, n]) => `<button class="chip${c === activeCat ? ' on' : ''}" data-cat="${esc(c)}">${esc(label)}<span>${n}</span></button>`).join('');
  const shown = activeCat === 'all' ? list : list.filter((x) => x.category === activeCat);
  grid.innerHTML = `<button class="tpl-card tpl-new" data-new="1"><span class="plus">+</span><b>${esc(t('newTemplate'))}</b><span class="muted">${esc(t('newTplHint'))}</span></button>` +
    shown.map((x) => `
      <div class="tpl-card" data-id="${x.id}" tabindex="0" title="${esc(t('useTpl'))}">
        <div class="tpl-thumb">${x.thumb ? `<img src="${x.thumb}" alt="">` : ''}</div>
        <div class="tpl-meta"><b>${esc(x.name)}</b><span>${esc(catLabel(x.category))}</span></div>
        <div class="tpl-actions">
          <button data-op="edit" title="${esc(t('editDesign'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg></button>
          <button data-op="dup" title="${esc(t('duplicate'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
          <button data-op="del" title="${esc(t('delete'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>
        </div>
        <button class="tpl-use">${esc(t('useTpl'))}</button>
      </div>`).join('');
  if (!shown.length && list.length) grid.insertAdjacentHTML('beforeend', `<p class="muted tpl-empty">${esc(t('noTplInCat'))}</p>`);
}

async function onGridClick(e) {
  if (e.target.closest('[data-new]')) return newTemplateDialog();
  const card = e.target.closest('.tpl-card[data-id]'); if (!card) return;
  const id = card.dataset.id, op = e.target.closest('[data-op]')?.dataset.op;
  const tpl = await getTemplate(id); if (!tpl) return renderGallery();
  if (op === 'del') {
    if (await api.ask(t('deleteTplQ').replace('{n}', tpl.name), { ok: t('delete'), danger: true })) { await deleteTemplate(id); renderGallery(); }
  } else if (op === 'dup') {
    await putTemplate({ ...tpl, id: crypto.randomUUID(), name: `${tpl.name} (${t('copy')})`, created: Date.now() });
    renderGallery(); api.toast(t('done') + ' ✓');
  } else api.openTemplate(tpl, op === 'edit' ? 'edit' : 'use');
}

export async function categorySelect(selected) {
  const cats = await allCategories();
  return `<select class="cat-select">${cats.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(catLabel(c))}</option>`).join('')}
    <option value="__new">${esc(t('newCategory'))}</option></select>`;
}
/** Handles the "New category..." option of a category <select>. */
export function bindCategorySelect(sel, onChange) {
  let prev = sel.value;
  sel.addEventListener('change', async () => {
    if (sel.value === '__new') {
      const name = (await api.promptText(t('newCategory'), { label: t('categoryName') }))?.trim();
      if (name) { sel.insertAdjacentHTML('afterbegin', `<option value="${esc(name)}">${esc(name)}</option>`); sel.value = name; }
      else sel.value = prev;
    }
    prev = sel.value; onChange?.(sel.value);
  });
}

async function imageToDataUrl(file, maxDim = 2400) {
  const bm = await createImageBitmap(file);
  const k = Math.min(1, maxDim / Math.max(bm.width, bm.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bm.width * k), height: Math.round(bm.height * k) });
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  const png = file.type === 'image/png' || file.type === 'image/svg+xml';
  return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92), w: bm.width, h: bm.height };
}
export { imageToDataUrl };

async function newTemplateDialog() {
  const m = api.modal(t('newTemplate'), `
    <label data-i18n="tplName"></label><input type="text" id="tn" data-i18n-ph="tplNamePh">
    <label data-i18n="category"></label>${await categorySelect(activeCat !== 'all' ? activeCat : 'cover')}
    <label data-i18n="startFrom"></label>
    <div class="src-grid">
      <button class="src-card on" data-src="pdf"><b data-i18n="srcPdf"></b><span class="muted" data-i18n="srcPdfD"></span></button>
      <button class="src-card" data-src="image"><b data-i18n="srcImage"></b><span class="muted" data-i18n="srcImageD"></span></button>
      <button class="src-card" data-src="blank"><b data-i18n="srcBlank"></b><span class="muted" data-i18n="srcBlankD"></span></button>
    </div>
    <div id="sizeRow" hidden><label data-i18n="pageSize"></label>
      <select id="ps"><option value="a4-p">A4 portrait</option><option value="a4-l">A4 landscape</option><option value="letter-p">Letter portrait</option><option value="letter-l">Letter landscape</option><option value="fit">${esc(t('fitImage'))}</option></select></div>
    <div class="actions"><button class="btn" id="c" data-i18n="cancel"></button><button class="btn primary" id="go" data-i18n="createTpl"></button></div>`, { wide: true });
  const $m = (s) => m.el.querySelector(s);
  let src = 'pdf';
  bindCategorySelect($m('.cat-select'));
  m.el.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => {
    src = b.dataset.src;
    m.el.querySelectorAll('[data-src]').forEach((x) => x.classList.toggle('on', x === b));
    $m('#sizeRow').hidden = src === 'pdf';
    $m('#ps option[value=fit]').hidden = src !== 'image';
    if (src === 'blank' && $m('#ps').value === 'fit') $m('#ps').value = 'a4-p';
  }));
  $m('#c').onclick = m.close;
  $m('#go').onclick = async () => {
    const category = $m('.cat-select').value;
    let name = $m('#tn').value.trim();
    let bytes, annots = [];
    try {
      if (src === 'pdf') {
        const [f] = await api.pickFiles('application/pdf', false); if (!f) return;
        bytes = new Uint8Array(await f.arrayBuffer());
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        annots = doc.getPages().map(() => []);
        name ||= f.name.replace(/\.pdf$/i, '');
      } else {
        const ps = $m('#ps').value;
        let img = null;
        if (src === 'image') {
          const [f] = await api.pickFiles('image/*', false); if (!f) return;
          img = await imageToDataUrl(f); name ||= f.name.replace(/\.[^.]+$/, '');
        }
        let size;
        if (ps === 'fit' && img) { const k = 841.89 / Math.max(img.w, img.h); size = [img.w * k, img.h * k]; }
        else { const [kind, o] = ps.split('-'); size = [...PAGE_SIZES[kind]]; if (o === 'l') size.reverse(); }
        const doc = await PDFDocument.create(); doc.addPage(size);
        bytes = await doc.save();
        annots = [img ? [{ type: 'img', x: 0, y: 0, w: size[0], h: size[1], src: img.src, opacity: 1, behind: true, ratio: img.h / img.w, free: false }] : []];
        name ||= t('untitledTpl');
      }
    } catch (e) { console.error(e); api.toast('Error: ' + e.message, 4000); return; }
    const tpl = { id: crypto.randomUUID(), name, category, bytes, annots, thumb: null, created: Date.now() };
    await putTemplate(tpl);
    m.close();
    api.openTemplate(tpl, 'edit');
  };
}
