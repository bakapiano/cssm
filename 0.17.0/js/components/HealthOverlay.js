// Full-screen modal shown while the backend is unreachable.
//
// Two phases:
//   - Early (failureCount < THRESHOLD): "Checking backend health…" with
//     a spinner. Most outages resolve in one or two ticks — no need to
//     scare the user.
//   - Persistent (failureCount >= THRESHOLD): "Backend not running.
//     Start backend" with a button that fires the ccsm:// protocol so
//     Windows' registered launcher.vbs spawns ccsm.
//
// We never auto-resume. The user has to click the button — protects
// against repeated wake attempts during an in-flight upgrade or a
// crash loop.
//
// While offline we drive a faster (1.5s) poll loop directly so the
// modal dismisses promptly when the backend comes back, without
// waiting for the main 5s refresh interval.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { serverHealth, hasBootedOnline } from '../state.js';
import { pollHealth, refreshAll } from '../api.js';

const THRESHOLD = 3;     // failures before we switch from "checking" to "not running"
const FAST_POLL_MS = 1500;

export function HealthOverlay() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const count = h.failureCount || 0;

  // Don't render the overlay during the very first connect attempt
  // (before we've ever been online) — main.js shows nothing prominent
  // there anyway, and the modal flashing on every page load is
  // annoying. Only show after we've seen the backend at least once.
  const everSeen = hasBootedOnline.value;

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => { pollHealth(); }, FAST_POLL_MS);
    return () => clearInterval(id);
  }, [offline]);

  // When the backend comes back online after we've shown the overlay,
  // refresh all derived state once — sessions/folders/workspaces may
  // have changed during the outage (post-restart, post-upgrade).
  useEffect(() => {
    if (!offline && everSeen) {
      refreshAll().catch(() => {});
    }
  }, [offline]);

  if (!offline || !everSeen) return null;

  const showStart = count >= THRESHOLD;

  return html`
    <div class="health-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="health-card">
        ${!showStart ? html`
          <div class="health-spinner" aria-hidden="true"></div>
          <div class="health-title">Checking backend health…</div>
          <div class="health-meta">
            ${count === 0 ? 'Connecting…' : `${count} attempt${count > 1 ? 's' : ''}`}
          </div>
        ` : html`
          <div class="health-dot" aria-hidden="true"></div>
          <div class="health-title">Backend not running</div>
          <div class="health-meta">
            ${count} failed pings. Wake the backend manually below — we won't auto-restart.
          </div>
          <a class="action primary health-start" href="ccsm://start">
            Start backend
          </a>
          <div class="health-hint">
            Or run <code>ccsm</code> in a terminal.
          </div>
        `}
      </div>
    </div>`;
}
