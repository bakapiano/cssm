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
export const sidebarWidth     = signal(232);     // px when expanded, persisted in localStorage
export const accentColor      = signal('#b3614a'); // user-chosen brand accent, persisted
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
const LS_SIDEBAR_W = 'ccsm.sidebar-width';
const LS_ACCENT = 'ccsm.accent';
const LS_FOLD = (k) => `ccsm.fold.${k}`;

// Resizable sidebar width (when not collapsed). Clamp range matches the
// CSS min/max — too narrow truncates labels, too wide eats main content.
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 232;
export const ACCENT_DEFAULT = '#b3614a';

export function loadPersisted() {
  sidebarCollapsed.value = localStorage.getItem(LS_SIDEBAR) === 'true';
  const w = Number(localStorage.getItem(LS_SIDEBAR_W));
  if (Number.isFinite(w) && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
    sidebarWidth.value = w;
  }
  applySidebarWidthCssVar();
  const a = localStorage.getItem(LS_ACCENT);
  if (isHexColor(a)) {
    accentColor.value = a;
  }
  applyAccentCssVars();
  const folds = { ...cardFolded.value };
  for (const k of Object.keys(folds)) {
    folds[k] = localStorage.getItem(LS_FOLD(k)) === '1';
  }
  cardFolded.value = folds;

  const hash = location.hash.slice(1);
  if (TAB_HEADINGS[hash]) activeTab.value = hash;
}

// Push the current sidebar width into the CSS custom property so the grid
// in layout.css picks it up. Called on load and whenever the user drags
// the handle.
function applySidebarWidthCssVar() {
  document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth.value}px`);
}

export function setSidebarWidth(px) {
  const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
  sidebarWidth.value = clamped;
  applySidebarWidthCssVar();
  localStorage.setItem(LS_SIDEBAR_W, String(clamped));
}

// ── theme accent ────────────────────────────────────────────────
// We expose 4 derived CSS vars: --accent, --accent-deep, --accent-soft,
// --accent-softer. The user only picks the base; deep/soft are computed
// (darken / rgba alpha) so things stay self-consistent.
function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function darken({ r, g, b }, amount) {
  // amount 0..1; pull each channel toward 0
  return { r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) };
}
function lighten({ r, g, b }, amount) {
  // amount 0..1; pull each channel toward 255
  return { r: r + (255 - r) * amount, g: g + (255 - g) * amount, b: b + (255 - b) * amount };
}
// Mix the accent into white at a tiny ratio to get a faint warm/cool tint
// for surfaces. `t` controls strength (0 = pure white, 1 = pure accent).
// Surfaces use very low t (0.02–0.08) so the page reads as "white with
// a hint of the brand color" rather than colored.
function mixWithWhite({ r, g, b }, t) {
  return { r: r * t + 255 * (1 - t), g: g * t + 255 * (1 - t), b: b * t + 255 * (1 - t) };
}
function applyAccentCssVars() {
  const base = accentColor.value;
  const rgb = hexToRgb(base);
  const deep = rgbToHex(darken(rgb, 0.2));
  const soft = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`;
  const softer = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.04)`;
  // Surface tints derived from the accent. Each surface keeps its
  // relative brightness from the original palette (cream → white → cream
  // hover → cream active) but its hue follows the chosen accent. Mixed
  // weights chosen to roughly match the warm copper defaults:
  //   --bg        was #faf9f5  → t≈0.04
  //   --bg-elev   was #ffffff  → t=0    (kept pure white)
  //   --sidebar-hover  was #f0ece0  → t≈0.10
  //   --sidebar-active was #e8e3d5  → t≈0.15
  //   --border         was #e8e3d5  → t≈0.15
  //   --border-soft    was #ece8da  → t≈0.12
  //   --border-strong  was #d4cdb8  → t≈0.25
  const bg           = rgbToHex(mixWithWhite(rgb, 0.04));
  const sidebarHover = rgbToHex(mixWithWhite(rgb, 0.10));
  const sidebarActive= rgbToHex(mixWithWhite(rgb, 0.15));
  const border       = rgbToHex(mixWithWhite(rgb, 0.15));
  const borderSoft   = rgbToHex(mixWithWhite(rgb, 0.12));
  const borderStrong = rgbToHex(mixWithWhite(rgb, 0.25));
  const root = document.documentElement.style;
  root.setProperty('--accent', base);
  root.setProperty('--accent-deep', deep);
  root.setProperty('--accent-soft', soft);
  root.setProperty('--accent-softer', softer);
  root.setProperty('--bg', bg);
  root.setProperty('--sidebar-bg', bg);
  root.setProperty('--sidebar-hover', sidebarHover);
  root.setProperty('--sidebar-active', sidebarActive);
  root.setProperty('--border', border);
  root.setProperty('--border-soft', borderSoft);
  root.setProperty('--border-strong', borderStrong);
  // --bg-elev stays pure white so cards "lift" off the tinted surface.
  // Sync the meta theme-color to the tinted surface so the OS title bar
  // matches what the user sees (was previously the raw accent — too
  // saturated).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
}

export function setAccentColor(hex) {
  if (!isHexColor(hex)) return;
  accentColor.value = hex;
  applyAccentCssVars();
  localStorage.setItem(LS_ACCENT, hex);
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
