#!/usr/bin/env node
'use strict';

// Dev launcher · fully isolates from the user's prod ccsm install.
//
// Why: many contributors run the published `@bakapiano/ccsm` package
// for their day-to-day work (port 7777, ~/.ccsm). If `npm run dev`
// reused the same data dir + port, every hot-reload would clobber the
// live sessions.json. So dev gets its own:
//
//   - CCSM_HOME   → ~/.ccsm-dev/   (separate config.json, sessions.json, folders.json)
//   - port        → 7788           (no contention with prod 7777)
//   - workDir     → ~/ccsm-workspaces-dev (separate workspace tree)
//   - no browser auto-open (we're iterating in an already-open tab)
//
// Run via `npm run dev`. The first launch seeds a starter config; later
// launches leave it alone so dev's own customisations stick.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEV_HOME = path.join(os.homedir(), '.ccsm-dev');
const DEV_PORT = '7788';
const DEV_WORKDIR = path.join(os.homedir(), 'ccsm-workspaces-dev');

fs.mkdirSync(DEV_HOME, { recursive: true });

// Seed a fresh dev config the first time. Subsequent runs leave the
// existing file alone — the dev's own UI edits persist across restarts.
const configPath = path.join(DEV_HOME, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({
    port: Number(DEV_PORT),
    workDir: DEV_WORKDIR,
    repos: [],
  }, null, 2));
}

// Mirror pages-root assets into public/ so the dev server can serve
// them at the URL paths the deployed site uses (manifest at
// /manifest.webmanifest, setup page at /setup/). Both mirror files
// are .gitignored — they exist only for local preview.
//
// The manifest is rewritten with a "ccsm-dev" identity so the PWA
// installed from dev shows up separately in Chrome's installed-apps
// list and Start Menu, instead of conflicting with the prod CCSM
// install.
const REPO_ROOT = path.join(__dirname, '..');
const PAGES_ROOT = path.join(REPO_ROOT, 'pages-root');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function mirrorSetup() {
  try {
    const src = path.join(PAGES_ROOT, 'setup');
    const dst = path.join(PUBLIC_DIR, 'setup');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
  } catch (e) { console.warn('[dev] setup mirror failed:', e.message); }
}
function writeDevManifest() {
  try {
    const src = path.join(PAGES_ROOT, 'manifest.webmanifest');
    const m = JSON.parse(fs.readFileSync(src, 'utf8'));
    m.id = '/?ccsm-dev';
    m.name = 'CCSM dev';
    m.short_name = 'CCSM dev';
    // Dev runs at host root (localhost:7788/), so scope + start_url
    // anchor at `/` not `./` (which would resolve relative to the
    // manifest URL — same result here, but explicit is clearer).
    m.scope = '/';
    m.start_url = '/';
    // Drop related_applications self-reference — its URL points at
    // the prod GH Pages manifest, not this dev one. Leaving it in
    // would let prod's getInstalledRelatedApps() detect dev installs
    // as if they were prod, which is the opposite of what we want.
    delete m.related_applications;
    fs.writeFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), JSON.stringify(m, null, 2));
  } catch (e) { console.warn('[dev] manifest mirror failed:', e.message); }
}
mirrorSetup();
writeDevManifest();

const env = {
  ...process.env,
  CCSM_HOME: DEV_HOME,
  CCSM_PORT: DEV_PORT,
  CCSM_NO_BROWSER: '1',
  // Marks the running server as "launched by dev.js" so /api/restart can
  // skip the production restart-helper path (which respawns the global
  // `ccsm.cmd` and would replace our --watch checkout server). In dev
  // mode the server just process.exit(0)s and this script respawns it.
  CCSM_DEV: '1',
};

const serverPath = path.join(__dirname, '..', 'server.js');

let current = null;
let stopping = false;

function spawnServer() {
  // Don't use `node --watch` here — its restart-on-exit semantics are
  // "wait for a file change after a clean exit", so calling
  // process.exit(0) from /api/restart leaves --watch idling forever
  // until the user touches a file. We do our own respawn-on-exit
  // (below) which handles both the restart-by-exit path AND crashes,
  // and the dev/api SSE endpoint still gives us frontend hot-reload
  // without needing --watch for backend code (each restart pulls fresh
  // require() cache anyway since this is a new process).
  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (stopping) {
      process.exit(signal ? 1 : (code ?? 0));
      return;
    }
    // Server asked to restart (POST /api/restart → gracefulShutdown +
    // exit 0). Respawn — node --watch picks up any code changes that
    // landed in the meantime. A small delay lets the port fully release.
    console.log(`[dev] server exited (code=${code} signal=${signal || ''}) · respawning`);
    setTimeout(() => { current = spawnServer(); }, 500);
  });
  return child;
}

const stop = (sig) => () => {
  stopping = true;
  if (current) current.kill(sig);
};
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));

current = spawnServer();
