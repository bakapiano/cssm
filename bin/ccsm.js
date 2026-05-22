#!/usr/bin/env node
'use strict';

// ccsm launcher · entry point for `ccsm` / `npx @bakapiano/ccsm`.
// Two responsibilities:
//
//   1. If a ccsm server is already running on this machine, just ask it
//      to spawn another browser window and exit. The caller's terminal
//      returns to a prompt immediately.
//
//   2. Otherwise, spawn server.js detached (stdio → ~/.ccsm/server.log),
//      poll /api/health until it's up, print the URL and exit. The
//      detached server then opens the browser itself and ties its
//      lifetime to that window (existing behavior in server.js).

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

(async () => {
  const port = loadPreferredPort();

  // Case 1: existing instance on the preferred port
  const existing = await probe(port);
  if (existing) {
    const opened = await post(port, '/api/spawn-browser');
    console.log(`ccsm already running · v${existing.version} · http://localhost:${port}`);
    if (!opened) console.log('(could not open a new window — server might be busy)');
    return;
  }

  // Case 2: spawn detached server
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] ccsm starting...\n`);

  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, CCSM_LAUNCHER: '1' },
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
  console.log(`ccsm started · v${ready.version} · http://localhost:${actualPort}`);
  if (actualPort !== port) console.log(`(preferred port ${port} was taken)`);
  console.log(`logs: ${LOG}`);
})().catch((err) => {
  console.error('ccsm launcher failed:', err);
  process.exit(1);
});
