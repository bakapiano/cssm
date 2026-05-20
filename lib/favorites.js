'use strict';

// User-pinned ("favorited") sessions. Stored as a JSON object keyed by
// sessionId at $DATA_DIR/favorites.json. Each entry captures enough
// metadata (cwd, title, gitBranch) to render the row even after the
// session's jsonl is gone — the entry is best-effort archival.

const fs = require('node:fs/promises');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const FAVORITES_PATH = path.join(DATA_DIR, 'favorites.json');

async function loadFavorites() {
  try {
    const raw = await fs.readFile(FAVORITES_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function saveFavorites(favs) {
  await fs.writeFile(FAVORITES_PATH, JSON.stringify(favs, null, 2));
}

async function listFavorites() {
  const favs = await loadFavorites();
  return Object.values(favs).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

async function addFavorite(sessionId, info = {}) {
  if (!sessionId) throw new Error('addFavorite: sessionId required');
  const favs = await loadFavorites();
  const existing = favs[sessionId];
  favs[sessionId] = existing
    ? { ...existing, ...info, sessionId }
    : {
        sessionId,
        cwd: info.cwd || null,
        title: info.title || null,
        gitBranch: info.gitBranch || null,
        label: info.label || null,
        addedAt: Date.now(),
      };
  await saveFavorites(favs);
  return favs[sessionId];
}

async function removeFavorite(sessionId) {
  const favs = await loadFavorites();
  if (!(sessionId in favs)) return false;
  delete favs[sessionId];
  await saveFavorites(favs);
  return true;
}

async function hasFavorite(sessionId) {
  const favs = await loadFavorites();
  return sessionId in favs;
}

module.exports = {
  loadFavorites,
  saveFavorites,
  listFavorites,
  addFavorite,
  removeFavorite,
  hasFavorite,
  FAVORITES_PATH,
};
