#!/usr/bin/env node
'use strict';

// ccsm postinstall · Windows-only · runs after `npm install -g @bakapiano/ccsm`.
// Registers the `ccsm://` URL protocol in HKCU so the hosted frontend
// (https://bakapiano.github.io/cssm/v1/) can fire `<a href="ccsm://start">`
// from its OfflineBanner and have Windows spawn the backend on demand.
//
// Best-effort: any failure MUST NOT break npm install. Each step is in
// its own try/catch; we just log and move on.
//
// No .lnk file, no Start Menu shortcut — just the protocol handler.

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function log(msg)  { process.stdout.write(`[ccsm install] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ccsm install] ${msg}\n`); }

if (process.platform !== 'win32') {
  log('non-Windows · skipping ccsm:// registration');
  process.exit(0);
}
if (process.env.npm_config_global !== 'true') {
  log('not a global install · skipping');
  process.exit(0);
}

function findCcsmCmd() {
  const prefix = process.env.npm_config_prefix
    || (() => {
      try {
        const r = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', shell: true });
        return r.stdout?.trim() || null;
      } catch { return null; }
    })();
  if (!prefix) return null;
  const candidate = path.join(prefix, 'ccsm.cmd');
  return fs.existsSync(candidate) ? candidate : null;
}

function registerProtocol(ccsmCmd) {
  // %1 = the entire ccsm:// URL the user clicked. bin/ccsm.js parses
  // it and dispatches by action (start, etc.).
  const command = `"${ccsmCmd}" "%1"`;
  const root = 'HKCU\\Software\\Classes\\ccsm';
  const calls = [
    ['add', root, '/ve', '/d', 'URL:ccsm protocol', '/f'],
    ['add', root, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${root}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
  ];
  for (const args of calls) {
    const r = spawnSync('reg.exe', args, { windowsHide: true });
    if (r.status !== 0) {
      throw new Error(`reg ${args.join(' ')} → exit ${r.status}: ${r.stderr?.toString() || ''}`);
    }
  }
}

const ccsmCmd = (() => {
  try { return findCcsmCmd(); } catch { return null; }
})();
if (!ccsmCmd) {
  warn('could not locate ccsm.cmd · skipping protocol registration');
  process.exit(0);
}

try {
  registerProtocol(ccsmCmd);
  log(`ccsm:// protocol registered → ${ccsmCmd} %1`);
  log('open https://bakapiano.github.io/cssm/v1/ and click "Start ccsm" on the offline banner to launch the backend.');
} catch (e) {
  warn(`failed · ${e.message}`);
  warn('the hosted frontend\'s "Start ccsm" button will not be able to launch the backend. You can still run `ccsm` manually in a terminal.');
}
