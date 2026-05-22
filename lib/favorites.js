'use strict';

// User-pinned ("favorited") sessions, keyed by sessionId at
// $DATA_DIR/favorites.json. Each entry captures enough metadata
// (cwd, title, gitBranch) to render the row even after the session's
// jsonl is gone — entries are best-effort archival.

const { DATA_DIR } = require('./config');
const { createKeyedJsonStore } = require('./jsonStore');

const store = createKeyedJsonStore({
  dataDir: DATA_DIR,
  filename: 'favorites.json',
});

async function addFavorite(sessionId, info = {}) {
  if (!sessionId) throw new Error('addFavorite: sessionId required');
  const map = await store.load();
  const existing = map[sessionId];
  const next = existing
    ? { ...existing, ...info, sessionId }
    : {
        sessionId,
        cwd: info.cwd || null,
        title: info.title || null,
        gitBranch: info.gitBranch || null,
        label: info.label || null,
        addedAt: Date.now(),
      };
  return store.set(sessionId, next);
}

async function hasFavorite(sessionId) {
  const map = await store.load();
  return sessionId in map;
}

async function listFavorites() {
  const list = await store.list();
  return list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

module.exports = {
  loadFavorites: store.load,
  saveFavorites: store.save,
  listFavorites,
  addFavorite,
  removeFavorite: store.remove,
  hasFavorite,
  FAVORITES_PATH: store.filePath,
};
