# ccsm — Claude Code Session Manager

A small web UI + Node server (Windows-only) that:

- Lists every live Claude Code session on the machine, sorted by last active time, with title / cwd / age / PID and a one-click **focus** button that raises the already-open wt window (via `EnumWindows` + `SetForegroundWindow` with the Alt-key trick) and a **resume new** button that opens a fresh `wt -d <cwd> claude --resume <id>`.
- Snapshots the full session set every minute (`data/snapshot.json` + rotated history under `data/snapshots/`). One click **restores** the snapshot — one new wt window per session, `cd` + `claude --resume`.
- **New session** picks an unused workspace under your work directory, clones the repos you selected (streaming live `git clone --progress` to a per-repo progress bar in the UI), then opens a fresh terminal window running `claude` (or whichever command you set).
- **Ask Claude to find a session** opens a Claude Code session pre-pointed at this repo so you can grep through past conversations.

## Quick start

```powershell
cd ccsm
npm install
node server.js
# open http://localhost:7777
```

## Layout

```
ccsm\
├── server.js           # Express app + 60s auto-snapshot loop
├── lib\
│   ├── sessions.js     # ~/.claude/sessions/*.json + live PID cross-check via tasklist
│   ├── snapshot.js     # save / load / rotate / restore
│   ├── workspace.js    # workspace = subfolder under workDir; clone repos with progress
│   ├── launcher.js     # dispatch across wt / powershell / pwsh / cmd
│   ├── focus.js        # PowerShell + Win32 — listWindowsOf, focusByHwnd, focusByPid
│   └── config.js       # load/save data/config.json
├── public\             # vanilla HTML/JS frontend, auto-refresh every 5s
└── data\
    ├── config.json     # source of truth, gitignored
    ├── snapshot.json   # latest auto-snapshot, gitignored
    └── snapshots\      # rotating history, gitignored
```

## Defaults

- Port: `7777`
- Work dir: `D:\ccsm-workspaces` (configurable; each workspace holds one or more repo clones)
- Terminal: `wt` (Windows Terminal). Also: `powershell` | `pwsh` | `cmd`.
- claude command: `claude` — any string. When terminal is `wt`, the command is wrapped in `pwsh -EncodedCommand …` (configurable as `commandShell`) so PowerShell aliases / functions / profile-defined names like `ccp` resolve correctly.
- Auto-focus on launch: on (HWND diff across the terminal process — works for modern wt's multi-window-single-process layout).
- Snapshot interval: 60s; last 30 kept.
- Default repos: none — add your own through the Config panel (URL is whatever `git clone` accepts).

See [CLAUDE.md](CLAUDE.md) for design decisions and the non-obvious gotchas baked into the launcher / focus / snapshot code.
