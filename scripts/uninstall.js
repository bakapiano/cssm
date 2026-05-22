#!/usr/bin/env node
'use strict';

// Reverse of install.js · unregister ccsm:// and ask any running backend
// to shut down. Triggered by `npm uninstall -g @bakapiano/ccsm`.

const http = require('node:http');
const { spawnSync } = require('node:child_process');

function log(msg)  { process.stdout.write(`[ccsm uninstall] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ccsm uninstall] ${msg}\n`); }

if (process.platform !== 'win32') process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

function shutdownIfRunning() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 7777, path: '/api/shutdown', method: 'POST', timeout: 1500,
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write('{}');
    req.end();
  });
}

function deleteRegKey() {
  const r = spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Classes\\ccsm', '/f'], { windowsHide: true });
  // exit 1 means key didn't exist — fine.
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`reg delete → exit ${r.status}: ${r.stderr?.toString() || ''}`);
  }
}

(async () => {
  await shutdownIfRunning();
  try { deleteRegKey(); log('ccsm:// protocol unregistered'); }
  catch (e) { warn(`failed · ${e.message}`); }
  log('done.');
})();
