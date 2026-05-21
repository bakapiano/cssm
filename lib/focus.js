'use strict';

// Focus helpers — find or raise a wt (or other terminal) window via Win32
// APIs called through PowerShell + Add-Type.
//
// Two distinct use cases:
//   1. focusByPid(pid)             — for the "focus" button in the UI: given
//                                     a live claude.exe PID, walk parents to
//                                     find the wt window hosting it.
//   2. snapshotWindowsOf(name) +
//      focusNewlyOpenedHwnd(...)  — for auto-focus after launch: snapshot the
//                                     set of visible top-level windows owned by
//                                     processes named e.g. "WindowsTerminal.exe"
//                                     BEFORE launch, then poll for new HWNDs
//                                     and focus the diff. HWND-based because
//                                     modern wt is multi-window single-process —
//                                     PID-based diff would always return empty.

const { spawn } = require('node:child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// One PowerShell helper handles both: list-windows-of and focus-hwnd modes.
// Mode is passed via env var so we don't fight quoting.
const FOCUS_HELPER_PS = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class CcsmWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool t);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool x);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
    const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    public static List<object> EnumVisibleTopLevel() {
        var results = new List<object>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            var sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            results.Add(new { hwnd = h.ToInt64(), pid = pid, title = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return results;
    }

    // SWP flags
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_ASYNCWINDOWPOS = 0x4000;
    const uint SWP_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;

    // Horizontal shake — small left/right offsets so the user's eye snaps
    // to the activated window. ~220ms total.
    public static void Jiggle(IntPtr h) {
        RECT rc;
        if (!GetWindowRect(h, out rc)) return;
        int x = rc.Left;
        int y = rc.Top;
        int[] dx = new int[] { 8, -8, 6, -6, 0 };
        foreach (int d in dx) {
            SetWindowPos(h, IntPtr.Zero, x + d, y, 0, 0, SWP_FLAGS);
            Thread.Sleep(38);
        }
    }

    // Move the window to the center of whichever monitor the cursor is on.
    // Preserves window size. Returns true if it moved.
    public static bool MoveToCursorScreenCenter(IntPtr h) {
        RECT wr;
        if (!GetWindowRect(h, out wr)) return false;
        int ww = wr.Right - wr.Left;
        int wh = wr.Bottom - wr.Top;

        POINT cursor;
        if (!GetCursorPos(out cursor)) return false;
        IntPtr hMon = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        if (hMon == IntPtr.Zero) return false;

        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(hMon, ref mi)) return false;

        // Use the work area (excludes taskbar) so a centered window isn't
        // pushed under the taskbar.
        int sw = mi.rcWork.Right - mi.rcWork.Left;
        int sh = mi.rcWork.Bottom - mi.rcWork.Top;
        int nx = mi.rcWork.Left + (sw - ww) / 2;
        int ny = mi.rcWork.Top + (sh - wh) / 2;
        return MoveWindow(h, nx, ny, ww, wh, true);
    }

    public static bool Activate(IntPtr h, bool moveToCenter) {
        if (IsIconic(h)) ShowWindowAsync(h, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
        uint ownerPid = 0;
        uint t = GetWindowThreadProcessId(h, out ownerPid);
        uint c = GetCurrentThreadId();
        bool attached = false;
        if (t != c) attached = AttachThreadInput(c, t, true);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        SwitchToThisWindow(h, true);
        if (attached) AttachThreadInput(c, t, false);
        if (moveToCenter) MoveToCursorScreenCenter(h);
        Jiggle(h);
        return ok;
    }
}
'@ | Out-Null

$mode = $env:CCSM_FOCUS_MODE
$arg  = $env:CCSM_FOCUS_ARG
$moveToCenter = $env:CCSM_FOCUS_CENTER -eq '1'

if ($mode -eq 'list') {
    $procName = $arg -replace '\.exe$',''
    $pidSet = @{}
    foreach ($p in (Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
        $pidSet[[uint32]$p.Id] = $true
    }
    $all = [CcsmWin]::EnumVisibleTopLevel()
    $items = @()
    foreach ($w in $all) {
        if ($pidSet.ContainsKey([uint32]$w.pid)) {
            $items += (ConvertTo-Json @{
                hwnd = [int64]$w.hwnd
                pid = [int64]$w.pid
                title = [string]$w.title
            } -Compress)
        }
    }
    Write-Output ('[' + ($items -join ',') + ']')
    exit 0
}

if ($mode -eq 'focus-hwnd') {
    $hwndInt = [int64]$arg
    $hwnd = [IntPtr]::new($hwndInt)
    $ok = [CcsmWin]::Activate($hwnd, $moveToCenter)
    Write-Output (ConvertTo-Json @{ ok = $true; activated = $ok; hwnd = $hwndInt } -Compress)
    exit 0
}

if ($mode -eq 'focus-pid') {
    $current = [int]$arg
    $hwnd = [IntPtr]::Zero
    $found = $null
    $chain = @()
    for ($i = 0; $i -lt 12; $i++) {
        $p = $null
        try { $p = Get-Process -Id $current -ErrorAction Stop } catch { break }
        $chain += @{ pid = $p.Id; name = $p.ProcessName; hwnd = $p.MainWindowHandle.ToInt64() }
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $p.MainWindowHandle; $found = $p; break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $parent -or -not $parent.ParentProcessId) { break }
        $current = [int]$parent.ParentProcessId
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Output (ConvertTo-Json @{ ok = $false; error = "no window handle found for pid $arg"; chain = $chain } -Compress -Depth 5)
        exit 1
    }
    $activated = [CcsmWin]::Activate($hwnd, $moveToCenter)
    Write-Output (ConvertTo-Json @{
        ok = $true; activated = $activated
        hwnd = $hwnd.ToInt64()
        windowPid = $found.Id
        windowProcess = $found.ProcessName
        windowTitle = $found.MainWindowTitle
        chain = $chain
    } -Compress -Depth 5)
    exit 0
}

Write-Output (ConvertTo-Json @{ ok = $false; error = "unknown CCSM_FOCUS_MODE: $mode" } -Compress)
exit 1
`;

function runPsHelper(mode, arg, opts = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(FOCUS_HELPER_PS, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: {
          ...process.env,
          CCSM_FOCUS_MODE: mode,
          CCSM_FOCUS_ARG: String(arg),
          CCSM_FOCUS_CENTER: opts.moveToCenter ? '1' : '0',
        },
      }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const last = out.trim().split(/\r?\n/).pop();
      try {
        const parsed = JSON.parse(last);
        if (Array.isArray(parsed)) {
          resolve({ exitCode: code, value: parsed, stderr: err.trim() || undefined });
        } else {
          resolve({ exitCode: code, ...parsed, stderr: err.trim() || undefined });
        }
      } catch (e) {
        reject(
          new Error(
            `focus helper (mode=${mode}) exit ${code}: ${err || out || '(no output)'}`
          )
        );
      }
    });
  });
}

// ---- public API ----

async function focusByPid(pid, opts = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`focusByPid: invalid pid ${pid}`);
  return await runPsHelper('focus-pid', n, opts);
}

// Strip the leading wt status glyph + whitespace ("✳ ", "⠐ ", "⠠ " etc) so
// the title compares cleanly. wt prefixes the tab title with a Braille-style
// progress glyph or a sparkle/asterisk depending on activity.
function cleanWtTitle(t) {
  return String(t || '').replace(/^[^\w一-鿿]+/, '').trim();
}

// Best-effort: focus the wt window that belongs to a specific session.
// Modern wt is single-process multi-window, so walking from claude.exe PID
// up to wt.exe + taking MainWindowHandle always returns the same canonical
// window regardless of which tab the session is actually in. Instead we
// list all wt windows and match by tab title against the session's AI
// title / cwd basename.
async function focusBySession({ pid, sessionId, title, cwd, moveToCenter = false }) {
  const procName = 'WindowsTerminal.exe';
  const cands = await listWindowsOf(procName);
  const opts = { moveToCenter };

  const cleanedTitle = title ? cleanWtTitle(title) : '';
  const cwdBase = cwd ? require('node:path').basename(cwd) : '';

  // 1. Exact match on cleaned ai-title
  if (cleanedTitle) {
    const exact = cands.filter((w) => cleanWtTitle(w.title) === cleanedTitle);
    if (exact.length === 1) {
      const r = await focusByHwnd(exact[0].hwnd, opts);
      return { ...r, matchedBy: 'title-exact', hwnd: exact[0].hwnd, windowTitle: exact[0].title };
    }
  }

  // 2. Title substring match (some shells append " - <cwd>" etc)
  if (cleanedTitle) {
    const subs = cands.filter((w) => w.title.includes(cleanedTitle));
    if (subs.length === 1) {
      const r = await focusByHwnd(subs[0].hwnd, opts);
      return { ...r, matchedBy: 'title-substring', hwnd: subs[0].hwnd, windowTitle: subs[0].title };
    }
  }

  // 3. Match by cwd basename (workspace name shows up in title for fresh launches)
  if (cwdBase) {
    const byCwd = cands.filter((w) => w.title.includes(cwdBase));
    if (byCwd.length === 1) {
      const r = await focusByHwnd(byCwd[0].hwnd, opts);
      return { ...r, matchedBy: 'cwd-basename', hwnd: byCwd[0].hwnd, windowTitle: byCwd[0].title };
    }
  }

  // 4. Fall back to PID parent-chain walk (returns the wt process's
  //    canonical MainWindowHandle — may be the wrong window when wt is
  //    multi-window single-process, but better than nothing).
  if (pid) {
    const r = await focusByPid(pid, opts);
    return { ...r, matchedBy: 'pid-fallback', ambiguous: true };
  }
  return { ok: false, error: 'no match by title/cwd and no pid given', matchedBy: 'none' };
}

async function focusByHwnd(hwnd, opts = {}) {
  return await runPsHelper('focus-hwnd', hwnd, opts);
}

async function listWindowsOf(processName) {
  const r = await runPsHelper('list', processName);
  return Array.isArray(r.value) ? r.value : [];
}

async function snapshotWindowsOf(processName) {
  const list = await listWindowsOf(processName);
  return new Set(list.map((w) => Number(w.hwnd)));
}

async function focusNewlyOpenedHwnd(beforeHwnds, processName, opts = {}) {
  const { timeoutMs = 8000, intervalMs = 300 } = opts;
  const deadline = Date.now() + timeoutMs;
  await sleep(intervalMs);
  while (Date.now() < deadline) {
    const after = await listWindowsOf(processName);
    const fresh = after.filter((w) => !beforeHwnds.has(Number(w.hwnd)));
    if (fresh.length > 0) {
      const target = fresh[fresh.length - 1];
      const r = await focusByHwnd(target.hwnd);
      return { ...r, hwnd: target.hwnd, title: target.title, candidates: fresh };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: `no new ${processName} window appeared within ${timeoutMs}ms`,
  };
}

module.exports = {
  focusByPid,
  focusBySession,
  focusByHwnd,
  listWindowsOf,
  snapshotWindowsOf,
  focusNewlyOpenedHwnd,
};
