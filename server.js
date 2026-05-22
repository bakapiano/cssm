#!/usr/bin/env node
'use strict';

const path = require('node:path');
const express = require('express');

const { listSessions, listRecentSessions, findSessionMetadata } = require('./lib/sessions');
const { listFavorites, addFavorite, removeFavorite, loadFavorites } = require('./lib/favorites');
const { loadLabels, setLabel, removeLabel } = require('./lib/labels');
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
const webTerminal = require('./lib/webTerminal');

// One unified exit path so every reason-for-shutdown gets the same
// cleanup: final snapshot save (so the next launch can restore current
// state) + PTY children killed. Idempotent — concurrent triggers are no-ops.
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ccsm] shutting down · ${reason}`);

  // Final snapshot. Wrap in a race so a wedged disk doesn't hang us
  // indefinitely — 2s is generous (typical save is <300ms).
  try {
    const cfg = await loadConfig();
    await Promise.race([
      saveSnapshot({ keep: cfg.snapshotHistoryKeep }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('save timeout (2s)')), 2000)),
    ]);
    console.log('[ccsm] final snapshot saved');
  } catch (e) {
    console.error('[ccsm] final snapshot skipped:', e.message);
  }

  // Kill any in-process PTY children so they don't outlive us.
  try { webTerminal.killAll(); } catch {}

  process.exit(0);
}

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

// CORS · allow the hosted-frontend (GH Pages) origin to call /api/* and
// open WebSockets. Listed explicitly — never reflect Origin or use '*' so
// random web pages can't reach the local backend. Localhost dev calls
// stay same-origin (browser doesn't add Origin header → middleware is a
// no-op for them).
const ALLOWED_ORIGINS = new Set([
  'https://bakapiano.github.io',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Dev mode = running from a checkout (not from an npm-install location).
// Used to gate two things: (a) serving static frontend from local public/
// so a contributor can iterate without pushing to GH Pages; (b) hot-reload
// SSE endpoint that watches public/ for changes. CCSM_NO_DEV=1 disables
// both explicitly. In production (npm-installed), backend is API-only —
// frontend lives at https://bakapiano.github.io/cssm/v1/.
const IS_DEV = !__dirname.includes(`${path.sep}node_modules${path.sep}`) && process.env.CCSM_NO_DEV !== '1';

if (IS_DEV) {
  app.use(express.static(path.join(__dirname, 'public')));
}

const reloadClients = new Set();
if (IS_DEV) {
  app.get('/api/dev/ping', (_req, res) => res.json({ dev: true }));
  app.get('/api/dev/reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    reloadClients.add(res);
    // Heartbeat every 25s so intermediate proxies don't kill the stream.
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); reloadClients.delete(res); });
  });
  const publicDir = path.join(__dirname, 'public');
  const fs = require('node:fs');
  let debounce = null;
  fs.watch(publicDir, { recursive: true }, (_event, filename) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (reloadClients.size === 0) return;
      console.log(`[dev] reload · ${filename || '?'} → ${reloadClients.size} client(s)`);
      for (const r of reloadClients) {
        try { r.write(`event: reload\ndata: ${Date.now()}\n\n`); } catch {}
      }
    }, 80);
  });
  console.log('[dev] hot-reload watching public/');
}

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
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 15));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const live = await listSessions();
  const excludeIds = new Set(live.map((s) => s.sessionId));
  const { recent, total } = await listRecentSessions({ limit, offset, excludeIds });
  res.json({ recent, total, limit, offset, takenAt: Date.now() });
}));

// ---- favorites ----
// Sessions the user has starred. Stored at $DATA_DIR/favorites.json.
// Frontend usually GETs once at boot and updates optimistically.
app.get('/api/favorites', asyncH(async (_req, res) => {
  const favorites = await listFavorites();
  res.json({ favorites });
}));

app.post('/api/favorites/:sessionId', asyncH(async (req, res) => {
  const sessionId = req.params.sessionId;
  let info = req.body && typeof req.body === 'object' ? req.body : {};
  // If client didn't supply title/cwd, try to look them up from the live
  // session list or from the jsonl files on disk. This way star-from-empty
  // (e.g. via API) still produces a usable favorite.
  if (!info.cwd || !info.title) {
    const live = await listSessions();
    const livehit = live.find((s) => s.sessionId === sessionId);
    if (livehit) {
      info = { cwd: livehit.cwd, title: livehit.title, ...info };
    } else {
      const meta = await findSessionMetadata(sessionId);
      if (meta) info = { cwd: meta.cwd, title: meta.title, gitBranch: meta.gitBranch, ...info };
    }
  }
  const fav = await addFavorite(sessionId, info);
  res.json({ favorite: fav });
}));

app.delete('/api/favorites/:sessionId', asyncH(async (req, res) => {
  const removed = await removeFavorite(req.params.sessionId);
  res.json({ removed });
}));

// ---- labels (rename overrides) ----
// Custom display titles keyed by sessionId. Empty body / empty label is
// treated as a delete.
app.get('/api/labels', asyncH(async (_req, res) => {
  const labels = await loadLabels();
  res.json({ labels });
}));

app.put('/api/labels/:sessionId', asyncH(async (req, res) => {
  const label = req.body && req.body.label;
  if (!label || !String(label).trim()) {
    const removed = await removeLabel(req.params.sessionId);
    return res.json({ removed });
  }
  const saved = await setLabel(req.params.sessionId, label);
  res.json({ label: saved });
}));

app.delete('/api/labels/:sessionId', asyncH(async (req, res) => {
  const removed = await removeLabel(req.params.sessionId);
  res.json({ removed });
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
      // mode = 'web' → spawn the claude command as an in-process PTY whose
      //                stdio is bridged to xterm.js via WebSocket. The session
      //                lives in webTerminal's pool until killed or claude
      //                exits. No wt window opens.
      // mode = 'wt' (default) → existing behaviour: launch via wt window.
      const mode = req.body && req.body.terminal === 'web' ? 'web' : 'wt';

      if (mode === 'web') {
        if (!webTerminal.available) {
          return fail('node-pty is not installed · web terminal mode unavailable');
        }
        // Wrap in pwsh so config.claudeCommand can be an alias / function
        // defined in the user's profile (e.g. `cc`), same trick wt uses.
        const cmd = cfg.claudeCommand || 'claude';
        const wrap = (cfg.commandShell || 'pwsh') === 'powershell' ? 'powershell.exe' : 'pwsh.exe';
        const entry = webTerminal.spawn({
          command: wrap,
          args: ['-NoExit', '-NoLogo', '-Command', `Set-Location -LiteralPath '${workspace.path.replace(/'/g, "''")}'; & '${cmd.replace(/'/g, "''")}'`],
          cwd: workspace.path,
          meta: { title: workspace.name, workspace: workspace.name, cwd: workspace.path },
        });
        launched = { mode: 'web', id: entry.id, pid: entry.meta.pid, terminal: 'web' };
        emit({ type: 'launched', launched });
      } else {
        const beforeHwnds = await snapshotWindowsOf(
          processNameFor(cfg.terminal) || 'WindowsTerminal.exe'
        );
        launched = launchNewClaude({
          cwd: workspace.path,
          title: workspace.name,
          terminal: cfg.terminal,
          claudeCommand: cfg.claudeCommand,
          commandShell: cfg.commandShell || 'pwsh',
        });
        launched = { mode: 'wt', ...launched };
        emit({ type: 'launched', launched });
        autoFocusAfterLaunch({
          terminal: cfg.terminal,
          beforeHwnds,
          autoFocus: cfg.autoFocusOnLaunch !== false,
        });
      }
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
  const cfg = await loadConfig();
  const result = await focusBySession({
    pid: s.pid,
    sessionId: s.sessionId,
    title: s.title,
    cwd: s.cwd,
    moveToCenter: !!cfg.focusMovesToCenter,
  });
  res.json({ session: { pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, title: s.title }, ...result });
}));

// ---- terminal kinds ----
app.get('/api/terminals', (_req, res) => res.json({ terminals: listTerminalKinds() }));

// ---- capabilities probe · used by the frontend to decide whether to show
// the "open in this page" radio option. node-pty is optional, install-failure
// degrades us to wt-only. ----
app.get('/api/capabilities', (_req, res) => res.json({
  webTerminal: webTerminal.available,
  webTerminalError: webTerminal.available ? null : String(webTerminal.loadError?.message || 'unavailable'),
}));

// ---- web terminals · list / kill ----
// (creation happens through /api/sessions/new with terminal:'web'; attach is
// over WebSocket below.)
app.get('/api/sessions/web', (_req, res) => res.json({ terminals: webTerminal.list() }));

app.delete('/api/sessions/web/:id', (req, res) => {
  const ok = webTerminal.kill(req.params.id);
  res.json({ killed: ok });
});

// ---- health ----
const pkg = require('./package.json');
app.get('/api/health', (_req, res) => res.json({ ok: true, pid: process.pid, version: pkg.version, name: pkg.name }));

// ---- lifecycle ----
// State shared by /api/spawn-browser (opens another window into this server)
// and the heartbeat watchdog (exits the server if no client has pinged for
// HEARTBEAT_TIMEOUT_MS). Heartbeat is the safety net behind the primary
// "browser child exits → server exits" mechanism wired up after listen.
let currentPort = 0;
let lastHeartbeat = Date.now();
let heartbeatSeen = false;
const HEARTBEAT_TIMEOUT_MS = 90_000;

app.post('/api/heartbeat', (_req, res) => {
  lastHeartbeat = Date.now();
  heartbeatSeen = true;
  res.json({ ok: true });
});

app.post('/api/spawn-browser', asyncH(async (_req, res) => {
  const cfg = await loadConfig();
  const mode = cfg.browserMode || (cfg.autoOpenBrowser === false ? 'none' : 'app');
  openInBrowser(`http://localhost:${currentPort}`, mode);
  res.json({ ok: true, mode });
}));

