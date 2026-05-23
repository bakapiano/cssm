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

const DEFAULTS = {
  port: 7777,
  workDir: path.join(os.homedir(), 'ccsm-workspaces'),
  snapshotIntervalMs: 60 * 1000,
  snapshotHistoryKeep: 30,
  claudeCommand: 'claude',
  terminal: 'wt',
  commandShell: 'pwsh',
  // 'wt'  — open a new Windows Terminal window (or whatever `terminal` is set to)
  // 'web' — spawn in-process PTY, attach via xterm.js in the Terminals tab
  // Used as the default for new sessions, resume, continue, finder.
  // Per-launch radio in the UI can still override.
  defaultTerminalMode: 'wt',
  autoFocusOnLaunch: true,
  focusMovesToCenter: false,
  // 'app'  — Edge/Chrome --app=<url> chromeless window (looks like a desktop app)
  // 'tab'  — open in default browser as a normal tab
  // 'none' — don't open anything
  browserMode: 'app',
  // Add the repos you most often need on hand. The "new session" button
  // clones any selected entries into the workspace before launching claude.
  // Example shape:
  //   { name: 'foo', url: 'https://github.com/me/foo.git', defaultSelected: true }
  repos: [],
  finderPrompt:
    `Help me find an old Claude Code session on this machine. ccsm's data dir is ${DATA_DIR} (latest snapshot at snapshot.json, history under snapshots/). Live sessions are at ~/.claude/sessions/*.json and conversation transcripts under ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. Ask me what I'm looking for and grep accordingly.`,
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
    console.log(`[ccsm] safe to remove the legacy dir when you're sure: rmdir /s "${LEGACY_DATA_DIR}"`);
  } catch (e) {
    console.error('[ccsm] legacy migration failed:', e.message);
  }
}

migrateLegacyDataIfNeeded();

function mergeWithDefaults(partial) {
  const out = { ...DEFAULTS, ...partial };
  if (!Array.isArray(out.repos)) {
    out.repos = DEFAULTS.repos;
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
};
