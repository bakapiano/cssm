'use strict';

// User-defined display titles for sessions. Stored as a flat JSON object
// keyed by sessionId at $DATA_DIR/labels.json. Frontend overlays the label
// on top of the AI-generated title when rendering live / recent / favorites.

const fs = require('node:fs/promises');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const LABELS_PATH = path.join(DATA_DIR, 'labels.json');
const MAX_LEN = 200;

async function loadLabels() {
  try {
    const raw = await fs.readFile(LABELS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function saveLabels(labels) {
  await fs.writeFile(LABELS_PATH, JSON.stringify(labels, null, 2));
}

async function setLabel(sessionId, label) {
  if (!sessionId) throw new Error('setLabel: sessionId required');
  const trimmed = String(label || '').trim().slice(0, MAX_LEN);
  if (!trimmed) {
    return removeLabel(sessionId);
  }
  const labels = await loadLabels();
  labels[sessionId] = trimmed;
  await saveLabels(labels);
  return trimmed;
}

async function removeLabel(sessionId) {
  const labels = await loadLabels();
  if (!(sessionId in labels)) return false;
  delete labels[sessionId];
  await saveLabels(labels);
  return true;
}

module.exports = { loadLabels, saveLabels, setLabel, removeLabel, LABELS_PATH };
