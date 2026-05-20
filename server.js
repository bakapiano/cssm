#!/usr/bin/env node
'use strict';

const path = require('node:path');
const express = require('express');

const { listSessions, listRecentSessions } = require('./lib/sessions');
const { loadConfig, saveConfig, DATA_DIR } = require('./lib/config');
const {
  saveSnapshot,
  loadLatestSnapshot,
  listSnapshotHistory,
  loadSnapshotByFile,
  restoreSnapshot,
} = require('./lib/snapshot');
const {
  listWorkspaces,
  findOrCreateWorkspace,
  ensureReposInWorkspace,
} = require('./lib/workspace');
const {
  launchNewClaude,
  launchResume,
  listTerminalKinds,
  processNameFor,
} = require('./lib/launcher');
const {
  focusByPid,
  focusBySession,
  snapshotWindowsOf,
  focusNewlyOpenedHwnd,
} = require('./lib/focus');

async function autoFocusAfterLaunch({ terminal, beforeHwnds, autoFocus }) {
  if (!autoFocus) return;
  try {
    const processName = processNameFor(terminal);
    if (!processName) return;
    await focusNewlyOpenedHwnd(beforeHwnds, processName);
  } catch (e) {
    console.error('[auto-focus]', e.message);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncH(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api error]', err);
      res.status(500).json({ error: String(err && err.message || err) });
    });
  };
}

// ---- sessions ----

app.get('/api/sessions', asyncH(async (_req, res) => {
  const sessions = await listSessions();
  res.json({ sessions, takenAt: Date.now() });
}));

app.get('/api/sessions/recent', asyncH(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const live = await listSessions();
  const excludeIds = new Set(live.map((s) => s.sessionId));
  const recent = await listRecentSessions({ limit, excludeIds });
  res.json({ recent, takenAt: Date.now() });
}));

// ---- config ----

app.get('/api/config', asyncH(async (_req, res) => {
  res.json(await loadConfig());
}));

app.put('/api/config', asyncH(async (req, res) => {
  const cfg = await saveConfig(req.body || {});
  res.json(cfg);
}));

// ---- snapshot ----

app.get('/api/snapshot', asyncH(async (_req, res) => {
  const snap = await loadLatestSnapshot();
  res.json({ snapshot: snap });
}));

app.post('/api/snapshot', asyncH(async (_req, res) => {
  const cfg = await loadConfig();
  const snap = await saveSnapshot({ keep: cfg.snapshotHistoryKeep });
  res.json({ snapshot: snap });
}));

app.get('/api/snapshot/history', asyncH(async (_req, res) => {
  res.json({ history: await listSnapshotHistory() });
}));

app.post('/api/snapshot/restore', asyncH(async (req, res) => {
  let snap;
  if (req.body && req.body.file) {
    snap = await loadSnapshotByFile(req.body.file);
  } else {
    snap = await loadLatestSnapshot();
  }
  if (!snap) return res.status(404).json({ error: 'no snapshot to restore' });
  const cfg = await loadConfig();
  const beforeHwnds = await snapshotWindowsOf(
    processNameFor(cfg.terminal) || 'WindowsTerminal.exe'
  );
  const result = restoreSnapshot(snap, {
    terminal: cfg.terminal,
    claudeCommand: cfg.claudeCommand,
      commandShell: cfg.commandShell || "pwsh",
  });
  // For N restored windows we just focus the last one to surface restore-happened
  // without strobing focus through all N.
  autoFocusAfterLaunch({
    terminal: cfg.terminal,
    beforeHwnds,
    autoFocus: cfg.autoFocusOnLaunch !== false,
  });
  res.json({ restored: result, takenAt: snap.takenAt, count: snap.sessions.length });
}));

// ---- workspaces ----

app.get('/api/workspaces', asyncH(async (_req, res) => {
  const cfg = await loadConfig();
  const workspaces = await listWorkspaces({
    workDir: cfg.workDir,
    repos: cfg.repos,
  });
  res.json({ workDir: cfg.workDir, repos: cfg.repos, workspaces });
}));

