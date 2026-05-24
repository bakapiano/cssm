'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Data dir lives under ~/.ccsm by default so config survives across upgrades
// (incl. running from a new npx checkout). Override with CCSM_HOME if you
// want a different location.
const DATA_DIR = process.env.CCSM_HOME || path.join(os.homedir(), '.ccsm');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const LEGACY_DATA_DIR = path.join(__dirname, '..', 'data');

// v1.0 — wt / system-terminal launch path removed. Sessions are always
// in-page web terminals managed by ccsm. CLI is pluggable: configure one
// or more entries under `clis` (claude, codex, custom wrappers), pick a
// default. Old config keys (`terminal`, `commandShell`, `claudeCommand`,
// `defaultTerminalMode`, `autoFocusOnLaunch`, `focusMovesToCenter`,
// `snapshot*`) are silently dropped on load.
const DEFAULT_CLIS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume', '<id>'],
    shell: 'direct',
    type: 'claude',
    builtin: true,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: [],
    resumeArgs: ['resume', '--last'],
    resumeIdArgs: ['resume', '<id>'],
    shell: 'direct',
    type: 'codex',
    builtin: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    args: [],
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume', '<id>'],
    shell: 'direct',
    type: 'copilot',
    builtin: true,
  },
];

const DEFAULTS = {
  port: 7777,
  workDir: path.join(os.homedir(), 'ccsm-workspaces'),
  // Repos available for cloning into a fresh workspace at launch time.
  //   { name: 'foo', url: 'https://github.com/me/foo.git', defaultSelected: true }
  repos: [],
  // Pluggable CLIs. Add wrappers like `ccp` (gc2cc) or self-hosted
  // proxies by appending an entry. defaultCliId picks one for the
  // Launch button when the user doesn't override.
  clis: DEFAULT_CLIS,
  defaultCliId: 'claude',
};

function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// If we find a legacy <repo>/data dir from before the home-dir move AND
// no ~/.ccsm yet, copy across. Idempotent — only fires when DATA_DIR is
// empty so existing users with both dirs aren't clobbered.
function migrateLegacyDataIfNeeded() {
  if (!fsSync.existsSync(LEGACY_DATA_DIR)) return;
  if (LEGACY_DATA_DIR === DATA_DIR) return;
  ensureDataDir();
  const dataEmpty = fsSync.readdirSync(DATA_DIR).length === 0;
  if (!dataEmpty) return;
  try {
    fsSync.cpSync(LEGACY_DATA_DIR, DATA_DIR, { recursive: true });
    console.log(`[ccsm] migrated legacy data: ${LEGACY_DATA_DIR} → ${DATA_DIR}`);
  } catch (e) {
    console.error('[ccsm] legacy migration failed:', e.message);
  }
}

migrateLegacyDataIfNeeded();

// Strip dropped v0.x keys + clamp shape of survivors. Returns a fresh
// object so callers don't mutate DEFAULTS.
function mergeWithDefaults(partial) {
  const out = { ...DEFAULTS, ...partial };
  // Drop v0.x keys that the new architecture doesn't use.
  delete out.terminal;
  delete out.commandShell;
  delete out.claudeCommand;
  delete out.defaultTerminalMode;
  delete out.autoFocusOnLaunch;
  delete out.focusMovesToCenter;
  delete out.snapshotIntervalMs;
  delete out.snapshotHistoryKeep;
  delete out.autoOpenBrowser;
  delete out.browserMode;
  delete out.finderPrompt;

  if (!Array.isArray(out.repos)) out.repos = DEFAULTS.repos;
  if (!Array.isArray(out.clis)) out.clis = [];
  // Always inject builtin CLIs (claude, codex) if they're missing or were
  // deleted from a saved config — they're managed by ccsm, the user can
  // tweak args/shell but can't remove them. Preserves any user
  // customisation on existing builtin entries.
  for (const def of DEFAULT_CLIS) {
    const existing = out.clis.find((c) => c.id === def.id);
    if (existing) {
      existing.builtin = true;
      // Backfill defaults from the built-in template for any field the
      // user's saved copy is missing — keeps old configs aligned with new
      // schema additions (resumeArgs, type, etc.) without clobbering the
      // user's customisations.
      if (existing.resumeArgs == null) existing.resumeArgs = def.resumeArgs;
      if (existing.resumeIdArgs == null) existing.resumeIdArgs = def.resumeIdArgs;
      if (!existing.type) existing.type = def.type;
    } else {
      out.clis.unshift({ ...def });
    }
  }
  // Normalize per-CLI fields.
  out.clis = out.clis.map((c) => {
    const { installed, installPath, ...rest } = c;  // strip computed probe fields
    return {
      ...rest,
      args: Array.isArray(rest.args) ? rest.args : [],
      resumeArgs: Array.isArray(rest.resumeArgs) ? rest.resumeArgs : [],
      resumeIdArgs: Array.isArray(rest.resumeIdArgs) ? rest.resumeIdArgs : [],
      shell: ['direct', 'pwsh', 'cmd'].includes(rest.shell) ? rest.shell : 'direct',
      type: ['claude', 'codex', 'copilot', 'other'].includes(rest.type) ? rest.type : 'other',
      builtin: !!rest.builtin,
    };
  });
  // Make sure defaultCliId points at an actual CLI; fall back to first.
  if (!out.clis.find((c) => c.id === out.defaultCliId)) {
    out.defaultCliId = out.clis[0].id;
  }
  return out;
}

async function loadConfig() {
  ensureDataDir();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return mergeWithDefaults(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') {
      const cfg = { ...DEFAULTS };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return cfg;
    }
    throw e;
  }
}

async function saveConfig(partial) {
  ensureDataDir();
  const current = await loadConfig();
  const next = mergeWithDefaults({ ...current, ...partial });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

module.exports = {
  loadConfig,
  saveConfig,
  DATA_DIR,
  CONFIG_PATH,
  LEGACY_DATA_DIR,
  DEFAULTS,
  DEFAULT_CLIS,
};
