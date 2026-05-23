'use strict';

// ccsm in-process PTY pool. Used by the "web terminal" launch path:
// claude (or any cmd) runs as a child of ccsm and its stdio is bridged
// to one or more WebSocket clients via xterm.js in the browser.
//
// Lifecycle: a PTY entry is created by spawn(), broadcasts every output
// chunk to all attached sockets, keeps a rolling history ring so a fresh
// connection can replay recent output. attach() wires a websocket to an
// entry, kill() ends a PTY explicitly, list() returns metadata for UI.
//
// node-pty is optional (Windows native binary). If it failed to load,
// `available` is false and spawn() throws — server.js gates the
// /api/sessions/web route on this flag so install failures degrade
// gracefully to wt-only mode.

const path = require('node:path');

let pty = null;
let loadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  loadError = e;
}

const HISTORY_BYTES = 256 * 1024;

// Map<id, { id, pty, history, sockets:Set<ws>, meta }>
const sessions = new Map();

function genId() {
  return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}



// Spawn a new PTY. `command` and `args` are passed straight to node-pty.
// `meta` is whatever the caller wants surfaced to the UI (title, cwd, etc).
// Throws if node-pty isn't available.
function spawn({ command, args = [], cwd, env, cols = 120, rows = 30, meta = {} }) {
  if (!pty) {
    const err = new Error('node-pty is not available · ' + (loadError && loadError.message || 'unknown'));
    err.code = 'PTY_UNAVAILABLE';
    throw err;
  }
  const id = genId();
  // useConpty: new ConPTY API (Win10 1809+). node-pty defaults this true on
  // Windows, but spell it out so we know we're on the modern path.
  // useConptyDll: opt-in to the newest, separately-versioned conpty.dll
  // (node-pty 1.0+, Windows 10 1809+ if the dll is present). This is the
  // path VSCode uses (see vscode/src/vs/platform/terminal/node/terminalProcess.ts)
  // — it has a larger stdin buffer and doesn't split bracketed-paste
  // payloads across multiple child-process reads, so claude code's
  // [Pasted text] chip detection actually fires.
  const ptyOpts = {
    name: 'xterm-256color',
    cols, rows,
    cwd: cwd ? path.resolve(cwd) : process.cwd(),
    env: { ...process.env, ...(env || {}) },
  };
  if (process.platform === 'win32') {
    ptyOpts.useConpty = true;
    ptyOpts.useConptyDll = true;
  }
  const proc = pty.spawn(command, args, ptyOpts);
  const entry = {
    id,
    pty: proc,
    history: '',
    sockets: new Set(),
    meta: { ...meta, startedAt: Date.now(), command, args, cwd: cwd || process.cwd(), pid: proc.pid },
    exitCode: null,
    exitedAt: null,
  };
  proc.onData((data) => {
    // Append to ring; truncate to last HISTORY_BYTES so memory stays bounded.
    entry.history = (entry.history + data);
    if (entry.history.length > HISTORY_BYTES) {
      entry.history = entry.history.slice(-HISTORY_BYTES);
    }
    const frame = JSON.stringify({ type: 'output', data });
    for (const ws of entry.sockets) {
      try { ws.send(frame); } catch {}
    }
  });
  proc.onExit(({ exitCode, signal }) => {
    entry.exitCode = exitCode;
    entry.exitedAt = Date.now();
    const frame = JSON.stringify({ type: 'exit', code: exitCode, signal });
    for (const ws of entry.sockets) {
      try { ws.send(frame); } catch {}
    }
    // Keep the entry around briefly so a reconnecting client can see the
    // exit code + final transcript, then drop it. 30s is enough for a UI
    // re-render but won't hoard memory forever.
    setTimeout(() => sessions.delete(id), 30_000);
  });
  sessions.set(id, entry);
  return entry;
}

// Wire a websocket to a session. Replays history immediately so the
// client sees recent context; then forwards input/resize messages from
// the client to the PTY and broadcast outputs back via onData above.
function attach(id, ws) {
  const entry = sessions.get(id);
  if (!entry) {
    try { ws.close(4404, 'no such terminal'); } catch {}
    return;
  }
  entry.sockets.add(ws);
  if (entry.history) {
    try { ws.send(JSON.stringify({ type: 'output', data: entry.history })); } catch {}
  }
  if (entry.exitedAt) {
    try { ws.send(JSON.stringify({ type: 'exit', code: entry.exitCode })); } catch {}
  } else {
    try { ws.send(JSON.stringify({ type: 'attached', meta: entry.meta })); } catch {}
  }

  ws.on('message', (msg) => {
    let event;
    try { event = JSON.parse(msg.toString()); } catch { return; }
    if (entry.exitedAt) return;  // PTY is dead, ignore further input
    switch (event.type) {
      case 'input':
        if (typeof event.data === 'string') {
          if (process.env.CCSM_DEBUG_PASTE === '1') {
            const d = event.data;
            const hex = Buffer.from(d, 'utf8').toString('hex').match(/.{1,2}/g).join(' ');
            console.log(`[pty.write id=${id}] len=${d.length} hex=${hex.slice(0, 400)}${hex.length > 400 ? '...' : ''}`);
          }
          entry.pty.write(event.data);
        }
        break;
      case 'resize':
        if (Number(event.cols) > 0 && Number(event.rows) > 0) {
          try { entry.pty.resize(Number(event.cols), Number(event.rows)); } catch {}
        }
        break;
      case 'kill':
        kill(id);
        break;
    }
  });

  ws.on('close', () => {
    entry.sockets.delete(ws);
  });
}

function kill(id) {
  const entry = sessions.get(id);
  if (!entry || entry.exitedAt) return false;
  try { entry.pty.kill(); } catch {}
  return true;
}

// Public summary for the frontend. Don't leak the pty / sockets objects.
function describe(entry) {
  return {
    id: entry.id,
    meta: entry.meta,
    attached: entry.sockets.size,
    exitedAt: entry.exitedAt,
    exitCode: entry.exitCode,
  };
}

function list() {
  return Array.from(sessions.values()).map(describe);
}

function get(id) {
  const e = sessions.get(id);
  return e ? describe(e) : null;
}

function killAll() {
  for (const e of sessions.values()) {
    try { e.pty.kill(); } catch {}
  }
}

module.exports = {
  available: !!pty,
  loadError,
  spawn,
  attach,
  kill,
  list,
  get,
  killAll,
};
