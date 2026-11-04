// Unlimited signature storage in IndexedDB (stays on this computer).
const DB = 'documentaan', STORE = 'signatures';

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const s = d.transaction(STORE, mode).objectStore(STORE);
    const r = fn(s);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export const listSignatures = async () =>
  (await tx('readonly', (s) => s.getAll())).sort((a, b) => b.created - a.created);
export const saveSignature = (sig) =>
  tx('readwrite', (s) => s.put({ id: crypto.randomUUID(), created: Date.now(), ...sig }));
export const deleteSignature = (id) => tx('readwrite', (s) => s.delete(id));
export const renameSignature = async (id, name) => {
  const all = await listSignatures();
  const sig = all.find((x) => x.id === id);
  if (sig) await tx('readwrite', (s) => s.put({ ...sig, name }));
};
