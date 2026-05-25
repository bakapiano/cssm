#!/usr/bin/env node
'use strict';

// In-app upgrade helper · spawned detached by /api/upgrade.
//
// The previous implementation kicked off `npm i -g` directly from the
// running server. On Windows that fails with EBUSY: npm tries to rename
// the package directory but the server has files open inside it.
//
// This script breaks the cycle:
//
//   1. Server validates the upgrade request, spawns this helper detached
//      with [target, port, pid] argv, sends 200 OK, then gracefulShutdowns.
//   2. Helper waits for the old port to free up + the old pid to die.
//   3. Helper runs `npm i -g @bakapiano/ccsm@<target>` synchronously.
//   4. On success it spawns `ccsm` detached (which spins up the new
//      backend on the same port) and exits.
//
// Logs everything to ~/.ccsm/upgrade.log so a failed upgrade is
// debuggable without the user needing to re-run the command manually.
//
// Argv: node upgrade-helper.js <target> <port> <pid> [installPrefix] [respawn=1|0]
// - installPrefix: when set, runs `npm i -g --prefix=<this>` so the
//   global install can be redirected to a sandbox dir for testing
//   against a live prod install without disturbing it. Respawn then
//   uses <prefix>/ccsm.cmd (Windows) or <prefix>/bin/ccsm (posix).
// - respawn: '0' skips the final ccsm respawn (also useful for tests).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const target = process.argv[2] || 'latest';
const oldPort = Number(process.argv[3] || 7777);
const oldPid = Number(process.argv[4] || 0);
const installPrefix = process.argv[5] || '';
const doRespawn = process.argv[6] !== '0';

const HOME = process.env.CCSM_HOME || path.join(os.homedir(), '.ccsm');
const LOG = path.join(HOME, 'upgrade.log');
try { fs.mkdirSync(HOME, { recursive: true }); } catch {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Returns true once nothing answers on host:port within timeoutMs.
function portFree(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const finish = (free) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(free); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(false));
    s.once('timeout', () => finish(true));
    s.once('error', () => finish(true));
    s.connect(port, '127.0.0.1');
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

(async () => {
  log(`start · target=${target} oldPort=${oldPort} oldPid=${oldPid}${installPrefix ? ` prefix=${installPrefix}` : ''}${!doRespawn ? ' (no respawn)' : ''}`);

  // Wait up to 30s for the old server to be gone. Both port-free AND
  // pid-dead so we don't fight npm's rename for a stale file handle.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const free = await portFree(oldPort);
    const dead = !pidAlive(oldPid);
    if (free && dead) break;
    await sleep(250);
  }
  log(`old server gone (or 30s elapsed) · running npm install`);

  // npm.cmd is a batch wrapper on Windows; spawn it via cmd.exe /c so
  // we don't need shell:true (which would mean argv quoting). target
  // has already been regex-validated server-side so this is safe.
  const isWin = process.platform === 'win32';
  const arg = `@bakapiano/ccsm@${target}`;
  const npmArgs = ['i', '-g'];
  if (installPrefix) {
    try { fs.mkdirSync(installPrefix, { recursive: true }); } catch {}
    npmArgs.push(`--prefix=${installPrefix}`);
  }
  npmArgs.push(arg);
  let r;
  if (isWin) {
    r = spawnSync(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'npm', ...npmArgs],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } else {
    r = spawnSync('npm', npmArgs,
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const stdout = r.stdout?.toString().trim();
  const stderr = r.stderr?.toString().trim();
  log(`npm exit=${r.status}${stdout ? `\nSTDOUT:\n${stdout}` : ''}${stderr ? `\nSTDERR:\n${stderr}` : ''}`);
  if (r.status !== 0) {
    log(`upgrade failed · not respawning`);
    process.exit(1);
  }

  if (!doRespawn) {
    log(`respawn skipped (respawn=0)`);
    return;
  }

  // Respawn ccsm. With installPrefix the binary lives there; otherwise
  // it's on PATH from the global npm install. The launcher handles
  // detect-or-spawn-server and detaches.
  //
  // On Windows, CreateProcess refuses to spawn .cmd / .bat directly —
  // they're cmd.exe scripts, not native exes. Route through cmd.exe /c
  // so it loads the wrapper.
  const ccsmCmd = installPrefix
    ? (isWin ? path.join(installPrefix, 'ccsm.cmd') : path.join(installPrefix, 'bin', 'ccsm'))
    : (isWin ? 'ccsm.cmd' : 'ccsm');
  const childEnv = { ...process.env, CCSM_NO_BROWSER: '1' };
  let exe, exeArgs;
  if (isWin) {
    exe = process.env.ComSpec || 'cmd.exe';
    exeArgs = ['/d', '/s', '/c', ccsmCmd];
  } else {
    exe = ccsmCmd;
    exeArgs = [];
  }
  try {
    const child = spawn(exe, exeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: childEnv,
    });
    child.unref();
    log(`respawned ${ccsmCmd} (via ${path.basename(exe)})`);
  } catch (e) {
    log(`respawn failed: ${e.message}`);
    process.exit(1);
  }
})().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
