'use strict';

const { spawn, exec } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Terminal kinds we know how to open a new window for. Each entry has:
//   processName  — what shows up in tasklist, used by focus.js to find the
//                  newly-created window via HWND diff.
//   spawn(opts)  — returns { spawned: ChildProcess, args: string[] }.
//
// All variants take { cwd, command, args, title, commandShell } and open a
// new on-screen window with `command args...` running in `cwd`. `commandShell`
// only matters for the wt kind — see comment there.
const TERMINAL_KINDS = {
  wt: {
    processName: 'WindowsTerminal.exe',
    spawn({ cwd, command, args, title, commandShell }) {
      // `-w new` forces a new wt window. Without it, recent wt versions
      // honor the user's "windowingBehavior" setting and may fold the
      // invocation into an existing window as a tab — which breaks the
      // "one window per session" promise and the auto-focus HWND diff.
      const wtArgs = ['-w', 'new'];
      if (title) wtArgs.push('--title', title);
      wtArgs.push('-d', cwd);
      if (command) {
        // wt by default runs the command via CreateProcess (no shell), so a
        // PowerShell alias / function / profile-defined name like "ccp" can't
        // be found. Wrapping in pwsh/powershell loads $PROFILE and resolves
        // those names. commandShell="none" reverts to direct invocation for
        // anyone who wants raw exe semantics.
        //
        // We use -EncodedCommand (base64 UTF-16LE) instead of -Command because
        // wt's CLI parser treats `;` as a sub-command separator at any nesting
        // depth — a `;` inside our -Command string would make wt try to launch
        // whatever follows as a brand-new wt sub-command. Base64 has no `;`.
        if (commandShell === 'pwsh' || commandShell === 'powershell') {
          const shellExe = commandShell === 'powershell' ? 'powershell.exe' : 'pwsh.exe';
          wtArgs.push(
            shellExe,
            '-NoExit', '-NoLogo',
            '-EncodedCommand', buildPwshEncodedCommand({ cwd, command, args })
          );
        } else {
          wtArgs.push(command, ...args);
        }
      }
      const spawned = spawn('wt.exe', wtArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      spawned.unref();
      return { spawned, args: wtArgs };
    },
  },
  powershell: {
    processName: 'powershell.exe',
    spawn(opts) {
      return spawnViaCmdStart('powershell.exe', opts);
    },
  },
  pwsh: {
    processName: 'pwsh.exe',
    spawn(opts) {
      return spawnViaCmdStart('pwsh.exe', opts);
    },
  },
  cmd: {
    processName: 'cmd.exe',
    spawn({ cwd, command, args, title }) {
      // cmd /K runs a command and stays open. We use `start` to create a new
      // window. The empty "" is the new window's title slot.
      const inner = command
        ? [command, ...args].map(quoteForCmd).join(' ')
        : '';
      const cmdLine = inner ? `/K ${inner}` : '/K';
      const spawned = spawn(
        'cmd.exe',
        ['/c', 'start', title || '', '/D', cwd, 'cmd.exe', cmdLine],
        { detached: true, stdio: 'ignore', windowsHide: false }
      );
      spawned.unref();
      return { spawned, args: ['/c', 'start', title || '', '/D', cwd, 'cmd.exe', cmdLine] };
    },
  },
};

function quoteForCmd(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[\s"&|<>^]/.test(str)) return '"' + str.replace(/"/g, '\\"') + '"';
  return str;
}

function quoteForPwsh(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Build a PowerShell command-line string that cd's into cwd then invokes
// command with args via `&` (works for aliases, functions, scripts, exes).
function buildPwshScript({ cwd, command, args }) {
  const pieces = [`Set-Location -LiteralPath ${quoteForPwsh(cwd)}`];
  if (command) {
    const argTail = (args || []).map(quoteForPwsh).join(' ');
    pieces.push(`& ${quoteForPwsh(command)} ${argTail}`.trim());
  }
  return pieces.join('; ');
}

// PowerShell -EncodedCommand expects UTF-16LE base64. We pass scripts this
// way so the wt CLI parser doesn't munge ';' (which wt uses as a sub-command
// separator at any nesting depth) or other shell metacharacters.
function buildPwshEncodedCommand(opts) {
  return Buffer.from(buildPwshScript(opts), 'utf16le').toString('base64');
}

// Helper for the powershell/pwsh kinds: open a new window via `cmd /c start`
// running powershell/pwsh that cd's to cwd and runs the command.
function spawnViaCmdStart(psExe, { cwd, command, args, title }) {
  const psScript = buildPwshScript({ cwd, command, args });
  const startArgs = [
    '/c', 'start',
    title || '',
    '/D', cwd,
    psExe,
    '-NoExit', '-NoLogo',
    '-Command', psScript,
  ];
  const spawned = spawn('cmd.exe', startArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  spawned.unref();
  return { spawned, args: startArgs };
}

function launchInTerminal({
  cwd,
  command = null,
  args = [],
  title = null,
  terminal = 'wt',
  commandShell = 'pwsh',
}) {
  if (!cwd) throw new Error('launchInTerminal: cwd required');
  const kind = TERMINAL_KINDS[terminal];
  if (!kind) throw new Error(`launchInTerminal: unknown terminal "${terminal}"`);
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved)) {
    throw new Error(`launchInTerminal: cwd does not exist: ${resolved}`);
  }
  const { spawned, args: launchedArgs } = kind.spawn({
    cwd: resolved,
    command,
    args,
    title,
    commandShell,
  });
  return {
    pid: spawned.pid,
    cwd: resolved,
    terminal,
    commandShell,
    processName: kind.processName,
    args: launchedArgs,
  };
}

// Convenience wrappers — claudeCommand defaults to 'claude' but should be
// supplied by the caller from config so the user's preference applies.
function launchResume({ cwd, sessionId, title = null, terminal = 'wt', claudeCommand = 'claude', commandShell = 'pwsh' }) {
  return launchInTerminal({
    cwd,
    command: claudeCommand,
    args: ['--resume', sessionId],
    title: title || `resume ${sessionId.slice(0, 8)}`,
    terminal,
    commandShell,
  });
}

function launchNewClaude({
  cwd,
  title = null,
  extraArgs = [],
  terminal = 'wt',
  claudeCommand = 'claude',
  commandShell = 'pwsh',
}) {
  return launchInTerminal({
    cwd,
    command: claudeCommand,
    args: extraArgs,
    title: title || path.basename(cwd),
    terminal,
    commandShell,
  });
}

function listTerminalKinds() {
  return Object.keys(TERMINAL_KINDS).map((name) => ({
    name,
    processName: TERMINAL_KINDS[name].processName,
  }));
}

function processNameFor(terminal) {
  return TERMINAL_KINDS[terminal] ? TERMINAL_KINDS[terminal].processName : null;
}

module.exports = {
  launchInTerminal,
  launchResume,
  launchNewClaude,
  listTerminalKinds,
  processNameFor,
};
