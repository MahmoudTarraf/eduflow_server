// Simple in-memory cache with TTL
// Usage:
// const cache = require('./cache');
// cache.set(key, data, ttlMs)
// const data = cache.get(key)

const store = new Map();

function set(key, value, ttlMs = 5 * 60 * 1000) {
  const expiresAt = Date.now() + Math.max(0, ttlMs);
  store.set(key, { value, expiresAt });
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function del(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

module.exports = { set, get, del, clear };
