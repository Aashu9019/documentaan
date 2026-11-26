// Local storage in IndexedDB (stays on this computer): unlimited signatures and templates.
const DB = 'documentaan', VERSION = 2;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('signatures')) d.createObjectStore('signatures', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('templates')) d.createObjectStore('templates', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const s = d.transaction(store, mode).objectStore(store);
    const r = fn(s);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// ---- signatures
export const listSignatures = async () =>
  (await tx('signatures', 'readonly', (s) => s.getAll())).sort((a, b) => b.created - a.created);
export const saveSignature = (sig) =>
  tx('signatures', 'readwrite', (s) => s.put({ id: crypto.randomUUID(), created: Date.now(), ...sig }));
export const deleteSignature = (id) => tx('signatures', 'readwrite', (s) => s.delete(id));

// ---- templates: { id, name, category, bytes, annots, thumb, created, updated }
export const listTemplates = async () =>
  (await tx('templates', 'readonly', (s) => s.getAll())).sort((a, b) => (b.updated || 0) - (a.updated || 0));
export const getTemplate = (id) => tx('templates', 'readonly', (s) => s.get(id));
export const putTemplate = (tpl) => tx('templates', 'readwrite', (s) => s.put({ ...tpl, updated: Date.now() }));
export const deleteTemplate = (id) => tx('templates', 'readwrite', (s) => s.delete(id));
