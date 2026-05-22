#!/usr/bin/env node
'use strict';

// ccsm launcher · entry point for `ccsm` / `npx @bakapiano/ccsm`.
//
// Two modes by how it's invoked:
//
//   plain `ccsm`           → start backend if not running, open a browser
//                            window pointing at it. Terminal returns to a
//                            prompt immediately (detached).
//
//   `ccsm ccsm://<action>` → fired by Windows when the user clicks a
//                            ccsm:// link (PWA offline banner). Same
//                            backend startup as above, but DO NOT spawn
//                            an extra browser — the PWA window that
//                            triggered the click is already open and
//                            will reconnect as soon as the backend
//                            becomes reachable.
//
// In both modes, if a server is already running we just ping it. New
// browser window opens only in the plain-`ccsm` case.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const HOME = process.env.CCSM_HOME || path.join(os.homedir(), '.ccsm');
const LOG  = path.join(HOME, 'server.log');

function loadPreferredPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    return Number(cfg.port) || 7777;
  } catch {
    return 7777;
  }
}

function probe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.name === '@bakapiano/ccsm' ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function post(port, pathname, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write('{}');
    req.end();
  });
}

// Detect ccsm:// protocol invocation. Windows runs us as
// `ccsm.cmd ccsm://start` when the user clicks a protocol link.
// argv layout: [node, ccsm.js, "ccsm://..."]
function parseProtocolArg() {
  const a = process.argv[2];
  if (!a || !/^ccsm:\/\//i.test(a)) return null;
  try {
    // Normalise: ccsm://start or ccsm://start?foo=bar
    const u = new URL(a);
    // host is the action (`start`, `restart`, ...); empty host means
    // the URL was `ccsm:start` or `ccsm:///action`
    const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    return { action, raw: a };
  } catch {
    return { action: '', raw: a };
  }
}

// Compare what's running with what's installed. Returns true if they
// match (or running is unknown). False means we should restart so the
// new code takes over after an `npm i -g @bakapiano/ccsm@latest`.
function isSameVersion(running) {
  try {
    const installed = require('../package.json').version;
    return running.version === installed;
  } catch { return true; }
}

(async () => {
  const protocol = parseProtocolArg();
  const SILENT = !!protocol;  // ccsm:// invocations should not open a new browser
  const port = loadPreferredPort();

  // Case 1: existing instance on the preferred port
  let existing = await probe(port);

  // If an old version is running, ask it to shut down so the freshly
  // installed code can take over. The launcher then falls through to
  // Case 2 and spawns the new server itself.
  if (existing && !isSameVersion(existing)) {
    const installed = require('../package.json').version;
    console.log(`ccsm upgrading · running v${existing.version} → installed v${installed}`);
    await post(port, '/api/shutdown');
    // Wait for the old process to actually exit so its port frees up.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await probe(port, 200))) { existing = null; break; }
    }
  }

  if (existing) {
    if (!SILENT) {
      const opened = await post(port, '/api/spawn-browser');
      console.log(`ccsm already running · v${existing.version} · http://localhost:${port}`);
      if (!opened) console.log('(could not open a new window — server might be busy)');
    } else {
      console.log(`ccsm already running · ${protocol.raw}`);
    }
    return;
  }

  // Case 2: spawn detached server
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] ccsm starting (protocol=${protocol?.raw || '-'})...\n`);

  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      CCSM_LAUNCHER: '1',
      // Suppress the server's own auto-spawn of a browser when this launch
      // came from a ccsm:// click — the PWA window that fired it is the
      // browser, and a second window would just be noise.
      ...(SILENT ? { CCSM_NO_BROWSER: '1' } : {}),
    },
  });
  child.unref();

  // Poll /api/health for up to ~10s. Once it answers we know the server
  // is fully booted (port is bound, config loaded, snapshot loop running).
  // The actual port may differ from the preferred one if it was taken,
  // so on each iteration we re-probe the preferred port first, then fall
  // back to scanning preferred+1..preferred+9.
  const portsToTry = [port, ...Array.from({ length: 9 }, (_, i) => port + i + 1)];
  let actualPort = null;
  let ready = null;
  outer:
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    for (const p of portsToTry) {
      const r = await probe(p, 300);
      if (r) { ready = r; actualPort = p; break outer; }
    }
  }
  if (!ready) {
    console.error(`ccsm server did not come up in 10s. Check ${LOG}`);
    process.exit(1);
  }
  console.log(`ccsm started · v${ready.version}`);
  console.log(`backend:  http://localhost:${actualPort}${actualPort !== port ? `  (preferred ${port} was taken)` : ''}`);
  console.log(`frontend: https://bakapiano.github.io/cssm/v1/`);
  console.log(`logs:     ${LOG}`);

  // First-run hint — printed once, then a marker file makes us quiet.
  const firstRunMark = path.join(HOME, '.first-run-shown');
  if (!fs.existsSync(firstRunMark)) {
    try { fs.writeFileSync(firstRunMark, new Date().toISOString()); } catch {}
    console.log('');
    console.log('First run · ccsm is now running in the background.');
    console.log('Open the frontend URL above, click "Install ccsm" in your browser');
    console.log('to install it as a PWA so the icon launches directly into the app.');
  }
})().catch((err) => {
  console.error('ccsm launcher failed:', err);
  process.exit(1);
});
