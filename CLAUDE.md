# ccsm — Claude Code Session Manager

A small Node/Express + vanilla-JS web tool that gives a single pane over all live Claude Code sessions on this machine, snapshots them, restores them through Windows Terminal, and launches new sessions inside isolated workspaces.

## Why this exists

When you're running 8–10 concurrent `claude` sessions across ad-hoc clones (`D:\proj`, `D:\proj2`, `…`, plus GUID worktree dirs), it's easy to lose track of which terminal is which session. ccsm gives an at-a-glance list and a snapshot/restore safety net.

## Run

```powershell
# from a checkout
node server.js

# zero-install
npx github:bakapiano/cssm
```
Then open http://localhost:7777.

Default port `7777`, default workDir `~/ccsm-workspaces`. Config + snapshots live at `~/.ccsm/` (override with `CCSM_HOME=<path>`). All settings editable through the Config panel (`~/.ccsm/config.json` on disk). Notable knobs:

- `port` (default `7777`) — preferred listen port. If taken, ccsm tries `+1..+9` then asks the OS for any free port. The startup log prints the actual URL so you always see where it ended up.
- `autoOpenBrowser` (default true) — after `listen()` succeeds, ccsm spawns `cmd /c start "" <url>` to open the UI in the default browser. Disable for headless / nohup setups.
- `claudeCommand` (default `"claude"`) — what gets `--resume`'d or freshly invoked inside the new terminal. Can be an exe (`claude`, `claude.exe`), a PowerShell alias or function (`ccp`), or any wrapper script — see `commandShell` below.
- `terminal` — `wt` | `powershell` | `pwsh` | `cmd`. wt opens a fresh window per launch (`wt -w new` is set to defeat the "fold into existing window" setting some users have). The other three each spawn via `cmd /c start ... <shell>`.
- `commandShell` (default `pwsh`) — only consulted when `terminal=wt`. Values `pwsh` / `powershell` wrap `claudeCommand` inside `<shell> -NoExit -NoLogo -Command "Set-Location ...; & '<cmd>' '<args>'..."` so PowerShell aliases / functions / profile-defined names (like `ccp` from `$PROFILE`) resolve. `none` runs the command directly via wt (raw `CreateProcess`) — fine if `claudeCommand` is an actual exe on PATH, broken for aliases. `pwsh` / `powershell` kinds already wrap natively so this knob doesn't affect them; `cmd` kind has no shell concept for aliases.
- `autoFocusOnLaunch` (default true) — after every launch (new session, finder, resume, restore) the server takes an HWND snapshot of terminal windows, polls for a new HWND, and `SetForegroundWindow`s it. See gotcha below — wt is multi-window single-process, so we diff HWNDs not PIDs.

## Layout

```
D:\ccsm\
├── server.js                # Express app + 60s auto-snapshot loop
├── lib\
│   ├── sessions.js          # reads ~/.claude/sessions/*.json + cross-checks live PIDs (tasklist)
│   │                        # + pulls last ai-title from ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
│   ├── snapshot.js          # save/load/rotate/restore — restore = launch one wt window per session
│   ├── workspace.js         # workspace = subfolder under workDir holding repo clones;
│   │                        # "in use" = any live session's cwd is at/under the workspace path
│   ├── launcher.js          # dispatches across terminal kinds (wt/powershell/pwsh/cmd);
│   │                        # path.resolve()s cwd; throws if cwd doesn't exist
│   ├── focus.js             # PowerShell + Win32 — listWindowsOf, focusByHwnd, focusByPid,
│   │                        # focusNewlyOpenedHwnd (HWND-diff for auto-focus on launch)
│   └── config.js            # loadConfig/saveConfig with defaults
├── public\
│   ├── index.html, app.js, styles.css   # vanilla, auto-refresh every 5s
└── package.json             # bin entry → `ccsm` (for npx github:bakapiano/cssm)

~/.ccsm/                     # or $CCSM_HOME
├── config.json              # source of truth
├── snapshot.json            # latest snapshot, rewritten every 60s
└── snapshots/               # rotating history (default keep=30)
```

On first run, if a legacy `<repo>/data/` directory exists and `~/.ccsm/` is empty, `lib/config.js` copies the old data over (one-time, idempotent). The legacy dir is left in place — clean up manually after verifying.

## Locked-in design decisions

**Workspace = folder holding multiple repo clones.** Each `ws-N` under `workDir` contains a subdirectory per cloned repo. Claude launches at the workspace root so all selected repos are sibling folders.

```
D:\ccsm-workspaces\
├── ws-1\
│   ├── repo-a\
│   └── repo-b\
├── ws-2\
│   └── repo-a\
```

The alternative ("one repo per workspace") was explicitly rejected — don't refactor toward it without re-confirming.

**wt: one window per session, not stacked tabs.** Both `/api/snapshot/restore` and `/api/sessions/new` open a fresh `wt` window. The alternative ("`-w 0 nt` stacking in one window") was explicitly rejected — tabs become hard to track when restoring 8+ sessions.

**"In use" detection.** A workspace is in use iff any live Claude session's cwd is at-or-inside the workspace path (case-insensitive Windows compare via `path.resolve().toLowerCase()`). New-session always tries to pick a free workspace before creating `ws-N+1`.