// ---- new session ----
// body: { repos: ["repo-a","repo-b"], workspace?: "ws-2" (override), launch?: true }
// Streams NDJSON: one JSON object per line. Event types:
//   {type:"workspace", workspace, created}
//   {type:"clone-start", repo}
//   {type:"clone-progress", repo, phase, percent, current, total, detail}
//   {type:"clone-line", repo, line}            (raw git line, when no progress)
//   {type:"clone-done", repo, action, path}
//   {type:"clone-error", repo, error}
//   {type:"launched", launched}
//   {type:"done", success, error?}
app.post('/api/sessions/new', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable response compression buffering — flush right away.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (obj) => {
    res.write(JSON.stringify(obj) + '\n');
  };
  const fail = (msg, extra) => {
    emit({ type: 'done', success: false, error: msg, ...extra });
    res.end();
  };

  try {
    const cfg = await loadConfig();
    const wantedNames = Array.isArray(req.body && req.body.repos)
      ? req.body.repos
      : cfg.repos.filter((r) => r.defaultSelected).map((r) => r.name);

    const wantedRepos = cfg.repos.filter((r) => wantedNames.includes(r.name));
    if (wantedRepos.length === 0) {
      return fail('No repos selected and no defaults available');
    }

    let workspace;
    let created = false;
    if (req.body && req.body.workspace) {
      const all = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos });
      workspace = all.find((w) => w.name === req.body.workspace);
      if (!workspace) return fail(`workspace ${req.body.workspace} not found`);
      if (workspace.inUse) {
        return fail(
          `workspace ${workspace.name} is in use by ${workspace.sessionsHere.length} session(s)`
        );
      }
    } else {
      const r = await findOrCreateWorkspace({
        workDir: cfg.workDir,
        repos: cfg.repos,
        requireUnused: true,
      });
      workspace = r.workspace;
      created = r.created;
    }
    emit({ type: 'workspace', workspace, created });

    const cloneResults = await ensureReposInWorkspace({
      workspacePath: workspace.path,
      repos: wantedRepos,
      onRepoStart: (repo) =>
        emit({ type: 'clone-start', repo: repo.name, url: repo.url }),
      onProgress: (repo, p) =>
        emit({
          type: 'clone-progress',
          repo: repo.name,
          phase: p.phase,
          percent: p.percent,
          current: p.current,
          total: p.total,
          detail: p.detail,
        }),
      onLine: (repo, line) =>
        emit({ type: 'clone-line', repo: repo.name, line }),
      onRepoEnd: (repo, result) =>
        emit({ type: 'clone-end', repo: repo.name, ...result }),
    });

    const failed = cloneResults.filter((r) => !r.ok);
    if (failed.length > 0) {
      return fail('Some repos failed to clone', { cloneResults });
    }

    const shouldLaunch = req.body && req.body.launch !== false;
    let launched = null;
    if (shouldLaunch) {
      const beforeHwnds = await snapshotWindowsOf(
        processNameFor(cfg.terminal) || 'WindowsTerminal.exe'
      );
      launched = launchNewClaude({
        cwd: workspace.path,
        title: workspace.name,
        terminal: cfg.terminal,
        claudeCommand: cfg.claudeCommand,
      commandShell: cfg.commandShell || "pwsh",
      });
      emit({ type: 'launched', launched });
      autoFocusAfterLaunch({
        terminal: cfg.terminal,
        beforeHwnds,
        autoFocus: cfg.autoFocusOnLaunch !== false,
      });
    }

    emit({
      type: 'done',
      success: true,
      workspace,
      created,
      cloneResults,
      launched,
    });
    res.end();
  } catch (e) {
    console.error('[/api/sessions/new]', e);
    fail(String(e && e.message || e));
  }
});

// ---- launch finder session (a claude session in the ccsm data dir pre-pointed at session data) ----
app.post('/api/sessions/finder', asyncH(async (_req, res) => {
  const cfg = await loadConfig();
  const beforeHwnds = await snapshotWindowsOf(processNameFor(cfg.terminal) || 'WindowsTerminal.exe');
  const launched = launchNewClaude({
    cwd: DATA_DIR,
    title: 'ccsm finder',
    extraArgs: cfg.finderPrompt ? [cfg.finderPrompt] : [],
    terminal: cfg.terminal,
    claudeCommand: cfg.claudeCommand,
    commandShell: cfg.commandShell || 'pwsh',
  });
  autoFocusAfterLaunch({
    terminal: cfg.terminal,
    beforeHwnds,
    autoFocus: cfg.autoFocusOnLaunch !== false,
  });
  res.json({ launched, cwd: DATA_DIR, prompt: cfg.finderPrompt });
}));

