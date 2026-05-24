'use strict';

// Captures the upstream CLI's session id (claude / codex / copilot) so
// ccsm can later spawn `<cli> --resume <uuid>` and reattach to the same
// conversation precisely.
//
// Approach (poll-based, deliberately):
// - fs.watch is unreliable on Windows for in-place content writes.
// - CLIs reuse existing transcripts in the same cwd when they can —
//   there's no "new file appears" signal to wait on.
// - Instead we poll the per-CLI transcript dir every POLL_MS, find
//   candidates whose mtime > spawnAt, read each one's cwd field, and
//   if exactly one matches our spawn cwd that's the session id.
// - Window expires after WINDOW_MS — CLIs only persist after the first
//   user message, so this needs to be generous.
//
// Per-CLI profile shape:
//   dirFor(cwd)          → directory to poll
//   entryType            → 'file' (claude/codex) or 'dir' (copilot —
//                          each child dir = one session)
//   recursive            → for 'file' mode only; walk subdirs too
//   filePattern          → regex an entry's basename must match
//   parseId(basename)    → extract the upstream session id from name
//                          (returns null to skip)
//   readCwd(entryPath)   → async; returns the cwd recorded inside the
//                          session, or null if not yet readable.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const POLL_MS = 1_500;
const WINDOW_MS = 5 * 60_000;

const profiles = {
  claude: {
    dirFor: (cwd) => path.join(os.homedir(), '.claude', 'projects', claudeSlug(cwd)),
    entryType: 'file',
    filePattern: /\.jsonl$/i,
    parseId: (filename) => filename.replace(/\.jsonl$/i, ''),
    readCwd: (filepath) => firstJsonField(filepath, 'cwd', 12),
  },
  codex: {
    dirFor: () => path.join(os.homedir(), '.codex', 'sessions'),
    entryType: 'file',
    recursive: true,
    filePattern: /\.jsonl$/i,
    parseId: (filename) => {
      const m = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      return m ? m[1] : null;
    },
    readCwd: (filepath) => firstJsonField(filepath, 'cwd', 12),
  },
  copilot: {
    // ~/.copilot/session-state/<uuid>/  with workspace.yaml + events.jsonl
    // Each session is a directory, not a single file.
    dirFor: () => path.join(os.homedir(), '.copilot', 'session-state'),
    entryType: 'dir',
    // Subdir name is the uuid; tolerate any non-empty name (copilot uses
    // standard uuid4 but we'd rather not be strict).
    parseId: (dirname) => /^[0-9a-f-]+$/i.test(dirname) ? dirname : null,
    readCwd: async (dirpath) => {
      // workspace.yaml has plain `cwd: <path>` on its own line — quick
      // regex parse, no YAML dep.
      const yaml = path.join(dirpath, 'workspace.yaml');
      try {
        const txt = await fsp.readFile(yaml, 'utf8');
        const m = txt.match(/^\s*cwd\s*:\s*(.+?)\s*$/m);
        return m ? m[1].trim() : null;
      } catch {
        return null;
      }
    },
  },
};

