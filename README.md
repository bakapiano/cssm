# ccsm — Claude Code Session Manager

A single pane over every live Claude Code session on your machine.
Hosted web UI + tiny local Node daemon. Windows-first; cross-platform
in progress.

[![open](https://img.shields.io/badge/open-bakapiano.github.io%2Fccsm%2Fv1-1a1815?style=flat-square)](https://bakapiano.github.io/ccsm/v1/)

```
┌── browser ─────────────────────────┐
│  https://bakapiano.github.io/ccsm/v1/   ← static frontend
└────────────┬───────────────────────┘
             │  fetch /api/*   (CORS)
             │  ws://localhost:7777/ws/*
             ▼
┌── local backend ───────────────────┐
│  ccsm (npm bin)                    │
│   ├── /api/sessions  /api/snapshot │
│   ├── /api/sessions/new (NDJSON)   │
│   ├── /ws/terminal/:id (PTY)       │
│   └── /api/health  /api/heartbeat  │
└────────────────────────────────────┘
```

## What it does

- **Lists every live Claude Code session** — title, cwd, age, PID, status. Click **Focus** to raise the wt window that's hosting it (`EnumWindows` + `SetForegroundWindow`, Alt-key trick to defeat the foreground-lock).
- **Snapshot + Restore** — every 60s the full session set is captured to `~/.ccsm/snapshot.json`. One click restores them: one fresh wt window per session, `cd` + `claude --resume`.
- **New session** — picks an unused workspace under your work-dir, clones repos with live `git clone --progress` streamed to per-repo progress bars, opens a fresh `claude` in either a wt window or an in-page xterm.js terminal.
- **Web terminal** — `node-pty` PTY + xterm.js. Runs claude inside the page instead of wt. Optional, install-failure-tolerant.
- **Favorites / labels / pagination** — pin sessions, rename them, page through history.
- **Ask Claude to find a session** — opens a claude session pre-pointed at your ccsm data dir so you can grep past conversations.

## Install

```bash
npm i -g @bakapiano/ccsm
```

This:
- puts `ccsm` on your PATH
- registers a `ccsm://` URL protocol so the hosted frontend can wake the
  backend with one click

`npx @bakapiano/ccsm` works too for a one-shot trial — the protocol still
gets registered.

## Use

```bash
ccsm                       # starts the backend, opens the frontend
```

Or just visit **https://bakapiano.github.io/ccsm/v1/** in any browser.
If the backend isn't running, you'll see a "Backend not running" banner
with a **Start ccsm** button — click it, Windows asks once whether to
open the `ccsm://` handler (check "Always allow"), and the backend
spawns silently behind the page. The page auto-reconnects in 1-2s.

### Install as PWA

In Chrome / Edge, click the install icon in the address bar (or use the
"Install ccsm" button on the **About** tab inside the app). The PWA gets
its own window, its own icon, and Window Controls Overlay so the title
bar blends into the page.

After installing, clicking the PWA icon is the new entry point — no
terminal needed.

## Defaults

| | |
|---|---|
| Port | `7777` (auto-bumps if taken) |
| Work dir | `~/ccsm-workspaces` (each subdirectory holds one or more repo clones) |
| Terminal | `wt` (Windows Terminal). Also `powershell` / `pwsh` / `cmd` / `web` (in-page xterm.js). |
| Claude command | `claude` — any alias / function / exe. Wrapped in pwsh when terminal is `wt` so PowerShell aliases like `cc` resolve. |
| Snapshot interval | 60s; last 30 kept under `~/.ccsm/snapshots/` |
| Auto-focus | on (HWND-diff across the terminal process — handles modern wt's multi-window single-process layout) |
| Repos | none by default — add through the **Configure** tab |

All of the above are editable through the **Configure** tab. State lives
at `~/.ccsm/` (override with `CCSM_HOME=<path>`). Survives upgrades and
npx cache wipes.

## Layout

```
ccsm/
├── server.js                 # Express + WebSocket; API only in prod
├── bin/ccsm.js               # launcher · detaches server, opens browser
├── scripts/
│   ├── install.js            # postinstall · registers ccsm:// (Windows)
│   └── uninstall.js          # preuninstall · cleanup
├── lib/
│   ├── sessions.js           # ~/.claude/sessions/*.json + live PID check via tasklist
│   ├── snapshot.js           # save / load / rotate / restore
│   ├── workspace.js          # workspace = subfolder under workDir
│   ├── launcher.js           # spawn wt / pwsh / cmd
│   ├── focus.js              # PowerShell + Win32 EnumWindows / SetForegroundWindow
│   ├── webTerminal.js        # in-process PTY pool · node-pty + WebSocket bridge
│   ├── config.js / favorites.js / labels.js / jsonStore.js
└── public/                   # Preact + HTM + signals (no build step) — also pushed to GH Pages
    ├── js/
    │   ├── backend.js        # httpBase() / wsBase() — same-origin local, cross-origin GH Pages
    │   ├── main.js · state.js · api.js · streaming.js · actions.js · dialog.js · toast.js · util.js · icons.js
    │   ├── components/       # Sidebar, PageHead, Card, SessionsTable, RecentTable, FavoritesTable, TerminalView, NewSessionModal, OfflineBanner …
    │   └── pages/            # SessionsPage, LaunchPage, TerminalsPage, ConfigurePage, AboutPage
    └── css/                  # 12 focused stylesheets (tokens, base, layout, sidebar, cards, tables, forms, widgets, feedback, modal, terminals, wco, responsive)

~/.ccsm/                       # or $CCSM_HOME
├── config.json               # source of truth
├── snapshot.json             # latest auto-snapshot
├── snapshots/                # rotating history
├── favorites.json · labels.json
├── server.log                # detached-server stdout/stderr
└── .first-run-shown          # marker so we only print the PWA-install hint once
```

## How "wake on click" works

The hosted frontend (https://bakapiano.github.io/ccsm/v1/) lives entirely
in the browser sandbox — it cannot spawn processes. So when the backend
is down, the OfflineBanner's **Start ccsm** is a plain
`<a href="ccsm://start">`. The OS hands that off to a per-user URL
protocol handler we registered at install time:

```
HKCU\Software\Classes\ccsm\shell\open\command
  → wscript.exe "<LOCALAPPDATA>\ccsm\launcher.vbs" "%1"
```

The `.vbs` calls `ccsm.cmd "ccsm://start"` with `WindowStyle = 0`. That
gets to `bin/ccsm.js`, which parses the protocol URL, spawns `server.js`
detached, and exits. Zero windows ever flash.

First click triggers a one-time Windows dialog ("Open ccsm.cmd?"). Tick
**Always allow** and future clicks are silent.

## Lifecycle (when does the backend die)

| trigger | reaction |
|---|---|
| The auto-opened browser window closes | wait 12s · if any other client heartbeats during that window, stay alive; otherwise gracefulShutdown |
| No heartbeat for 90s | gracefulShutdown |
| `POST /api/shutdown` | gracefulShutdown |
| SIGINT / SIGTERM | gracefulShutdown |

Every gracefulShutdown saves a final snapshot before exit.

## Dev

```bash
git clone https://github.com/bakapiano/ccsm
cd cssm
npm install
node server.js
# opens http://localhost:7777 with hot-reload (public/ is served locally
# and SSE pushes a reload event on every file save)
```

Dev mode is detected via `__dirname.includes('node_modules')` — when
running from a checkout, the backend also serves `public/`. In an
npm-installed copy it's API-only, and you use the hosted frontend.

The frontend can also be loaded from GH Pages even in dev — it'll just
talk to the same `localhost:7777` backend. Useful for testing the
cross-origin path.

## Versioning (frontend ↔ backend)

The hosted frontend lives at a versioned path (`/v1/`). Future breaking
API changes ship a fresh `/v2/` while `/v1/` keeps serving. Each frontend
build feature-detects via `/api/capabilities`, so a slightly older
backend still works as long as it advertises the needed feature.

```
https://bakapiano.github.io/ccsm/v1/   ← current
https://bakapiano.github.io/ccsm/v2/   ← future, when /api breaking-changes
```

Installed PWAs are pinned to whichever path they were installed from.

## Status

- Backend: Windows-first. macOS / Linux backend ports planned (focus
  management, terminal spawning, and the protocol-handler registration
  are the only platform-specific pieces).
- Frontend: cross-platform (pure web).

See [CLAUDE.md](CLAUDE.md) for design decisions and the non-obvious
gotchas baked into the launcher / focus / snapshot code.