// Graceful shutdown · the uninstall script and the auto-upgrade path in
// the launcher both call this. We reply first so the caller doesn't see
// a torn connection, then exit on the next tick.
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true, bye: 'shutting down' });
  // setImmediate so the response flushes before we tear the server down.
  setImmediate(() => gracefulShutdown('/api/shutdown'));
});

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
  if (mode === 'none' || process.platform !== 'win32') return { kind: 'none', child: null };
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
          '--window-size=1500,1100',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      return { kind: 'app', child };
    }
    console.log('[ccsm] no Edge/Chrome found for app mode, falling back to default browser');
  }

  // mode === 'tab' (or app-mode fallback). cmd's `start` builtin exits
  // immediately after launching the default browser — the child handle
  // isn't usable for lifecycle tracking.
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { kind: 'tab', child: null };
}

(async () => {
  const cfg = await loadConfig();
  const { server, port } = await listenWithFallback(cfg.port);
  currentPort = port;

  // WebSocket upgrade for /ws/terminal/:id → bridges xterm.js to a PTY
  // entry in webTerminal's pool. Only enabled when node-pty loaded; the
  // /api/capabilities endpoint advertises this to the frontend.
  if (webTerminal.available) {
    let WebSocketServer;
    try { ({ WebSocketServer } = require('ws')); } catch {}
    if (WebSocketServer) {
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        // Origin check · same allow-list as REST CORS. Browsers always
        // send Origin on WebSocket upgrades; missing Origin = non-browser
        // client which we tolerate (curl etc).
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
          socket.destroy();
          return;
        }
        const m = req.url && req.url.match(/^\/ws\/terminal\/([^\/?#]+)/);
        if (!m) { socket.destroy(); return; }
        const id = decodeURIComponent(m[1]);
        wss.handleUpgrade(req, socket, head, (ws) => webTerminal.attach(id, ws));
      });
      console.log('[ccsm] web terminal bridge active (WebSocket /ws/terminal/:id)');
    }
  }

  // OS signals · run a graceful shutdown (which saves a final snapshot
  // and kills PTY children) before exiting.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => gracefulShutdown(sig));
  }
  // Last-resort cleanup on sync exit (process.on('exit') can't await
  // anything, so it's only a safety net for PTY children).
  process.on('exit', () => { try { webTerminal.killAll(); } catch {} });
  const url = `http://localhost:${port}`;
  console.log(`ccsm listening on ${url}${port !== cfg.port ? `  (requested ${cfg.port}, was taken)` : ''}`);
  console.log(`data dir:        ${DATA_DIR}`);
  console.log(`work dir:        ${cfg.workDir}`);
  console.log(`terminal:        ${cfg.terminal} · ${cfg.claudeCommand}${cfg.terminal === 'wt' ? ` (via ${cfg.commandShell})` : ''}`);
  // CCSM_NO_BROWSER=1 (set by the launcher when responding to a ccsm://
  // protocol click) suppresses the auto-spawned browser window — the
  // caller already has one open and just needs the backend to come up.
  const mode = process.env.CCSM_NO_BROWSER === '1'
    ? 'none'
    : (cfg.browserMode || (cfg.autoOpenBrowser === false ? 'none' : 'app'));
  const opened = openInBrowser(url, mode);

  // Primary lifecycle: tie this server's lifetime to the chromeless
  // browser window. msedge.exe runs with its own --user-data-dir process
  // group, so when the user closes the window it actually exits — and
  // the spawned child handle we hold here fires 'exit'. Skip if the user
  // explicitly asked the server to stay alive (e.g. an automation host).
  if (opened.kind === 'app' && opened.child && process.env.CCSM_KEEP_ALIVE !== '1') {
    const launchedAt = Date.now();
    opened.child.on('exit', () => {
      const alive = Date.now() - launchedAt;
      // Edge --app= often spawns a process that immediately hands its URL
      // off to an existing Edge profile process group and exits — our
      // child handle dies milliseconds after creation. Treat any exit
      // inside the first 5s as a hand-off, not a real close.
      if (alive < 5000) {
        console.log(`[ccsm] spawned browser child exited in ${alive}ms · handed off to an existing Edge instance, staying alive`);
        return;
      }
      // If another client (e.g. a hosted-frontend tab at bakapiano.github.io
      // /cssm/v1) is heartbeating, don't kill — they're still using us.
      if (heartbeatSeen && (Date.now() - lastHeartbeat) < 30_000) {
        console.log('[ccsm] browser closed but another client is heartbeating · staying alive');
        return;
      }
      gracefulShutdown('browser window closed');
    });
    console.log('[ccsm] tied to browser window — close it to stop ccsm');
  }

  // Heartbeat watchdog · only activated when launched via bin/ccsm.js
  // (CCSM_LAUNCHER=1). Catches cases the primary mechanism misses: the
  // browser was killed forcibly, msedge crashed without a clean exit, or
  // the user opened the URL in tab-mode in their own browser instead of
  // the chromeless app window. We don't kill until we've seen at least
  // one heartbeat — that way a freshly-booted server with no client yet
  // doesn't suicide.
  if (process.env.CCSM_LAUNCHER === '1' && process.env.CCSM_KEEP_ALIVE !== '1') {
    setInterval(() => {
      if (!heartbeatSeen) return;
      if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        gracefulShutdown(`no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
      }
    }, 30_000);
    console.log('[ccsm] heartbeat watchdog active');
  }

  startSnapshotLoop();
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
