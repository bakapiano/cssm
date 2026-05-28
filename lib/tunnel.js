'use strict';

// Tunnel manager · spawns and supervises a cloudflared or devtunnel
// child to expose the local ccsm backend over a public URL. Captures
// the URL from stdout, exposes state to the API, and tears down the
// child on stop / server shutdown.
//
// Two providers, each with their own CLI quirk:
//   cloudflared · `cloudflared tunnel --url http://localhost:<port>`
//                 Prints `https://*.trycloudflare.com` somewhere in
//                 the boot banner. No login required for quick tunnels.
//   devtunnel   · `devtunnel host -p <port> --allow-anonymous`
//                 Prints `Connect via browser: https://*.devtunnels.ms`.
//                 Host must be logged in (`devtunnel user login`).
//
// Discovery: scan PATH first via `where.exe`, then known winget install
// dirs. Returns the absolute path so we can spawn the child regardless
// of whether the post-install PATH refresh has reached this Node process.

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const PROVIDERS = {
  cloudflared: {
    id: 'cloudflared',
    label: 'Cloudflare Tunnel',
    wingetId: 'Cloudflare.cloudflared',
    binary: 'cloudflared.exe',
    knownPaths: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    ],
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`],
    urlRegex: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  },
  devtunnel: {
    id: 'devtunnel',
    label: 'Microsoft Dev Tunnel',
    wingetId: 'Microsoft.devtunnel',
    binary: 'devtunnel.exe',
    knownPaths: [
      path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages',
        'Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe', 'devtunnel.exe'),
    ],
    args: (port) => ['host', '-p', String(port), '--allow-anonymous'],
    // devtunnel sometimes prints two URL forms for the same tunnel:
    //   https://<id>.<region>.devtunnels.ms:<port>     ← port as suffix
    //   https://<id>-<port>.<region>.devtunnels.ms     ← port baked into
    //                                                    the subdomain
    // The plain `<id>.<region>` form (without a `:<port>` suffix) is
    // unreachable — browsers default to 443 and the tunnel serves
    // nothing there, so we get a 404. We always want the subdomain-
    // port form. Force the regex to require `-<digits>` in the
    // subdomain so the bare form (which our old greedy match would
    // capture first) gets skipped.
    urlRegex: /https:\/\/[a-z0-9]+-\d+\.[a-z0-9-]+\.devtunnels\.ms/i,
    needsLogin: true,
  },
};

// In-memory state. Single tunnel at a time — switching providers tears
// down the old one first.
let current = null;   // { provider, child, url, startedAt, log: string[] }
let token = null;     // Remote-access bearer token. Null = no remote
                      // access enforced. Set via setToken() or by the
                      // start() call. Server.js middleware reads via
                      // getToken().

function getToken() { return token; }
function setToken(t) { token = t ? String(t) : null; return token; }

async function findBinary(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  // PATH lookup via where.exe — works regardless of how the CLI got
  // installed (winget, choco, manual, in-tree). windowsHide stops the
  // conhost window from flashing.
  try {
    const { stdout } = await execFileP('where.exe', [p.binary], { windowsHide: true });
    const out = String(stdout).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* not on PATH */ }
  // Fall back to known install locations (winget's PATH update doesn't
  // reach the already-running Node process).
  for (const candidate of p.knownPaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  // For devtunnel: winget's package dir has a version suffix that
  // changes between releases. Glob it.
  if (provider === 'devtunnel') {
    const base = path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of fs.readdirSync(base)) {
        if (entry.startsWith('Microsoft.devtunnel_')) {
          const candidate = path.join(base, entry, 'devtunnel.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return null;
}

async function getVersion(provider, exe) {
  try {
    const { stdout } = await execFileP(exe, ['--version'], { windowsHide: true });
    return String(stdout).trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

async function checkDevtunnelLogin(exe) {
  try {
    const { stdout } = await execFileP(exe, ['user', 'show'], { windowsHide: true, timeout: 5000 });
    // "Logged in as <email> using <provider>." vs "Not logged in"
    const m = String(stdout).trim().match(/Logged in as (\S+)/);
    if (m) return { loggedIn: true, user: m[1] };
    return { loggedIn: false, user: null };
  } catch {
    return { loggedIn: false, user: null };
  }
}

// Probe is cached. Each cold call shells out 4-6 sync execs (where.exe,
// --version per provider, `devtunnel user show`) — cumulatively ~1s of
// blocked event loop on Windows. The Remote page polls /api/tunnel/status
// every 2.5s, and tunnel.start() returns a fresh status() — without this
// cache, the loop is frozen ~40% of the time during normal operation,
// and /api/health probes from other clients time out.
const PROBE_TTL_MS = 30_000;
let probeCache = null;
let probeCacheAt = 0;

async function probe(force = false) {
  if (!force && probeCache && Date.now() - probeCacheAt < PROBE_TTL_MS) {
    return probeCache;
  }
  // All providers in parallel; within each, --version and the
  // devtunnel `user show` check run together too. Cold probe drops
  // from ~1.5s serial to ~700ms (capped by the slowest exec —
  // typically `devtunnel user show`).
  const ids = Object.keys(PROVIDERS);
  const results = await Promise.all(ids.map(async (id) => {
    const exe = await findBinary(id);
    const p = { installed: !!exe, exe, version: null };
    if (exe) {
      const tasks = [getVersion(id, exe)];
      if (id === 'devtunnel') tasks.push(checkDevtunnelLogin(exe));
      const [version, devUser] = await Promise.all(tasks);
      p.version = version;
      if (devUser) Object.assign(p, devUser);
    }
    return [id, p];
  }));
  probeCache = Object.fromEntries(results);
  probeCacheAt = Date.now();
  return probeCache;
}

// Invalidate the cache when callers know the on-disk state likely changed
// (post-install, post-login, etc.). Next probe() re-shells.
function invalidateProbe() { probeCache = null; probeCacheAt = 0; }

async function status() {
  return {
    providers: await probe(),
    running: !!current,
    provider: current?.provider || null,
    url: current?.url || null,
    startedAt: current?.startedAt || null,
    pid: current?.child?.pid || null,
    log: current?.log?.slice(-50) || [],
    token,
    // Token is echoed back so the Remote page can render the
    // pre-built share URL. The route itself is token-protected
    // (the middleware blocks non-loopback callers without it), so
    // anyone reaching this endpoint already knows the token.
  };
}

// Spawn the tunnel CLI. Resolves once we've parsed the public URL out
// of stdout (with a timeout safety net). Throws if the CLI isn't
// installed, the provider is unknown, or another tunnel is running.
async function start({ provider, port }) {
  if (current) throw new Error('tunnel already running');
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const exe = await findBinary(provider);
  if (!exe) throw new Error(`${p.label} is not installed`);
  if (provider === 'devtunnel') {
    const { loggedIn } = await checkDevtunnelLogin(exe);
    if (!loggedIn) throw new Error('devtunnel requires login — run `devtunnel user login` first');
  }

  const args = p.args(port);
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const entry = { provider, child, url: null, startedAt: Date.now(), log: [] };
  current = entry;

  const pushLog = (line) => {
    entry.log.push(line);
    if (entry.log.length > 200) entry.log.shift();
    if (!entry.url) {
      const m = line.match(p.urlRegex);
      if (m) entry.url = m[0];
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));
  child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));

  child.on('exit', (code, signal) => {
    if (current === entry) current = null;
    console.log(`[tunnel] ${provider} exited · code=${code} signal=${signal || ''}`);
  });
  child.on('error', (err) => {
    if (current === entry) current = null;
    console.error(`[tunnel] ${provider} spawn error`, err);
  });

  // Wait up to 25s for the URL to show up in stdout.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (entry.url) return await status();
    if (!current || current !== entry) {
      throw new Error('tunnel exited before reporting a URL · ' + entry.log.slice(-3).join(' / '));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Timed out — keep the child alive (the URL might appear later) but
  // tell the caller we don't have one yet.
  return await status();
}

function stop() {
  if (!current) return false;
  try { current.child.kill(); } catch {}
  current = null;
  return true;
}

// Background install via winget. Returns immediately with the spawned
// pid; the actual install completes asynchronously. Caller polls
// probe() to learn when the binary appears on disk.
function installViaWinget(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (process.platform !== 'win32') throw new Error('winget install only supported on Windows');
  const child = spawn('winget', [
    'install', p.wingetId,
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--silent',
  ], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return { provider, pid: child.pid };
}

module.exports = {
  PROVIDERS,
  probe,
  status,
  start,
  stop,
  installViaWinget,
  getToken,
  setToken,
};
