import { useEffect, useRef, useState } from 'react';

// Backed by Web Storage: survives reloads, and can sync across browser tabs or stay scoped to the current tab.
export default function usePersisted(key, initial, options = {}) {
  const {
    storage = 'local',
    syncTabs = storage === 'local',
    debounce = storage === 'session' ? 0 : 200,
  } = typeof options === 'string' ? { storage: options } : options;

  const storageKey = `forgeai.${key}`;

  const getStore = () => {
    try {
      if (typeof window === 'undefined') return null;
      return storage === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
      return null;
    }
  };

  const [value, setValue] = useState(() => {
    try {
      const store = getStore();
      const saved = store ? store.getItem(storageKey) : null;
      return saved === null ? initial : JSON.parse(saved);
    } catch {
      return initial;
    }
  });

  const latest = useRef(value);
  latest.current = value;
  const pending = useRef(false); // a debounced write hasn't landed yet
  const fromOtherTab = useRef(false); // value came in via the storage event: it's already stored, don't echo it back

  const write = (v) => {
    pending.current = false;
    try {
      const store = getStore();
      if (store) store.setItem(storageKey, JSON.stringify(v));
    } catch {
      // storage full or blocked: keep working in memory
    }
  };

  useEffect(() => {
    if (fromOtherTab.current) {
      fromOtherTab.current = false;
      return undefined;
    }
    if (debounce <= 0) {
      write(value);
      return undefined;
    }
    pending.current = true;
    const timer = setTimeout(() => write(value), debounce);
    return () => clearTimeout(timer);
  }, [storageKey, value, storage, debounce]);

  // Flush a write still inside the debounce window on reload/close and on unmount (channel switch remounts tabs).
  useEffect(() => {
    const flush = () => pending.current && write(latest.current);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [storageKey]);

  // Another tab changed it (the storage event only fires in other tabs for localStorage).
  useEffect(() => {
    if (!syncTabs || storage !== 'local') return;

    const onStorage = (e) => {
      if (e.key !== storageKey || e.newValue === null) return;
      if (e.newValue === JSON.stringify(latest.current)) return;
      try {
        const next = JSON.parse(e.newValue);
        fromOtherTab.current = true;
        setValue(next);
      } catch {
        // ignore malformed values
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, syncTabs, storage]);

  return [value, setValue];
}
