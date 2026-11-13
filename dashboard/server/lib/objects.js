import fs from 'node:fs';

// Shared plain-object helpers. Used by routes/ modules that previously each carried a copy.

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export const escapeXml = (s = '') => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Recursive freeze; already-frozen values are left alone.
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Recursive sorted-key copy for hashing. Throws on a true cycle; shared (non-cyclic) references are fine.
export function canonicalJson(value, path = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (path.has(value)) throw new Error('Circular reference detected');
  path.add(value);
  const out = Array.isArray(value)
    ? value.map((item) => canonicalJson(item, path))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key], path)]));
  path.delete(value);
  return out;
}
