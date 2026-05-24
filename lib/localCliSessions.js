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

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const SUMMARY_MAX = 120;

async function listClaude() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let slugs;
  try { slugs = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(root, slug.name);
    let files;
    try { files = await fsp.readdir(slugDir, { withFileTypes: true }); }
    catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filepath = path.join(slugDir, f.name);
      const id = f.name.replace(/\.jsonl$/, '');
      let st; try { st = await fsp.stat(filepath); } catch { continue; }
      const { cwd, summary } = await parseClaudeJsonl(filepath);
      if (!cwd) continue;
      out.push({
        cliType: 'claude',
        cliSessionId: id,
        cwd,
        mtime: st.mtimeMs,
        summary,
      });
    }
  }
  return out;
}

async function listCodex() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  await walkFiles(root, async (filepath) => {
    if (!filepath.endsWith('.jsonl')) return;
    const base = path.basename(filepath);
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (!m) return;
    let st; try { st = await fsp.stat(filepath); } catch { return; }
    const { cwd, summary } = await parseClaudeJsonl(filepath); // same shape
    if (!cwd) return;
    out.push({
      cliType: 'codex',
      cliSessionId: m[1],
      cwd,
      mtime: st.mtimeMs,
      summary,
    });
  });
  return out;
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
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) await walkFiles(p, visit);
    else await visit(p);
  }
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Returns { cwd, summary } from the first ~30 lines of a claude/codex
// jsonl. Looks for the first object with a `cwd` field, plus the first
// user message text content for a 1-line preview.
async function parseClaudeJsonl(filepath) {
  return new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(filepath, { encoding: 'utf8' }); }
    catch { resolve({ cwd: null, summary: '' }); return; }
    const rl = readline.createInterface({ input: stream });
    let count = 0;
    let cwd = null;
    let summary = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      resolve({ cwd, summary });
    };
    rl.on('line', (line) => {
      count++;
      try {
        const obj = JSON.parse(line);
        if (!cwd && obj && obj.cwd) cwd = obj.cwd;
        if (!summary && obj) {
          // First user text wins.
          if (obj.type === 'user' && obj.message?.content) {
            const c = obj.message.content;
            if (typeof c === 'string') summary = truncate(c, SUMMARY_MAX);
          }
        }
      } catch {}
      if (count >= 30 || (cwd && summary)) done();
    });
    rl.on('close', done);
    rl.on('error', done);
  });
}
