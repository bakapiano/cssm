# ccsm — Claude Code Session Manager

A small Node/Express + Preact web tool that gives a single pane over all
live Claude Code sessions on this machine, snapshots them, restores them
through Windows Terminal, and launches new sessions inside isolated
workspaces.

## Why this exists

When you're running 8–10 concurrent `claude` sessions across ad-hoc
clones (`D:\proj`, `D:\proj2`, `…`, plus GUID worktree dirs), it's easy
to lose track of which terminal is which session. ccsm gives an
at-a-glance list and a snapshot/restore safety net.

## Architecture: hosted frontend + local backend

The single most important fact about ccsm v0.8+ is that **the frontend
is no longer bundled into the npm package** in production. It lives at
`https://bakapiano.github.io/cssm/v1/`, served by GitHub Pages, deployed
via the workflow at `.github/workflows/deploy-pages.yml`.

```
┌── browser ────────────────────────────┐
│  https://bakapiano.github.io/cssm/v1/    ← static frontend
└────────────┬──────────────────────────┘
             │  fetch /api/*   (CORS, allow-list)
             │  ws://localhost:7777/ws/*
             ▼
┌── local backend ──────────────────────┐
│  npm i -g @bakapiano/ccsm             │
│  ccsm                                  │
│   ├── /api/sessions  /api/snapshot    │
│   ├── /api/sessions/new (NDJSON)      │
│   ├── /ws/terminal/:id (PTY)          │
│   ├── /api/heartbeat /api/spawn-browser│
│   └── /api/health /api/shutdown       │
└───────────────────────────────────────┘
```

Why this split:
- Frontend can be updated independently — push to `main`, CI rebuilds GH Pages, every user hot-refreshes.
- No service worker complexity needed for "PWA loads even when backend is dead". The page itself is on GH Pages; the backend going down only loses `/api/*`, and the page handles that gracefully with an OfflineBanner.
- Cross-platform path forward — backend can be ported per-OS, but the frontend never has to be.
- Versioned at `/v1/` so future breaking changes ship a fresh `/v2/` while `/v1/` keeps serving the older clients.

In **dev mode** (running from a checkout — `__dirname` not under
`node_modules`), the backend ALSO serves `public/` so contributors can
iterate at `localhost:7777/` without pushing.

## Run

```powershell
# install once
npm install -g @bakapiano/ccsm

# then anywhere
ccsm
```

`ccsm` opens the hosted frontend in a chromeless Edge `--app=` window.
Terminal returns immediately (the server is spawned detached). Close
the window → server saves a final snapshot and exits within ~12s.

If you don't want the auto-opened window (e.g. you live in the PWA),
just visit `https://bakapiano.github.io/cssm/v1/` — when backend is
down you see an OfflineBanner with a **Start ccsm** button.

Default port `7777`, default workDir `~/ccsm-workspaces`. Config +
snapshots live at `~/.ccsm/` (override with `CCSM_HOME=<path>`). All
settings editable through the Configure panel
(`~/.ccsm/config.json` on disk). Notable knobs:

- `port` (default `7777`) — preferred listen port. If taken, ccsm tries `+1..+9` then asks the OS for any free port. The startup log prints the actual URL.
- `browserMode` (default `app`) — `app` finds Edge or Chrome and spawns it with `--app=<url> --user-data-dir=<DATA_DIR>/browser-profile`. `tab` opens the default browser. `none` skips opening.
- `claudeCommand` (default `"claude"`) — what gets `--resume`'d or freshly invoked. Can be an exe, alias, function, or wrapper script.
- `terminal` — `wt` | `powershell` | `pwsh` | `cmd`. wt opens a fresh window per launch (`wt -w new`).
- `commandShell` (default `pwsh`) — only consulted when `terminal=wt`. Wraps `claudeCommand` in `pwsh -NoExit -NoLogo -Command ...` so PowerShell aliases resolve.
- `autoFocusOnLaunch` (default true) — after every launch (new session, finder, resume, restore) the server takes an HWND snapshot of terminal windows, polls for a new HWND, and `SetForegroundWindow`s it.
- `finderPrompt` — initial message passed to the "Ask Claude to find a session" finder session.

## ccsm:// protocol · "wake on click"

