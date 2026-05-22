'use strict';

// User-defined display titles for sessions, keyed by sessionId at
// $DATA_DIR/labels.json. Frontend overlays the label on top of the
// AI-generated title when rendering live / recent / favorites.

const path = require('node:path');
const { DATA_DIR } = require('./config');
const { createKeyedJsonStore } = require('./jsonStore');

const MAX_LEN = 200;

const store = createKeyedJsonStore({
  dataDir: DATA_DIR,
  filename: 'labels.json',
  // Empty / null label triggers a remove via the factory contract.
  transformValue: (v) => {
    const trimmed = String(v || '').trim().slice(0, MAX_LEN);
    return trimmed || null;
  },
});

module.exports = {
  loadLabels: store.load,
  saveLabels: store.save,
  setLabel: store.set,
  removeLabel: store.remove,
  LABELS_PATH: store.filePath,
};
