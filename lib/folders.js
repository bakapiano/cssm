'use strict';

// User-curated folders. Sessions reference these by id. Order is
// user-controlled (drag-reorder in sidebar). The store is a flat list
// in $DATA_DIR/folders.json:
//   [{ id, name, order, createdAt }]
//
// Top-level "Unsorted" is implicit — sessions with folderId === null
// render under it. The user can't delete or rename it; we just synthesise
// the bucket in the frontend.

const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./config');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

const FILE = path.join(DATA_DIR, 'folders.json');

async function loadAll() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function saveAll(list) {
  await atomicWriteJson(FILE, list);
}

function genId() {
  return 'folder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function create({ name }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const entry = {
      id: genId(),
      name: name.trim(),
      order: list.length,
      createdAt: Date.now(),
    };
    list.push(entry);
    await saveAll(list);
    return entry;
  });
}

async function update(id, patch) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    // Allow rename + reorder, ignore other keys.
    const allowed = {};
    if (typeof patch.name === 'string') allowed.name = patch.name.trim();
    if (typeof patch.order === 'number') allowed.order = patch.order;
    list[idx] = { ...list[idx], ...allowed };
    await saveAll(list);
    return list[idx];
  });
}

async function remove(id) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    await saveAll(list);
    return true;
  });
}

async function reorder(idsInOrder) {
  if (!Array.isArray(idsInOrder)) throw new Error('idsInOrder must be array');
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const byId = new Map(list.map((f) => [f.id, f]));
    const next = [];
    idsInOrder.forEach((id, i) => {
      const f = byId.get(id);
      if (f) {
        f.order = i;
        next.push(f);
        byId.delete(id);
      }
    });
    // Append any folders not mentioned in the new order, preserving original
    // relative order. Prevents accidentally dropping folders.
    for (const f of byId.values()) {
      f.order = next.length;
      next.push(f);
    }
    await saveAll(next);
    return next;
  });
}

module.exports = { loadAll, create, update, remove, reorder, FILE };