The hosted frontend can't spawn processes (sandboxed). For "click to
wake backend" we register a per-user URL protocol handler on Windows:

```
HKCU\Software\Classes\ccsm\shell\open\command
  → wscript.exe "<LOCALAPPDATA>\ccsm\launcher.vbs" "%1"
```

`launcher.vbs` uses `Shell.Run(..., 0, False)` — windowstyle 0 means the
spawned `ccsm.cmd` runs **completely hidden**. No console flash. The
`.cmd` goes through `bin/ccsm.js`, which detects `ccsm://start` in argv,
spawns `server.js` detached with `CCSM_NO_BROWSER=1`, and exits.

OfflineBanner's "Start ccsm" button is just an `<a href="ccsm://start">`.
First click triggers a one-time Windows confirmation dialog ("Open
ccsm.cmd?"); ticking "Always allow" makes it silent thereafter.

postinstall (`scripts/install.js`) registers the protocol unconditionally
on Windows — including npx-cache installs. The path stored in the
registry points at whatever `ccsm.cmd` location npm gave us
(`<prefix>/ccsm.cmd` from `npm config get prefix`).

## Lifecycle

Single `gracefulShutdown(reason)` function in `server.js` is the only
exit path. It races `saveSnapshot()` against a 2s timeout, kills any
PTY children, then `process.exit(0)`. Every trigger funnels here:

| trigger | path |
|---|---|
| auto-spawned browser window closes | `child.on('exit')` — see smart-kill below |
| `POST /api/shutdown` | from npm uninstall, from launcher's auto-upgrade |
| SIGINT / SIGTERM | OS signals |
| heartbeat watchdog timeout | 90s with no heartbeat, only when launched via `bin/ccsm.js` |

**Smart browser-exit**: when the spawned browser child dies, we don't
kill immediately. Two filters:

1. **Fast-exit (<5s)** — Edge `--app=` often hands the URL off to an
   existing Edge profile process group and the spawned child dies
   milliseconds after creation. We ignore any exit inside the first 5s.

2. **Deferred multi-client check (12s)** — after a real close, wait 12s
   and check if any heartbeat arrived AFTER the close timestamp. If
   yes, a hosted-frontend tab (or another window) is keeping us busy,
   stay alive. If no, gracefulShutdown.

Frontend heartbeat cadence is 10s (in `main.js`), so one full cycle
fits inside the 12s decision window.

Environment overrides:
- `CCSM_KEEP_ALIVE=1` → disable both browser-exit hook and heartbeat watchdog. For automation hosts.
- `CCSM_LAUNCHER=1` → set by `bin/ccsm.js` when it spawns the server; enables the heartbeat watchdog.
- `CCSM_NO_BROWSER=1` → set by the launcher when handling a `ccsm://` click; suppresses the server's auto-open browser.
- `CCSM_NO_DEV=1` → suppress dev-mode features (static serving, hot-reload SSE) even when running from a checkout.

## Layout

```
ccsm/
├── server.js                     # Express + WebSocket; API-only in prod
├── bin/ccsm.js                   # launcher · detach, wake-on-protocol,
│                                 # auto-upgrade-restart, first-run hint
├── scripts/
│   ├── install.js                # postinstall · ccsm:// + launcher.vbs
│   └── uninstall.js              # preuninstall · cleanup + /api/shutdown
├── lib/
│   ├── sessions.js               # ~/.claude/sessions/*.json + tasklist PID check
│   ├── snapshot.js               # save / load / rotate / restore
│   ├── workspace.js              # workspace = folder under workDir
│   ├── launcher.js               # spawn wt / pwsh / cmd
│   ├── focus.js                  # PowerShell + Win32 EnumWindows / SetForegroundWindow
│   ├── webTerminal.js            # in-process PTY pool · node-pty + WebSocket bridge
│   ├── favorites.js · labels.js  # pinned sessions / rename overrides
│   ├── jsonStore.js              # shared keyed-JSON store factory
│   └── config.js                 # loadConfig / saveConfig
└── public/                       # Preact + HTM + signals (no build step) — also pushed to GH Pages /v1/
    ├── index.html                # relative paths so it works at any host path
    ├── manifest.webmanifest      # PWA · relative start_url, WCO display override
    ├── favicon.svg
    ├── js/
    │   ├── backend.js            # httpBase() / wsBase() — same-origin local, cross-origin hosted
    │   ├── main.js               # boot · clock tick · heartbeat · is-app body class
    │   ├── state.js              # signals
    │   ├── api.js                # fetch wrapper + loaders
    │   ├── streaming.js          # NDJSON clone-progress stream
    │   ├── actions.js            # focus / resume / favorite / rename
    │   ├── dialog.js · toast.js  # ccsmConfirm / ccsmPrompt / setToast
    │   ├── html.js · icons.js · util.js
    │   ├── components/
    │   │   ├── App.js · Sidebar.js · PageHead.js · Footer.js
    │   │   ├── ServerStatus.js · Toast.js · Fab.js · OfflineBanner.js
    │   │   ├── Card.js · Pagination.js · TitleCell.js
    │   │   ├── SessionsTable.js · RecentTable.js · FavoritesTable.js
    │   │   ├── RepoPicker.js · ReposEditor.js · WorkspacePicker.js
    │   │   ├── WorkspacesGrid.js · SnapshotPanel.js · ProgressList.js
    │   │   ├── TerminalView.js · NewSessionModal.js
    │   │   └── DialogHost.js
    │   └── pages/
    │       ├── SessionsPage.js · LaunchPage.js
    │       ├── TerminalsPage.js
    │       ├── ConfigurePage.js · AboutPage.js
    └── css/                      # 13 focused stylesheets
        ├── tokens.css · base.css · layout.css
        ├── sidebar.css · cards.css · tables.css · forms.css
        ├── widgets.css · feedback.css · modal.css
        ├── terminals.css · wco.css · responsive.css

~/.ccsm/                          # or $CCSM_HOME
├── config.json                   # source of truth
├── snapshot.json                 # latest auto-snapshot
├── snapshots/                    # rotating history (default keep=30)
├── favorites.json · labels.json  # pinned / renamed sessions
├── server.log                    # detached-server stdout/stderr
├── .first-run-shown              # marker so launcher only prints PWA hint once
└── browser-profile/              # Edge/Chrome --user-data-dir when browserMode=app

%LOCALAPPDATA%/ccsm/
└── launcher.vbs                  # silent ccsm:// dispatcher (written by postinstall)

HKCU\Software\Classes\ccsm        # URL protocol registration
```

On first run, if a legacy `<repo>/data/` directory exists and `~/.ccsm/`
is empty, `lib/config.js` copies the old data over (one-time,
idempotent).

## Locked-in design decisions

**Workspace = folder holding multiple repo clones.** Each `ws-N` under
`workDir` contains a subdirectory per cloned repo. Claude launches at
the workspace root so all selected repos are sibling folders. "One repo
per workspace" was explicitly rejected.

**wt: one window per session, not stacked tabs.** Both
`/api/snapshot/restore` and `/api/sessions/new` open a fresh `wt`
window. "Stacked tabs via `-w 0 nt`" was explicitly rejected.

**"In use" detection.** A workspace is in use iff any live Claude
session's cwd is at-or-inside the workspace path (case-insensitive
Windows compare via `path.resolve().toLowerCase()`).