// ---- resume single session ----
app.post('/api/sessions/:sessionId/resume', asyncH(async (req, res) => {
  const sessionId = req.params.sessionId;
  const cwd = req.body && req.body.cwd;
  if (!cwd) return res.status(400).json({ error: 'cwd required in body' });
  const cfg = await loadConfig();
  const beforeHwnds = await snapshotWindowsOf(processNameFor(cfg.terminal) || 'WindowsTerminal.exe');
  const launched = launchResume({
    cwd,
    sessionId,
    terminal: cfg.terminal,
    claudeCommand: cfg.claudeCommand,
      commandShell: cfg.commandShell || "pwsh",
  });
  autoFocusAfterLaunch({
    terminal: cfg.terminal,
    beforeHwnds,
    autoFocus: cfg.autoFocusOnLaunch !== false,
  });
  res.json({ launched });
}));

// ---- focus the wt window that's already hosting this session ----
app.post('/api/sessions/:sessionId/focus', asyncH(async (req, res) => {
  const sessionId = req.params.sessionId;
  const sessions = await listSessions();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return res.status(404).json({ error: `session ${sessionId} not live` });
  const result = await focusBySession({
    pid: s.pid,
    sessionId: s.sessionId,
    title: s.title,
    cwd: s.cwd,
  });
  res.json({ session: { pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, title: s.title }, ...result });
}));

// ---- terminal kinds ----
app.get('/api/terminals', (_req, res) => res.json({ terminals: listTerminalKinds() }));

// ---- health ----
app.get('/api/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

// ---- auto-snapshot scheduler ----
let snapshotTimer = null;
async function startSnapshotLoop() {
  const cfg = await loadConfig();
  const interval = Math.max(5_000, cfg.snapshotIntervalMs || 60_000);
  const tick = async () => {
    try {
      const cfg = await loadConfig();
      await saveSnapshot({ keep: cfg.snapshotHistoryKeep });
    } catch (e) {
      console.error('[snapshot]', e.message);
    }
  };
  snapshotTimer = setInterval(tick, interval);
  tick().catch(() => {});
  console.log(`[snapshot] auto-saving every ${Math.round(interval / 1000)}s`);
}

// Try the preferred port, then preferred+1..+9, then let the OS pick a free
// one. Resolves with the port the server actually bound to.
function listenWithFallback(preferred) {
  return new Promise((resolve, reject) => {
    const attempt = (port, tries) => {
      const server = app.listen(port);
      server.once('listening', () => resolve({ server, port: server.address().port }));
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (tries < 9) attempt(port + 1, tries + 1);
        else if (tries === 9) attempt(0, tries + 1); // OS-assigned free port
        else reject(err);
      });
    };
    attempt(preferred, 0);
  });
}

function findAppModeBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const fs = require('node:fs');
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function openInBrowser(url, mode) {
  if (process.platform !== 'win32' || mode === 'none') return;
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');

  if (mode === 'app') {
    const exe = findAppModeBrowser();
    if (exe) {
      // Per-ccsm profile dir so we don't get the "already running, --app
      // ignored" merge behavior of Edge/Chrome when the user has a normal
      // window open. Lives under DATA_DIR so it's tidied with the rest.
      const profileDir = path.join(DATA_DIR, 'browser-profile');
      fs.mkdirSync(profileDir, { recursive: true });
      const child = spawn(
        exe,
        [
          `--app=${url}`,
          `--user-data-dir=${profileDir}`,
          '--window-size=1400,1000',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      return;
    }
    console.log('[ccsm] no Edge/Chrome found for app mode, falling back to default browser');
  }

  // mode === 'tab' (or app-mode fallback)
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

(async () => {
  const cfg = await loadConfig();
  const { port } = await listenWithFallback(cfg.port);
  const url = `http://localhost:${port}`;
  console.log(`ccsm listening on ${url}${port !== cfg.port ? `  (requested ${cfg.port}, was taken)` : ''}`);
  console.log(`data dir:        ${DATA_DIR}`);
  console.log(`work dir:        ${cfg.workDir}`);
  console.log(`terminal:        ${cfg.terminal} · ${cfg.claudeCommand}${cfg.terminal === 'wt' ? ` (via ${cfg.commandShell})` : ''}`);
  const mode = cfg.browserMode || (cfg.autoOpenBrowser === false ? 'none' : 'app');
  openInBrowser(url, mode);
  startSnapshotLoop();
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
