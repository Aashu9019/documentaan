// Installed fonts (Times New Roman, Arial, Calibri...) for added and edited text.
// The desktop app reads font files from the Windows font folders; the browser
// version uses the Local Font Access API when the browser allows it. Fonts are
// embedded (subset) into the saved PDF so it looks the same everywhere.
import { isDesktop } from './native.js';

// Common Windows and Office fonts: family -> [regular, bold, italic, bold italic] file names.
const CATALOG = {
  'Arial': ['arial', 'arialbd', 'ariali', 'arialbi'],
  'Arial Narrow': ['arialn', 'arialnb', 'arialni', 'arialnbi'],
  'Arial Black': ['ariblk'],
  'Book Antiqua': ['bkant', 'antquab', 'antquai', 'antquabi'],
  'Bookman Old Style': ['bookos', 'bookosb', 'bookosi', 'bookosbi'],
  'Calibri': ['calibri', 'calibrib', 'calibrii', 'calibriz'],
  'Calibri Light': ['calibril', null, 'calibrili'],
  'Cambria': [null, 'cambriab', 'cambriai', 'cambriaz'],
  'Candara': ['candara', 'candarab', 'candarai', 'candaraz'],
  'Century Gothic': ['gothic', 'gothicb', 'gothici', 'gothicbi'],
  'Century Schoolbook': ['schlbk', 'schlbkb', 'schlbki', 'schlbkbi'],
  'Comic Sans MS': ['comic', 'comicbd', 'comici', 'comicz'],
  'Consolas': ['consola', 'consolab', 'consolai', 'consolaz'],
  'Constantia': ['constan', 'constanb', 'constani', 'constanz'],
  'Corbel': ['corbel', 'corbelb', 'corbeli', 'corbelz'],
  'Courier New': ['cour', 'courbd', 'couri', 'courbi'],
  'Franklin Gothic Medium': ['framd', null, 'framdit'],
  'Garamond': ['gara', 'garabd', 'garait'],
  'Georgia': ['georgia', 'georgiab', 'georgiai', 'georgiaz'],
  'Impact': ['impact'],
  'Lucida Console': ['lucon'],
  'Mangal': ['mangal', 'mangalb'],
  'Palatino Linotype': ['pala', 'palab', 'palai', 'palabi'],
  'Segoe Print': ['segoepr', 'segoeprb'],
  'Segoe Script': ['segoesc', 'segoescb'],
  'Segoe UI': ['segoeui', 'segoeuib', 'segoeuii', 'segoeuiz'],
  'Sylfaen': ['sylfaen'],
  'Tahoma': ['tahoma', 'tahomabd'],
  'Times New Roman': ['times', 'timesbd', 'timesi', 'timesbi'],
  'Trebuchet MS': ['trebuc', 'trebucbd', 'trebucit', 'trebucbi'],
  'Verdana': ['verdana', 'verdanab', 'verdanai', 'verdanaz'],
};

let families = null;      // Map family -> [loader r, b, i, bi] (loader: () => Promise<Uint8Array>)
const bytesCache = new Map();

async function loadDesktop() {
  const { invoke } = await import('@tauri-apps/api/core');
  const paths = await invoke('list_fonts');
  const byFile = new Map(paths.map((p) => [p.split(/[\\/]/).pop().toLowerCase().replace(/\.(ttf|otf)$/, ''), p]));
  const map = new Map();
  for (const [fam, files] of Object.entries(CATALOG)) {
    const loaders = files.map((f) => (f && byFile.has(f) ? async () => new Uint8Array(await invoke('read_file', { path: byFile.get(f) })) : null));
    if (loaders.some(Boolean)) map.set(fam, loaders);
  }
  return map;
}

async function loadBrowser() {
  const map = new Map();
  if (!window.queryLocalFonts) return map;
  let list = [];
  try { list = await window.queryLocalFonts(); } catch { return map; }
  const slot = (style) => { const s = style.toLowerCase(); const b = /bold|black|heavy|semibold/.test(s), i = /italic|oblique/.test(s); return (b ? 1 : 0) + (i ? 2 : 0); };
  for (const f of list) {
    if (!/^(regular|bold|italic|bold italic|normal|oblique|bold oblique)$/i.test(f.style)) continue;
    if (!map.has(f.family)) map.set(f.family, [null, null, null, null]);
    const arr = map.get(f.family), k = slot(f.style);
    if (!arr[k]) arr[k] = async () => new Uint8Array(await (await f.blob()).arrayBuffer());
  }
  // Keep the list tidy: only families with an upright style.
  for (const [k, v] of map) if (!v[0] && !v[1]) map.delete(k);
  return map;
}

/** Sorted list of installed font family names. */
export async function installedFonts() {
  if (!families) {
    try { families = isDesktop ? await loadDesktop() : await loadBrowser(); } catch (e) { console.warn('font list failed', e); families = new Map(); }
  }
  return [...families.keys()].sort((a, b) => a.localeCompare(b));
}

/** Font file bytes for a family and style, falling back to the closest style available. */
export async function fontBytes(family, bold, italic) {
  await installedFonts();
  const l = families.get(family); if (!l) return null;
  const want = (bold ? 1 : 0) + (italic ? 2 : 0);
  const order = [want, want & 1, want & 2, 0, 1, 2, 3];
  for (const k of order) {
    if (!l[k]) continue;
    const key = `${family}|${k}`;
    if (!bytesCache.has(key)) bytesCache.set(key, l[k]().catch(() => null));
    const b = await bytesCache.get(key);
    if (b) return b;
  }
  return null;
}

const norm = (s) => s.toLowerCase().replace(/^[a-z]{6}\+/, '').replace(/[-,](bold|italic|oblique|regular|bolditalic|boldoblique|semibold|light).*$/, '')
  .replace(/(psmt|mt|ps)$/, '').replace(/[^a-z0-9]/g, '');

/** Match an embedded PDF font name (e.g. "ABCDEF+TimesNewRomanPSMT") to an installed family. */
export async function matchInstalled(realName) {
  if (!realName) return null;
  const n = norm(realName);
  if (!n) return null;
  for (const fam of await installedFonts()) if (norm(fam) === n) return fam;
  return null;
}

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];