**Workspace naming.** Auto-allocated names are `ws-1`, `ws-2`, …
(lowest free integer). Hand-named folders under `workDir` are still
picked up.

**Frontend trusts the backend's capability advertisement.**
`/api/capabilities` returns `{ webTerminal: true|false, ... }`. The
frontend uses ONLY features the backend says it has. Future breaking
changes ship a fresh `/v2/` frontend path; old `/v1/` still works
against backends that advertise the v1 contract.

**One source of truth for cross-origin.** `public/js/backend.js`
exports `httpBase()` and `wsBase()`. Localhost → same-origin (empty
base). Anything else → `http://localhost:7777`. CORS on the backend
allows `https://bakapiano.github.io` only — never `*`.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions` | live sessions sorted by `updatedAt` desc |
| GET | `/api/sessions/recent` | recently-used sessions from jsonl mtimes · `?limit=&offset=` |
| POST | `/api/sessions/new` | body `{repos, workspace?, terminal: 'wt'\|'web'}` — NDJSON stream |
| POST | `/api/sessions/finder` | opens a wt with `claude` in `~/.ccsm` and `finderPrompt` |
| POST | `/api/sessions/:id/resume` | body `{cwd}` — `wt -d <cwd> claude --resume <id>` |
| POST | `/api/sessions/:id/focus` | match a wt window by title, fall back to PID-parent walk |
| GET | `/api/sessions/web` | list active web-terminal PTY sessions |
| DELETE | `/api/sessions/web/:id` | kill a web-terminal PTY |
| GET / PUT | `/api/config` | read / replace config |
| GET / POST | `/api/snapshot` | latest snapshot / force-save now |
| GET | `/api/snapshot/history` | rotated history filenames |
| POST | `/api/snapshot/restore` | launch one wt window per session in snapshot |
| GET | `/api/workspaces` | workspaces under workDir with repo clone status + in-use flag |
| GET | `/api/favorites` · POST/DELETE `/api/favorites/:id` | star / unstar |
| GET | `/api/labels` · PUT/DELETE `/api/labels/:id` | rename / clear override |
| GET | `/api/terminals` | enumerate built-in terminal kinds |
| GET | `/api/capabilities` | `{ webTerminal: bool, ... }` for frontend feature gating |
| GET | `/api/health` | sanity ping + version |
| POST | `/api/heartbeat` | called every 10s by the frontend; feeds lifecycle decisions |
| POST | `/api/spawn-browser` | open another Edge window into the running server |
| POST | `/api/shutdown` | gracefulShutdown — used by uninstall + auto-upgrade |
| WS | `/ws/terminal/:id` | xterm.js bridge to a PTY in the webTerminal pool |
| GET (dev) | `/api/dev/ping` · `/api/dev/reload` | hot-reload SSE (only when running from a checkout) |

`/api/sessions/new` streams **NDJSON** (one JSON object per line). Event
types: `workspace`, `clone-start`, `clone-progress` (phase/percent/
current/total/detail), `clone-line` (raw git stderr line when not a
progress line), `clone-end`, `launched`, `done`. The frontend reads it
with `fetch().body.getReader()` + `TextDecoder` and updates per-repo
progress bars live.

**WebSocket Origin check**: same allow-list as CORS. The upgrade handler
rejects any Origin not in `ALLOWED_ORIGINS` (plus localhost/127.0.0.1).
Browsers always send Origin on WS upgrades.

## Non-obvious gotchas

**wt.exe `-d` flag** (marker-file probes confirming `%CD%` inside the new tab):

| variant | result |
|---|---|
| `wt -d D:\ccsm <cmd>` | ✓ |
| `wt -d D:/ccsm <cmd>` | ✓ (forward slashes fine) |
| `wt --startingDirectory D:\ccsm <cmd>` | ✓ |
| `wt -d D:\ccsm\ <cmd>` (trailing sep) | ✓ |
| spawn `{ cwd: ... }` with no `-d` | ✗ wt ignores parent cwd |
| `wt -d "D:\ccsm" <cmd>` (literal quotes) | ✗ wt doesn't open |
| `wt new-tab -d D:\ccsm <cmd>` | ✗ wt doesn't open |

ccsm uses variant 1 and always `path.resolve()`s the cwd first — defends
against a malformed `D:ccsm` being interpreted as "current dir on drive
D + ccsm".

**Don't test wt launching via `node -e "..."` inside `bash -c`.** Backslashes get eaten by shell quoting and the JS string ends up malformed. Write a `.js` file and `node file.js` instead.

**focusBySession — title-based wt window matching.** Walking up the
claude.exe PID parent chain and taking `MainWindowHandle` of the wt
process *always* returns the same canonical window in modern multi-
window single-process wt — clicking different sessions all focused the
same window. `focusBySession` lists all visible wt windows
(`EnumWindows` filtered by process name), strips the leading wt status
glyph (`✳ `, `⠐ `, `⠠ ` …) and compares to the session's ai-title.
Falls back to title-substring, then cwd-basename, then the old PID-
parent walk when no unique match.

**Focus helper (`lib/focus.js`).** One `powershell.exe -EncodedCommand <base64>` invocation per call, dispatched by `CCSM_FOCUS_MODE` env var. Encoded as UTF-16-LE-base64. Three baked-in gotchas:
1. C# `out _` discard breaks PowerShell 5.1's C# compiler — use a named `uint dummy`.
2. Windows blocks background processes from `SetForegroundWindow` — synthesize an Alt-key down/up via `keybd_event 0x12` first ("Alt-key trick").
3. `ConvertTo-Json -AsArray` is PS 7+; on PS 5.1 build the JSON array manually.

**HWND-diff for auto-focus, not PID-diff.** Modern Windows Terminal is multi-window single-process: one `WindowsTerminal.exe` PID owns 8+ top-level HWNDs.

**wt `-w new`.** wt's `windowingBehavior` setting in some profiles folds new `wt …` invocations into the existing window as a tab. Force-prepending `-w new` makes wt always create a new window.

**Auto-snapshot loop.** `setInterval` in `server.js` calls
`saveSnapshot` every `snapshotIntervalMs`. The history dir grows until
`snapshotHistoryKeep` is exceeded, then oldest are pruned. AND
`gracefulShutdown` always saves one last snapshot before exit so a
restart can restore current state.

**Session listing.** `~/.claude/sessions/<pid>.json` is the source of
truth. We cross-check the `pid` field against
`tasklist /FI "IMAGENAME eq claude.exe"` so stale entries from crashed
claudes don't appear. `ai-title` is read by tailing the last 1 MB of
the matching `.jsonl` and finding the last `"type":"ai-title"` line.

**`projectSlugForCwd`.** `cwd.replace(/[:\\]/g, '-')`, e.g. `D:\ccsm` → `D--ccsm`.

**ccsm:// silent dispatch.** Direct registration of `ccsm.cmd` as the
protocol handler causes a brief console window flash (cmd hosts the
.cmd file). The wscript.exe + .vbs wrapper avoids it entirely — wscript
is a Windows-subsystem host (no console) and `Shell.Run(..., 0, False)`
launches the target hidden. The `.vbs` is generated at install time
with the correct ccsm.cmd path baked in.

**Edge --app handoff race.** When the user has an existing Edge profile
process running, `--app=URL --user-data-dir=DIR` against the same DIR
may cause the new msedge.exe to immediately exit after handing the URL
off to the existing process. Our child handle dies milliseconds after
spawn. The lifecycle hook ignores any browser-child exit inside the
first 5s for exactly this reason.

## Frontend design language

The UI deliberately copies **claude.ai's** calm light aesthetic — warm
cream surfaces, generous spacing, soft borders, **no orange highlights**.
The brand orange `#b3614a` survives only in the brand mark / wordmark
dot. Every other "highlight" use (selection, focus rings, dirty
indicators, progress bars, page-actions banner) is ink/gray.

