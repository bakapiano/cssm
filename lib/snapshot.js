'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { listSessions } = require('./sessions');
const { launchResume } = require('./launcher');
const { DATA_DIR } = require('./config');

const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');
const SNAPSHOT_HISTORY_DIR = path.join(DATA_DIR, 'snapshots');

function ensureDirs() {
  for (const d of [DATA_DIR, SNAPSHOT_HISTORY_DIR]) {
    if (!fsSync.existsSync(d)) fsSync.mkdirSync(d, { recursive: true });
  }
}

function snapshotFromSessions(sessions) {
  return {
    takenAt: Date.now(),
    sessions: sessions.map((s) => ({
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title || null,
      status: s.status,
      updatedAt: s.updatedAt,
    })),
  };
}

function tsLabel(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

async function rotateHistory(keep) {
  if (!keep || keep < 1) return;
  try {
    const files = (await fs.readdir(SNAPSHOT_HISTORY_DIR))
      .filter((f) => f.endsWith('.json'))
      .sort();
    const excess = files.length - keep;
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(SNAPSHOT_HISTORY_DIR, files[i])).catch(() => {});
    }
  } catch {}
}

async function saveSnapshot({ keep = 30 } = {}) {
  ensureDirs();
  const sessions = await listSessions();
  const snap = snapshotFromSessions(sessions);
  const payload = JSON.stringify(snap, null, 2);
  await fs.writeFile(SNAPSHOT_PATH, payload);
  const histPath = path.join(SNAPSHOT_HISTORY_DIR, `${tsLabel(snap.takenAt)}.json`);
  await fs.writeFile(histPath, payload);
  await rotateHistory(keep);
  return snap;
}

async function loadLatestSnapshot() {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function listSnapshotHistory() {
  ensureDirs();
  try {
    const files = (await fs.readdir(SNAPSHOT_HISTORY_DIR))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    return files.map((f) => ({
      file: f,
      path: path.join(SNAPSHOT_HISTORY_DIR, f),
    }));
  } catch {
    return [];
  }
}

async function loadSnapshotByFile(file) {
  const safe = path.basename(file);
  const p = path.join(SNAPSHOT_HISTORY_DIR, safe);
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

function restoreSnapshot(snap, { terminal = 'wt', claudeCommand = 'claude', commandShell = 'pwsh' } = {}) {
  if (!snap || !Array.isArray(snap.sessions)) {
    return { launched: [], skipped: [] };
  }
  const launched = [];
  const skipped = [];
  for (const s of snap.sessions) {
    if (!s.sessionId || !s.cwd) {
      skipped.push({ ...s, reason: 'missing sessionId or cwd' });
      continue;
    }
    try {
      const { pid, args } = launchResume({
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: (s.title || s.sessionId.slice(0, 8)),
        terminal,
        claudeCommand,
        commandShell,
      });
      launched.push({ sessionId: s.sessionId, cwd: s.cwd, wtPid: pid, args });
    } catch (e) {
      skipped.push({ ...s, reason: String(e && e.message || e) });
    }
  }
  return { launched, skipped };
}

module.exports = {
  saveSnapshot,
  loadLatestSnapshot,
  listSnapshotHistory,
  loadSnapshotByFile,
  restoreSnapshot,
  SNAPSHOT_PATH,
  SNAPSHOT_HISTORY_DIR,
};
