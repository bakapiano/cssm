// All shared reactive state. Importing a signal anywhere subscribes the
// reading component, so we never need a store / context wrapper.

import { signal, computed } from '@preact/signals';

// ── server-driven data ──────────────────────────────────────────
export const config       = signal(null);
export const terminals    = signal([]);
export const capabilities = signal({ webTerminal: false });
export const sessions     = signal([]);
export const webTerminals = signal([]);          // active in-page PTY sessions
export const activeTerminalId = signal(null);    // which one's open in the right pane
export const recent       = signal([]);
export const recentTotal  = signal(0);
export const favorites    = signal({});   // { sessionId: {sessionId, cwd, title, gitBranch, addedAt} }
export const labels       = signal({});   // { sessionId: customLabel }
export const workspaces   = signal([]);
export const snapshot     = signal(null);
export const history      = signal([]);
export const serverHealth = signal({ state: 'connecting' });

// ── ui state (persisted in localStorage where noted) ───────────
export const activeTab        = signal('sessions');
export const sidebarCollapsed = signal(false);
// fold state for the three cards on the Sessions tab
export const cardFolded       = signal({ favorites: false, sessions: false, recent: false });
export const configDirty      = signal(false);
export const modalOpen        = signal(false);
export const clockTick        = signal(Date.now());      // re-ticked each second so fmtAgo refreshes
export const lastRefreshAt    = signal(0);               // ms timestamp of last successful refreshAll()
export const installPrompt    = signal(null);            // captured beforeinstallprompt event (PWA install)
export const isInstalledPwa   = signal(false);           // running inside an installed PWA window (display-mode: standalone+)

// ── pagination ──────────────────────────────────────────────────
export const sessionsOffset  = signal(0);
export const sessionsLimit   = signal(10);
export const favoritesOffset = signal(0);
export const favoritesLimit  = signal(10);
export const recentOffset    = signal(0);
export const recentLimit     = signal(10);

// ── derived ─────────────────────────────────────────────────────
export const favoritesList = computed(() =>
  Object.values(favorites.value).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
);

export const TAB_HEADINGS = {
  sessions:  { title: 'Sessions',  subtitle: 'Live and recently-closed Claude Code sessions on this machine.' },
  launch:    { title: 'Launch',    subtitle: 'Spin up a new session in a fresh workspace, or restore from snapshot.' },
  terminals: { title: 'Terminals', subtitle: 'Claude sessions running in this page.' },
  configure: { title: 'Configure', subtitle: 'Persisted to ~/.ccsm/config.json.' },
  about:     { title: 'About',     subtitle: 'ccsm — Claude Code Session Manager.' },
};

// ── persistence helpers (localStorage) ──────────────────────────
const LS_SIDEBAR = 'ccsm.sidebar-collapsed';
const LS_FOLD = (k) => `ccsm.fold.${k}`;

export function loadPersisted() {
  sidebarCollapsed.value = localStorage.getItem(LS_SIDEBAR) === 'true';
  const folds = { ...cardFolded.value };
  for (const k of Object.keys(folds)) {
    folds[k] = localStorage.getItem(LS_FOLD(k)) === '1';
  }
  cardFolded.value = folds;

  const hash = location.hash.slice(1);
  if (TAB_HEADINGS[hash]) activeTab.value = hash;
}

// ── actions ─────────────────────────────────────────────────────
export function selectTab(name) {
  if (!TAB_HEADINGS[name]) name = 'sessions';
  activeTab.value = name;
  if (location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
}

export function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(LS_SIDEBAR, String(sidebarCollapsed.value));
}

export function toggleCardFold(key) {
  const next = { ...cardFolded.value, [key]: !cardFolded.value[key] };
  cardFolded.value = next;
  localStorage.setItem(LS_FOLD(key), next[key] ? '1' : '0');
}
