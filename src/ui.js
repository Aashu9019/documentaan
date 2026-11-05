// In-app dialogs and toasts. Replaces browser alert/confirm/prompt, which the
// desktop webview does not support and which look out of place anyway.
import { t, applyI18n } from './i18n.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove('out');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => (el.hidden = true), 180);
  }, ms);
}

export function modal(title, html, { wide, onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"${wide ? ' style="width:min(760px,100%)"' : ''}>
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn modal-x" aria-label="Close">
    <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
    ${html}</div>`;
  document.getElementById('modalRoot').appendChild(bg);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bg.classList.add('closing');
    setTimeout(() => bg.remove(), 160);
    onClose?.();
  };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  bg.querySelector('.modal-x').onclick = close;
  applyI18n(bg);
  requestAnimationFrame(() => bg.querySelector('input:not([type=hidden]),textarea,button.primary')?.focus());
  return { el: bg.firstElementChild, close };
}

/** Yes/no question. Resolves true or false. */
export function ask(message, { title = 'Documentaan', ok = t('ok'), cancel = t('cancel'), danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal(title, `<p class="ask-msg">${esc(message)}</p>
      <div class="actions"><button class="btn" data-r="0">${esc(cancel)}</button>
      <button class="btn primary${danger ? ' danger' : ''}" data-r="1">${esc(ok)}</button></div>`, { onClose: () => resolve(result) });
    m.el.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => { result = b.dataset.r === '1'; m.close(); }));
  });
}

/** Text input. Resolves the string, or null when cancelled. */
export function promptText(title, { value = '', label = '', password = false, multiline = false, ok = t('ok') } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const field = multiline
      ? `<textarea id="pv" rows="5">${esc(value)}</textarea>`
      : `<input id="pv" type="${password ? 'password' : 'text'}" value="${esc(value)}" autocomplete="off">`;
    const m = modal(title, `${label ? `<label>${esc(label)}</label>` : ''}${field}
      <div class="actions"><button class="btn" data-r="0">${esc(t('cancel'))}</button>
      <button class="btn primary" data-r="1">${esc(ok)}</button></div>`, { onClose: () => resolve(result) });
    const inp = m.el.querySelector('#pv');
    const submit = () => { result = inp.value; m.close(); };
    m.el.querySelector('[data-r="1"]').onclick = submit;
    m.el.querySelector('[data-r="0"]').onclick = m.close;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    requestAnimationFrame(() => { inp.focus(); inp.select?.(); });
  });
}