function captureSessionId({ cliType, cwd, onCapture, onTimeout, windowMs = WINDOW_MS }) {
  const profile = profiles[cliType];
  if (!profile) return () => {};
  const dir = profile.dirFor(cwd);
  const spawnAt = Date.now();
  console.log(`[cliSessionWatcher] start ${cliType} dir=${dir} cwd=${cwd}`);

  let stopped = false;
  let captured = false;
  let pollTimer = null;
  let expireTimer = null;
  // Track entries we've already proven aren't ours so we don't re-read them.
  // Only used for "wrong cwd recorded inside the file" — that's stable.
  // We do NOT cache mtime-based rejections: a stale file can be re-touched
  // by the CLI later (claude appends to existing transcripts) and we want
  // to re-evaluate it then.
  const rejected = new Set();

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (expireTimer) clearTimeout(expireTimer);
  };

  const finish = (sessionId) => {
    if (stopped) return;
    captured = true;
    cleanup();
    console.log(`[cliSessionWatcher] captured ${cliType} ${sessionId}`);
    try { onCapture?.(sessionId); } catch (e) { console.error('[cliSessionWatcher] onCapture:', e); }
  };

  const onExpire = () => {
    if (stopped || captured) return;
    cleanup();
    console.warn(`[cliSessionWatcher] timeout ${cliType} (no transcript in ${Math.round(windowMs / 1000)}s) cwd=${cwd}`);
    try { onTimeout?.(); } catch (e) { console.error('[cliSessionWatcher] onTimeout:', e); }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const entries = await listEntries(dir, profile);
      console.log(`[cliSessionWatcher] poll: ${entries.length} entries, rejected=${rejected.size}`);
      const candidates = [];
      for (const entryPath of entries) {
        const base = path.basename(entryPath);
        if (rejected.has(entryPath)) continue;
        if (profile.filePattern && !profile.filePattern.test(base)) continue;
        const id = profile.parseId(base);
        if (!id) continue;
        let st;
        try { st = await fsp.stat(entryPath); } catch { continue; }
        // Mtime gate is re-evaluated every poll: don't memoise it. If the
        // CLI later re-touches an old transcript (claude appends to the
        // existing one for the cwd), this poll will pick it up.
        if (st.mtimeMs < spawnAt - 2000) continue;
        candidates.push({ entryPath, id, mtime: st.mtimeMs });
      }
      const matched = [];
      for (const c of candidates) {
        const cwdFromEntry = await profile.readCwd(c.entryPath);
        if (cwdFromEntry == null) continue; // not enough data yet
        if (!samePath(cwdFromEntry, cwd)) { rejected.add(c.entryPath); continue; }
        matched.push(c);
      }
      if (matched.length === 1) {
        finish(matched[0].id);
        return;
      }
      if (matched.length > 1) {
        console.warn(`[cliSessionWatcher] ambiguous: ${matched.length} candidates for ${cwd} — skipping capture`);
        cleanup();
        return;
      }
    } catch (e) {
      console.error('[cliSessionWatcher] poll:', e.message);
    }
    if (!stopped) pollTimer = setTimeout(poll, POLL_MS);
  };

  (async () => {
    try { await fsp.mkdir(dir, { recursive: true }); } catch {}
    if (stopped) return;
    expireTimer = setTimeout(onExpire, windowMs);
    poll();
  })();

  return cleanup;
}

module.exports = { captureSessionId };

// ── helpers ─────────────────────────────────────────────────────────

async function listEntries(root, profile) {
  if (profile.entryType === 'dir') {
    let names;
    try { names = await fsp.readdir(root, { withFileTypes: true }); }
    catch { return []; }
    return names.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  }
  // file mode
  if (profile.recursive) return listAllFiles(root);
  try {
    const names = await fsp.readdir(root);
    return names.map((n) => path.join(root, n));
  } catch {
    return [];
  }
}

function claudeSlug(cwd) {
  return cwd.replace(/[:\\\/]/g, '-');
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

async function firstJsonField(filepath, field, maxLines) {
  return new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(filepath, { encoding: 'utf8' }); }
    catch { resolve(null); return; }
    const rl = readline.createInterface({ input: stream });
    let count = 0;
    // rl.close() synchronously emits 'close' on some platforms, which would
    // re-enter done(null) and clobber the value resolve. Guard against that.
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      resolve(v);
    };
    rl.on('line', (line) => {
      count++;
      try {
        const obj = JSON.parse(line);
        if (obj && Object.prototype.hasOwnProperty.call(obj, field)) {
          done(obj[field]);
          return;
        }
      } catch {}
      if (count >= maxLines) done(null);
    });
    rl.on('close', () => done(null));
    rl.on('error', () => done(null));
  });
}

async function listAllFiles(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(root);
  return out;
}