**Palette** (CSS vars in `public/css/tokens.css`):
- `--bg`            `#faf9f5`  warm cream page background
- `--bg-elev`       `#ffffff`  card surfaces
- `--sidebar-bg`    `#faf9f5`  (same as `--bg`, single continuous surface)
- `--border`        `#e8e3d5`
- `--ink`           `#1a1815`  body text (warm near-black, also used for terminal background)
- `--ink-mid` / `--ink-muted` / `--ink-faint`
- `--accent`        `#b3614a`  desaturated terracotta — brand only
- Status: green `#4a8a4a` idle · blue `#4a73a5` busy (pulsing) · red `#b73f3f` danger
- Favorite star: `#e3b341` (gold, the only intentional non-grayscale accent in the data area)

**Type**:
- Body / headings: **Geist** (Google Fonts, 300–700).
- Mono: **JetBrains Mono** for paths, PIDs, sessionIds, branch tags.
- Always `font-variant-numeric: tabular-nums` on numeric cells.

**Buttons**:
- `.action` (default) — white bg, ink-mid border, ink text.
- `.action.primary` — black ink bg, white text. The "do this" CTA.
- `.action.subtle` — transparent bg, light border.
- `.action.danger` — filled red bg + white text (e.g. Remove repo).

**Layout**:
- Sidebar (collapsible, ~232px ↔ ~60px, state in `localStorage["ccsm.sidebar-collapsed"]`)
  - brand mark + `CCSM.` wordmark
  - 5 nav items: Sessions / Launch / Terminals / Configure / About (Terminals only shown when `capabilities.webTerminal === true`)
  - footer: Collapse toggle (chevron flips on collapse)
