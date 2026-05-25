'use strict';

// Discover existing CLI sessions on this machine and surface them so
// ccsm can "adopt" them — i.e. create a persistedSessions record that
// resumes the same upstream conversation later.
//
// Per CLI:
//   claude  · ~/.claude/projects/<slug>/<uuid>.jsonl   (uuid = id)
//   codex   · ~/.codex/sessions/**/<uuid>.jsonl        (uuid = id)
//   copilot · ~/.copilot/session-state/<uuid>/         (uuid = dir name;
//              cwd + summary in workspace.yaml)
//
// Each session is reported as:
//   { cliType, cliSessionId, cwd, mtime, summary }
//
// Heuristic for `summary`: the first user message text (claude/codex)
// or the YAML `summary:` line (copilot). Truncated to 120 chars.
//
// Performance:
//   - We read each jsonl's HEAD (first 16KB) directly via fd.read instead
//     of going through readline+stream — readline init is the dominant
//     cost when scanning hundreds of small files.
//   - Files are parsed in parallel with a small concurrency cap (16) so
//     the OS scheduler stays useful but we don't fire 300+ syscalls at
//     once.
//   - An in-process LRU caches parse results keyed by (filepath, mtime).
//     Unchanged files on subsequent scans are O(1).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SUMMARY_MAX = 120;
const HEAD_BYTES = 16 * 1024;       // enough to catch cwd + first user msg
const CONCURRENCY = 16;             // parallel parses per scan
const PARSE_CACHE_MAX = 5000;
const parseCache = new Map();       // `${path}|${mtimeMs}` → { cwd, summary }

function cacheGet(filepath, mtimeMs) {
  return parseCache.get(`${filepath}|${mtimeMs}`);
}
function cachePut(filepath, mtimeMs, value) {
  if (parseCache.size >= PARSE_CACHE_MAX) {
    // Drop oldest insertion (Map keeps insertion order).
    const firstKey = parseCache.keys().next().value;
    parseCache.delete(firstKey);
  }
  parseCache.set(`${filepath}|${mtimeMs}`, value);
}

// Run `tasks` with a max concurrency cap. Each task is a `() => Promise`.
async function pmap(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function listClaude() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let slugs;
  try { slugs = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }

  // Collect all jsonl candidates first (stat in parallel), THEN parse in
  // parallel — old code interleaved stat + parse sequentially.
  const statTasks = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(root, slug.name);
    statTasks.push(async () => {
      let files;
      try { files = await fsp.readdir(slugDir, { withFileTypes: true }); }
      catch { return []; }
      const inDir = [];
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filepath = path.join(slugDir, f.name);
        let st; try { st = await fsp.stat(filepath); } catch { continue; }
        inDir.push({
          id: f.name.replace(/\.jsonl$/, ''),
          filepath,
          mtimeMs: st.mtimeMs,
        });
      }
      return inDir;
    });
  }
  const grouped = await pmap(statTasks, CONCURRENCY);
  const candidates = grouped.flat().filter(Boolean);

  const parseTasks = candidates.map((c) => async () => {
    const { cwd, summary } = await parseJsonlHead(c.filepath, c.mtimeMs);
    if (!cwd) return null;
    return {
      cliType: 'claude',
      cliSessionId: c.id,
      cwd,
      mtime: c.mtimeMs,
      summary,
    };
  });
  const parsed = await pmap(parseTasks, CONCURRENCY);
  return parsed.filter(Boolean);
}

async function listCodex() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const candidates = [];
  await walkFiles(root, async (filepath, st) => {
    if (!filepath.endsWith('.jsonl')) return;
    const base = path.basename(filepath);
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (!m) return;
    candidates.push({ id: m[1], filepath, mtimeMs: st.mtimeMs });
  });
  const parseTasks = candidates.map((c) => async () => {
    const { cwd, summary } = await parseJsonlHead(c.filepath, c.mtimeMs);
    if (!cwd) return null;
    return {
      cliType: 'codex',
      cliSessionId: c.id,
      cwd,
      mtime: c.mtimeMs,
      summary,
    };
  });
  const parsed = await pmap(parseTasks, CONCURRENCY);
  return parsed.filter(Boolean);
}

