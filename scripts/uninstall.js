#!/usr/bin/env node
'use strict';

// Reverse of install.js · unregister ccsm:// and ask any running backend
// to shut down. Triggered by `npm uninstall -g @bakapiano/ccsm`.

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

function log(msg)  { process.stdout.write(`[ccsm uninstall] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ccsm uninstall] ${msg}\n`); }

if (process.platform !== 'win32') process.exit(0);

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

function deleteLauncherVbs() {
  const home = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!home) return;
  const dir = path.join(home, 'ccsm');
  const vbs = path.join(dir, 'launcher.vbs');
  if (fs.existsSync(vbs)) fs.unlinkSync(vbs);
  // Remove the (now-empty) folder if we created it.
  try { fs.rmdirSync(dir); } catch {}
}

(async () => {
  await shutdownIfRunning();
  try { deleteRegKey(); log('ccsm:// protocol unregistered'); }
  catch (e) { warn(`reg cleanup failed · ${e.message}`); }
  try { deleteLauncherVbs(); log('launcher.vbs removed'); }
  catch (e) { warn(`vbs cleanup failed · ${e.message}`); }
  log('done.');
})();
