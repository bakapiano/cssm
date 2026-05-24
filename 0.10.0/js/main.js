// Entry. Loads persisted ui state → boots data → mounts App → spins up
// the 5s auto-refresh + 1s clock tick. No imperative DOM access outside
// the mount root.

import { render } from 'preact';
import { html } from './html.js';
import { loadPersisted, clockTick, lastRefreshAt, installPrompt, isInstalledPwa, sidebarForcedCollapsed } from './state.js';
import { httpBase } from './backend.js';
import { loadConfig, refreshAll, loadSessions, loadFolders, loadWorkspaces, pollHealth } from './api.js';
import { setToast } from './toast.js';
import { App } from './components/App.js';

loadPersisted();
// Pin the document title to "CCSM" — some Chromium builds will inject the
// current URL or path into the standalone window title bar if the page
// title is empty / changes; locking it here keeps the OS title bar text
// stable across navigation, tab switches, and PWA-install refresh.
const lockTitle = () => { if (document.title !== 'CCSM') document.title = 'CCSM'; };
lockTitle();
new MutationObserver(lockTitle).observe(
  document.querySelector('title') || document.head,
  { childList: true, subtree: true, characterData: true }
);
render(html`<${App} />`, document.getElementById('app'));

// PWA install affordance — Chromium fires `beforeinstallprompt` when the
// manifest meets install criteria (served over localhost / https, has icon,
// not already installed). We stash the event so the About page can offer
// a one-click install button that triggers it.
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt.value = ev;
});
window.addEventListener('appinstalled', () => {
  installPrompt.value = null;
  isInstalledPwa.value = true;
});
// On boot, detect if we're already running as an installed PWA window
// (display-mode standalone covers both plain PWA + WCO). When true, the
// "install" affordance hides itself.
const mq = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)');
isInstalledPwa.value = mq.matches;
mq.addEventListener('change', () => { isInstalledPwa.value = mq.matches; });

// "is-app" body class · everything that isn't a regular browser tab
// (display-mode: browser) gets it. Used by wco.css to gate user-select
// on drag regions so chromeless --app= windows can be dragged by
// clicking the page title, while normal tabs still allow text select.
function applyIsAppClass() {
  const isApp = !matchMedia('(display-mode: browser)').matches;
  document.body.classList.toggle('is-app', isApp);
}
applyIsAppClass();
matchMedia('(display-mode: browser)').addEventListener('change', applyIsAppClass);

// Force-collapse the sidebar on narrow viewports. Mirrors the responsive
// CSS so JS state (toggle visibility, tree-render gating) agrees with the
// rendered layout.
const narrowMq = matchMedia('(max-width: 900px)');
function applyNarrow() { sidebarForcedCollapsed.value = narrowMq.matches; }
applyNarrow();
narrowMq.addEventListener('change', applyNarrow);

(async () => {
  // Version-mismatch guard runs FIRST. If the user's backend has been
  // upgraded since this per-version frontend was loaded, bounce back to
  // the router immediately — no point loading config from a server that
  // speaks a different API revision. Runs in dev too (it no-ops without
  // the build-time <meta>).
  await bootVersionGuard();

  try {
    await loadConfig();
    await refreshAll();
    pollHealth();
  } catch (e) {
    setToast('initial load failed · ' + e.message, 'error');
  }

  // 5s data refresh + clock tick (same cadence so fmtAgo "Ns ago" relative
  // labels naturally track the data refresh; bumping clockTick more
  // frequently would just cause needless re-renders since fmtAgo's
  // resolution is coarse — 5s buckets under a minute, then m/h/d).
  // loadWorkspaces is included because the workspace "in use" flag is
  // derived from live session cwds server-side — without it, sessions
  // move in/out of a workspace silently and the grid stays stale.
  setInterval(async () => {
    try {
      await Promise.all([loadSessions(), loadFolders(), loadWorkspaces()]);
      lastRefreshAt.value = Date.now();
    } catch { /* swallow — next tick retries */ }
    pollHealth();
    clockTick.value = Date.now();
  }, 5000);

  // Heartbeat · the server uses this to (a) decide whether to shut down
  // when its own spawned browser closes (multi-client check), and (b) as
  // a 90s watchdog backup if the browser-exit signal is missed entirely.
  // 10s cadence is short enough that any tab open for one full cycle gets
  // caught by the post-close decision in server.js; long enough not to be
  // chatty.
  const ping = () => fetch(httpBase() + '/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
  ping();
  setInterval(ping, 10_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
})();

// ─── version routing guard ───────────────────────────────────────────
// Each deployed frontend is pinned to one backend version. The GH-Pages
// workflow bakes the version into <meta name="ccsm-frontend-version">
// so we can detect "backend has been upgraded since this frontend was
// loaded" and bounce back through the router at /ccsm/ for a fresh
// match. In dev (no meta tag, same-origin served-by-backend), the check
// no-ops — we're always running the frontend that ships with this
// backend by definition.
async function bootVersionGuard() {
  const meta = document.querySelector('meta[name="ccsm-frontend-version"]');
  if (!meta) return;                          // dev mode
  const myVer = meta.getAttribute('content');
  if (!myVer) return;
  let backendVer = null;
  try {
    const r = await fetch(httpBase() + '/api/health', { cache: 'no-store' });
    if (!r.ok) return;
    backendVer = (await r.json()).version;
  } catch { return; }                          // offline → OfflineBanner takes over
  if (!backendVer || backendVer === myVer) return;
  // Mismatch. Bounce up one level to the router. The router will
  // probe /api/health again and redirect to ./<backendVer>/.
  console.warn(`[ccsm] frontend ${myVer} ≠ backend ${backendVer} — re-routing`);
  location.replace('../');
}