- Page-head: title + subtitle on the left, server-status pill + Refresh button on the right
- Top-right control group uses fixed `min-height: 28px` and `border-radius: 999px` so server-status + Refresh align as a coherent control row

**Animation**:
- Row staggered fade-in on first render. Preact's component identity prevents re-stage on auto-refresh (no `markRendered` machinery needed in v0.7+).
- Panel switch: 0.35s `panel-in` fade-up.
- Busy status mark: blue pulse via `box-shadow` keyframes.

**No emoji in the UI** unless the user typed it (e.g. wt status glyphs
in session titles). Use inline SVG icons everywhere (line stroke, 1.5–
2px) so they take `currentColor`.

**PWA + WCO**:
- `display_override: ["window-controls-overlay", "standalone"]` in
  manifest. When installed and launched as PWA, the title bar's
  middle is reclaimed; only OS controls float top-right.
- `public/css/wco.css` provides drag regions (`-webkit-app-region:
  drag` on `.sidebar-brand`, `.page-head`, etc., unconditional — Chromium
  ignores in plain tabs, honors in PWA / `--app=`). Interactive
  elements opt out via the no-drag block.
- Padding gets shuffled (`body.is-app .main / .sidebar` lose top
  padding, children compensate) so the very top of the window is
  draggable instead of being `.main`'s dead padding zone.

