// Entry. Loads persisted ui state → boots data → mounts App → spins up
// the 5s auto-refresh + 1s clock tick. No imperative DOM access outside
// the mount root.

import { render } from 'preact';
import { html } from './html.js';
import { loadPersisted, clockTick, lastRefreshAt } from './state.js';
import { loadConfig, refreshAll, loadSessions, loadRecent, loadSnapshot, loadWorkspaces, pollHealth } from './api.js';
import { setToast } from './toast.js';
import { App } from './components/App.js';

loadPersisted();
render(html`<${App} />`, document.getElementById('app'));

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
      await Promise.all([loadSessions(), loadRecent(), loadSnapshot(), loadWorkspaces()]);
      lastRefreshAt.value = Date.now();
    } catch { /* swallow — next tick retries */ }
    pollHealth();
    clockTick.value = Date.now();
  }, 5000);
})();
