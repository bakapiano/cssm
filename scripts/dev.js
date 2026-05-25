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

const env = {
  ...process.env,
  CCSM_HOME: DEV_HOME,
  CCSM_PORT: DEV_PORT,
  CCSM_NO_BROWSER: '1',
};

const serverPath = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, ['--watch', serverPath], {
  env,
  stdio: 'inherit',
});

const forward = (sig) => () => child.kill(sig);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
