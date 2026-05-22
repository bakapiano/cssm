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
// Note: we DO register on npx-cache installs too (not just global). The
// npx cache path is stable across re-runs of the same package, and even
// if the user later cleans the cache, the only consequence is the
// OfflineBanner button no-ops — nothing actively broken. Registering
// always means a first-time `npx @bakapiano/ccsm` gets the full "click
// to wake" UX without needing a separate `npm i -g`.

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

// Write a tiny VBScript wrapper that ccsm:// dispatches into. Why VBS:
// wscript.exe is a Windows-subsystem host (no console window), and
// `Shell.Run(..., 0, False)` launches the target completely hidden — so
// when the user clicks ccsm://start, NOTHING flashes on screen, the
// backend just appears in the next health probe.
function writeLauncherVbs(ccsmCmd) {
  const home = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!home) throw new Error('no LOCALAPPDATA/APPDATA env var');
  const dir = path.join(home, 'ccsm');
  fs.mkdirSync(dir, { recursive: true });
  const vbsPath = path.join(dir, 'launcher.vbs');
  // Escape any double-quotes in the cmd path (rare but possible).
  const cmdEsc = ccsmCmd.replace(/"/g, '""');
  const vbs = [
    "' ccsm protocol launcher · invoked by wscript.exe via the registered",
    "' ccsm:// URL handler. Spawns ccsm.cmd with WindowStyle 0 (hidden) +",
    "' bWaitOnReturn=False (async), so the click leaves zero visible trace.",
    'If WScript.Arguments.Count >= 1 Then',
    '  arg = WScript.Arguments(0)',
    'Else',
    '  arg = ""',
    'End If',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${cmdEsc}"" """ & arg & """", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, { encoding: 'utf8' });
  return vbsPath;
}

function registerProtocol(vbsPath) {
  // wscript.exe is a no-console host. The protocol-registered command
  // hands the entire ccsm:// URL to launcher.vbs as argv[0]; the VBS
  // forwards it to ccsm.cmd "%1" with a hidden window.
  const command = `wscript.exe "${vbsPath}" "%1"`;
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
  const vbsPath = writeLauncherVbs(ccsmCmd);
  registerProtocol(vbsPath);
  log(`launcher · ${vbsPath}`);
  log(`ccsm:// protocol registered (silent · via wscript.exe)`);
} catch (e) {
  warn(`failed · ${e.message}`);
  warn('the hosted frontend\'s "Start ccsm" button will not be able to launch the backend. You can still run `ccsm` manually in a terminal.');
}

// Auto-launch ccsm after install so the user lands directly in the app
// without needing a second command. Detached + windowsHide so the npm
// install command returns immediately. Skip if CCSM_NO_AUTOLAUNCH=1 is
// set (CI, headless setups).
if (process.env.CCSM_NO_AUTOLAUNCH !== '1') {
  try {
    const { spawn } = require('node:child_process');
    const child = spawn(ccsmCmd, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.unref();
    log('launching ccsm now · check for the chromeless window');
    log('(set CCSM_NO_AUTOLAUNCH=1 to skip this on future installs)');
  } catch (e) {
    warn(`auto-launch failed · ${e.message}`);
    warn('run `ccsm` manually to start.');
  }
}
