'use strict';

// Detect whether each running CLI session is "working" (actively writing
// to its transcript) or "idle" (waiting on user input). We poll the
// transcript file's mtime on each /api/sessions request: if it moved
// since the previous probe, the CLI is writing → working. If it hasn't
// moved within WORKING_WINDOW_MS, idle.
//
// Transcript paths per CLI:
//   claude  → ~/.claude/projects/<slug>/<cliSessionId>.jsonl
//   codex   → <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl
//   copilot → ~/.copilot/session-state/<cliSessionId>/
//
// Resolution is cached forever per ccsm session id — once we've found
// the file, subsequent probes are a single fs.stat().

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// 8s window is comfortably above the 5s frontend poll cadence — if a CLI
// wrote anything within the last 8s we still call it working when the
// next refresh lands.
const WORKING_WINDOW_MS = 8000;

// sessionId → { resolvedPath, lastMtimeMs, lastChangedAt }
const state = new Map();

async function fileExists(p) {
  try { await fs.access(p); return true; }
  catch { return false; }
}

async function resolveClaude(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = await fs.readdir(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${id}.jsonl`);
    if (await fileExists(p)) return p;
  }
  return null;
}

async function resolveCodex(id, cliCfg) {
  let home = null;
  try {
    const { probeCodexHome } = require('./codexSeed');
    home = await probeCodexHome({ command: cliCfg.command, shell: cliCfg.shell });
  } catch { /* probe is best-effort */ }
  if (!home) home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.join(home, 'sessions');
  const suffix = `-${id}.jsonl`;
  async function walk(dir, depth) {
    if (depth > 4) return null;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = await walk(p, depth + 1);
        if (r) return r;
      } else if (e.isFile() && e.name.endsWith(suffix)) {
        return p;
      }
    }
    return null;
  }
  return walk(root, 0);
}

async function resolveCopilot(id) {
  const p = path.join(os.homedir(), '.copilot', 'session-state', id);
  if (await fileExists(p)) return p;
  return null;
}

async function resolveTranscript(record, cliCfg) {
  if (!record.cliSessionId || !cliCfg) return null;
  switch (cliCfg.type) {
    case 'claude':  return resolveClaude(record.cliSessionId);
    case 'codex':   return resolveCodex(record.cliSessionId, cliCfg);
    case 'copilot': return resolveCopilot(record.cliSessionId);
    default: return null;
  }
}

// Returns 'working' | 'idle' | 'unknown' for a single record.
async function probeActivity(record, cliCfg) {
  let s = state.get(record.id);
  if (!s) {
    s = { resolvedPath: null, lastMtimeMs: 0, lastChangedAt: 0 };
    state.set(record.id, s);
  }
  if (!s.resolvedPath) {
    s.resolvedPath = await resolveTranscript(record, cliCfg);
    if (!s.resolvedPath) return 'unknown';
  }
  let mtimeMs;
  try { mtimeMs = (await fs.stat(s.resolvedPath)).mtimeMs; }
  catch {
    // File disappeared (rollover, manual delete) — drop the cache so we
    // re-resolve on the next probe.
    s.resolvedPath = null;
    return 'unknown';
  }
  const now = Date.now();
  if (mtimeMs !== s.lastMtimeMs) {
    s.lastMtimeMs = mtimeMs;
    s.lastChangedAt = now;
  }
  return (now - s.lastChangedAt) < WORKING_WINDOW_MS ? 'working' : 'idle';
}

function releaseSession(sessionId) { state.delete(sessionId); }

module.exports = { probeActivity, releaseSession };
