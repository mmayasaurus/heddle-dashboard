// Global Vitest setup for the jsdom environment.
//
// Node 22+ provides an experimental global `localStorage`. Without `--localstorage-file`, it exists but is
// unusable (access returns undefined) and **masks** jsdom's `window.localStorage`. Any module that reads bare
// `localStorage` during initialization, such as loadTheme in theme.ts, then fails as soon as a jsdom test loads
// it. This is an environment discrepancy unrelated to the code under test. Reconnect jsdom's
// window.localStorage to the global here, falling back to an in-memory implementation if it is also absent
// from window. This applies only in tests and does not affect the real app.
const memory = new Map<string, string>();
const memoryStorage: Storage = {
  getItem: (k) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k, v) => void memory.set(k, String(v)),
  removeItem: (k) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i) => Array.from(memory.keys())[i] ?? null,
  get length() {
    return memory.size;
  },
};

const win = (globalThis as { window?: { localStorage?: Storage } }).window;
const storage: Storage = win?.localStorage ?? memoryStorage;
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
  writable: true,
});