## Versioning

The hosted frontend lives at `/v1/`. Backend follows semver but treats
its API surface as additive:
- Patch: bug fixes, no API change.
- Minor: new endpoints, new fields on existing responses. Old frontend tolerates unknown extras.
- Major: breaking changes. New frontend at `/v2/`; old frontend at `/v1/` keeps working against backends that advertise the v1 contract via `/api/capabilities`.

`bin/ccsm.js` does auto-upgrade-restart: when the user runs `ccsm` and
the installed package version differs from a running backend, it POSTs
`/api/shutdown` to the old, waits for the port to free, then spawns a
fresh server. So `npm i -g @bakapiano/ccsm@latest && ccsm` is one
seamless step.

## Cross-platform

Today: Windows-first.

Cross-platform-clean already:
- Frontend (pure web)
- `bin/ccsm.js` (pure node)
- `lib/webTerminal.js` (node-pty handles platform)
- `lib/snapshot.js`, `lib/config.js`, `lib/jsonStore.js` (fs only)
- `server.js` Express + ws

Windows-specific (need ports for Mac/Linux):
- `scripts/install.js` — uses `reg.exe` and `wscript.exe`. Mac: write `Info.plist` with `CFBundleURLTypes`. Linux: write `~/.local/share/applications/ccsm.desktop` with `MimeType=x-scheme-handler/ccsm`.
- `lib/focus.js` — PowerShell + Win32. Mac: `osascript`. Linux: `wmctrl`.
- `lib/launcher.js` — wt/pwsh/cmd. Mac: Terminal.app via osascript. Linux: gnome-terminal etc.
- `lib/sessions.js` — `tasklist`. Mac/Linux: `ps -eo pid,comm`.

Pattern for adding a platform: `switch (process.platform)` at each
entry point in those files. Each platform branch is roughly 50-100
lines.

## Extending

When adding features, the natural extension points:
- **New REST routes**: `server.js` (keep under `/api/*`, use the `asyncH` wrapper, decide if it needs CORS by being in the allow-list).
- **Frontend page**: `public/js/pages/<Name>Page.js`, route in `App.js`, sidebar nav item in `Sidebar.js`, heading in `state.js`'s `TAB_HEADINGS`.
- **Persistent user data**: drop a JSON file under `~/.ccsm/` and use `lib/jsonStore.js`'s factory.
- **Workspace lifecycle** (delete, rename): `lib/workspace.js`.
- **Different launch modes**: `lib/launcher.js` — but check first whether the "one window per session" decision still holds.
- **A capability**: advertise via `/api/capabilities`. Frontend gates UI on `caps.<feature>`.
