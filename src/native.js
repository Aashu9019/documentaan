// Desktop (Tauri) integration. Every export is a no-op / null in the browser build.
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let core, dialog, win, event;
async function libs() {
  if (!core) {
    [core, dialog, win, event] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/event'),
    ]);
  }
}
const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];
export const baseName = (p) => p.split(/[\\/]/).pop();

export async function readPath(path) {
  await libs();
  const buf = await core.invoke('read_file', { path });
  return new Uint8Array(buf);
}
export async function nativeOpen() {
  await libs();
  const path = await dialog.open({ multiple: false, filters: PDF_FILTER });
  if (!path) return null;
  return { path, name: baseName(path), bytes: await readPath(path) };
}
export async function nativeSave(bytes, path, suggestedName) {
  await libs();
  if (!path) {
    path = await dialog.save({ defaultPath: suggestedName, filters: PDF_FILTER });
    if (!path) return null;
    if (!/\.pdf$/i.test(path)) path += '.pdf';
  }
  await core.invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
  return path;
}
export async function setTitle(text) {
  if (!isDesktop) return;
  await libs();
  await win.getCurrentWindow().setTitle(text);
}
/** Calls onOpen(path) for the PDF the app was launched with and for later double-clicked PDFs. */
export async function onExternalOpen(onOpen) {
  if (!isDesktop) return;
  await libs();
  await event.listen('open-file', (e) => onOpen(e.payload));
  const first = await core.invoke('initial_file');
  if (first) onOpen(first);
}
/** Ask before closing the window with unsaved changes. confirmFn resolves true to close anyway. */
export async function guardClose(isDirty, confirmFn) {
  if (!isDesktop) return;
  await libs();
  await win.getCurrentWindow().onCloseRequested(async (e) => {
    if (isDirty() && !(await confirmFn())) e.preventDefault();
  });
}

/** Wire the custom title bar buttons (the native frame is hidden in the desktop app). */
export async function bindWindowControls() {
  if (!isDesktop) return;
  document.body.classList.add('desktop');
  document.getElementById('winCtrls').hidden = false;
  await libs();
  const w = win.getCurrentWindow();
  const sync = async () => document.body.classList.toggle('maximized', await w.isMaximized());
  document.getElementById('wMin').onclick = () => w.minimize();
  document.getElementById('wMax').onclick = () => w.toggleMaximize();
  document.getElementById('wClose').onclick = () => w.close();
  await w.onResized(sync);
  sync();
}
