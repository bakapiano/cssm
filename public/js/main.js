// Entry. Loads persisted ui state → boots data → mounts App → spins up
// the 5s auto-refresh + 1s clock tick. No imperative DOM access outside
// the mount root.

import { render } from 'preact';
import { html } from './html.js';
import { loadPersisted, clockTick, lastRefreshAt, installPrompt, isInstalledPwa } from './state.js';
import { httpBase } from './backend.js';
import { loadConfig, refreshAll, loadSessions, loadRecent, loadSnapshot, loadWorkspaces, loadWebTerminals, pollHealth } from './api.js';
import { setToast } from './toast.js';
import { App } from './components/App.js';

loadPersisted();
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

(async () => {
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
      await Promise.all([loadSessions(), loadRecent(), loadSnapshot(), loadWorkspaces(), loadWebTerminals()]);
      lastRefreshAt.value = Date.now();
    } catch { /* swallow — next tick retries */ }
    pollHealth();
    clockTick.value = Date.now();
  }, 5000);

  // Heartbeat — safety net for the server's "exit when nobody's around"
  // logic. The primary mechanism is OS-level (browser child exit), this is
  // a slow backup. 30s cadence; immediate ping on visibility change so the
  // server doesn't time out the moment the laptop wakes.
  const ping = () => fetch(httpBase() + '/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
  ping();
  setInterval(ping, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
})();