async function listCopilot() {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const id = d.name;
    if (!/^[0-9a-f-]+$/i.test(id)) continue;
    const dirpath = path.join(root, id);
    let st; try { st = await fsp.stat(dirpath); } catch { continue; }
    const yaml = path.join(dirpath, 'workspace.yaml');
    let txt;
    try { txt = await fsp.readFile(yaml, 'utf8'); }
    catch { continue; }
    const cwd = (txt.match(/^\s*cwd\s*:\s*(.+?)\s*$/m) || [])[1] || null;
    const summary = (txt.match(/^\s*summary\s*:\s*(.+?)\s*$/m) || [])[1] || '';
    const updated = (txt.match(/^\s*updated_at\s*:\s*(.+?)\s*$/m) || [])[1];
    if (!cwd) continue;
    out.push({
      cliType: 'copilot',
      cliSessionId: id,
      cwd: cwd.trim(),
      mtime: updated ? Date.parse(updated) || st.mtimeMs : st.mtimeMs,
      summary: truncate(summary, SUMMARY_MAX),
    });
  }
  return out;
}

async function listForType(cliType) {
  if (cliType === 'claude')  return listClaude();
  if (cliType === 'codex')   return listCodex();
  if (cliType === 'copilot') return listCopilot();
  return [];
}

module.exports = { listForType, listClaude, listCodex, listCopilot };

// ── helpers ─────────────────────────────────────────────────────────

async function walkFiles(root, visit) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return; }
  const tasks = entries.map((e) => async () => {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(p, visit);
    } else {
      let st; try { st = await fsp.stat(p); } catch { return; }
      await visit(p, st);
    }
  });
  await pmap(tasks, CONCURRENCY);
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Returns { cwd, summary } from a claude/codex jsonl by reading just the
// first 16KB directly. Way faster than readline+stream when scanning
// hundreds of files. Cached by (filepath, mtimeMs) so a repeat scan of
// unchanged files is O(1).
//
// cwd lives in the head of every jsonl (it's part of the per-message
// envelope), so 16KB is more than enough. First user text usually too;
// if it's beyond the head we just don't preview, that's fine.
async function parseJsonlHead(filepath, mtimeMs) {
  const cached = cacheGet(filepath, mtimeMs);
  if (cached) return cached;

  let fh;
  try { fh = await fsp.open(filepath, 'r'); }
  catch { return { cwd: null, summary: '' }; }
  const buf = Buffer.allocUnsafe(HEAD_BYTES);
  let bytesRead = 0;
  try {
    const r = await fh.read(buf, 0, HEAD_BYTES, 0);
    bytesRead = r.bytesRead || 0;
  } catch {
    /* leave bytesRead = 0 */
  } finally {
    try { await fh.close(); } catch {}
  }
  if (bytesRead === 0) {
    const v = { cwd: null, summary: '' };
    cachePut(filepath, mtimeMs, v);
    return v;
  }

  const text = buf.slice(0, bytesRead).toString('utf8');
  // Drop the trailing partial line — JSON.parse on it will fail anyway.
  const lines = text.split('\n');
  if (bytesRead === HEAD_BYTES) lines.pop();

  let cwd = null;
  let summary = '';
  for (const line of lines) {
    if (cwd && summary) break;
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!cwd && obj && obj.cwd) cwd = obj.cwd;
    if (!summary && obj && obj.type === 'user' && obj.message?.content) {
      const c = obj.message.content;
      if (typeof c === 'string') summary = truncate(c, SUMMARY_MAX);
    }
  }
  const v = { cwd, summary };
  cachePut(filepath, mtimeMs, v);
  return v;
}