**Workspace naming.** Auto-allocated names are `ws-1`, `ws-2`, … (lowest free integer). Hand-named folders the user drops under `workDir` are still picked up — workspace name = literal folder name.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions` | live sessions sorted by `updatedAt` desc |
| GET / PUT | `/api/config` | read / replace config (merged against defaults) |
| GET / POST | `/api/snapshot` | latest snapshot / force-save now |
| GET | `/api/snapshot/history` | rotated history filenames |
| POST | `/api/snapshot/restore` | launch one wt window per session in latest snapshot (body `{file}` for historic) |
| GET | `/api/workspaces` | workspaces under workDir with repo clone status + in-use flag |
| POST | `/api/sessions/new` | body `{repos, workspace?, launch?}` — picks/creates ws, clones missing repos, launches wt |
| POST | `/api/sessions/finder` | opens a wt with `claude` in `D:\ccsm` and the `finderPrompt` as opening message |
| POST | `/api/sessions/:id/resume` | body `{cwd}` — launches `wt -d <cwd> claude --resume <id>` |
| POST | `/api/sessions/:id/focus` | walks up the claude PID parent chain to find the wt window, raises it via SetForegroundWindow |
| GET | `/api/terminals` | enumerate built-in terminal kinds + their process names |
| GET | `/api/health` | sanity ping |

`/api/sessions/new` streams **NDJSON** (one JSON object per line, `Content-Type: application/x-ndjson`). Event types: `workspace`, `clone-start`, `clone-progress` (phase/percent/current/total/detail), `clone-line` (raw git stderr line when not a progress line), `clone-end`, `launched`, `done`. The frontend reads it with `fetch().body.getReader()` + `TextDecoder` and updates per-repo progress bars live.

## Non-obvious gotchas

**wt.exe `-d` flag, verified variants** (marker-file probes confirming `%CD%` inside the new tab):

| variant | result |
|---|---|
| `wt -d D:\ccsm <cmd>` | ✓ |
| `wt -d D:/ccsm <cmd>` | ✓ (forward slashes fine) |
| `wt --startingDirectory D:\ccsm <cmd>` | ✓ |
| `wt -d D:\ccsm\ <cmd>` (trailing sep) | ✓ |
| spawn `{ cwd: ... }` with no `-d` | ✗ wt ignores parent cwd |
| `wt -d "D:\ccsm" <cmd>` (literal quotes) | ✗ wt doesn't open |
| `wt new-tab -d D:\ccsm <cmd>` | ✗ wt doesn't open |

ccsm uses variant 1 and always `path.resolve()`s the cwd first — defends against a malformed `D:ccsm` (no separator) being interpreted as "current dir on drive D + ccsm", which would resolve to e.g. `D:\ccsm\ccsm`.

**Don't test wt launching via `node -e "..."` inside `bash -c`.** Backslashes get eaten by shell quoting and the JS string ends up malformed. Write a `.js` file and `node file.js` instead.

**Focus helper (`lib/focus.js`).** One `powershell.exe -EncodedCommand <base64>` invocation per call, dispatched by `CCSM_FOCUS_MODE` env var into modes `list` (enumerate visible top-level windows owned by a process name), `focus-hwnd` (activate a specific HWND), `focus-pid` (walk parent chain to MainWindowHandle then activate). Encoded as UTF-16-LE-base64 — passing the C# block via stdin to `-Command -` silently produces no output, so we don't. Three gotchas baked in:
1. C# `out _` discard breaks PowerShell 5.1's bundled C# compiler — use a named `uint dummy`.
2. Windows blocks background processes from `SetForegroundWindow` — synthesize an Alt-key down/up via `keybd_event 0x12` first ("Alt-key trick") to qualify our process. Without it, `activated` returns false even though the window is found.
3. `ConvertTo-Json -AsArray` is PS 7+; on PS 5.1 build the JSON array manually as `'[' + ($items -join ',') + ']'` to avoid the single-element flattening.

**HWND-diff for auto-focus, not PID-diff.** Modern Windows Terminal is multi-window single-process: one `WindowsTerminal.exe` PID owns 8+ top-level HWNDs. So `tasklist`-style PID-set-diff after launch returns empty even though a new window actually opened. We list visible top-level windows (filtered by owning-process name) via `EnumWindows`, snapshot the HWND set before launch, poll after, focus the new HWND. Works uniformly for wt and the per-process terminals (`powershell.exe` etc) where each launch is also a new process.

**wt `-w new`.** wt's `windowingBehavior` setting in some user profiles folds new `wt …` invocations into the existing window as a tab, breaking "one window per session". Force-prepending `-w new` makes wt always create a new window (which is one of those many HWNDs above). Without `-w new`, both the auto-focus path and the design-decision-of-one-window-per-session silently break.

**Auto-snapshot loop.** `setInterval` in `server.js` calls `saveSnapshot` every `snapshotIntervalMs`. The history dir grows until `snapshotHistoryKeep` is exceeded, then oldest are pruned.

**Session listing.** `~/.claude/sessions/<pid>.json` is the source of truth. We cross-check the `pid` field against `tasklist /FI "IMAGENAME eq claude.exe"` so stale entries from crashed/exited claudes don't appear. `ai-title` is read by tailing the last 1 MB of the matching `.jsonl` and finding the last `"type":"ai-title"` line.

**`projectSlugForCwd`.** The path-to-slug mapping is `cwd.replace(/[:\\]/g, '-')`, e.g. `D:\ccsm` → `D--ccsm`, `C:\Users\foo` → `C--Users-foo`, `D:\` → `D--`.

## Extending

When adding features, the natural extension points:
- New REST routes: `server.js` (keep them under `/api/*`, use `asyncH` wrapper).
- Frontend section: add a `<section class="panel">` in `public/index.html` and a render function in `public/app.js`.
- Workspace lifecycle (delete, rename): `lib/workspace.js`.
- Different launch modes (e.g., stacked tabs): `lib/launcher.js` — but check first whether the "one window per session" decision still holds.
