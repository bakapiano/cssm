// Shown when the backend probe fails. The hosted frontend (running at
// https://bakapiano.github.io/ccsm/v1/) can't spawn processes directly,
// so we surface a ccsm://start link instead. Windows / OS will hand that
// off to the registered protocol handler (ccsm.cmd), which spawns the
// backend silently. Our health probe picks it up on the next tick and
// the banner auto-hides.
//
// First click triggers a Windows confirmation dialog ("Open ccsm.cmd?").
// User can check "Always allow" to suppress future prompts.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { serverHealth } from '../state.js';
import { refreshAll } from '../api.js';

export function OfflineBanner() {
  const h = serverHealth.value;
  // "connecting" is the initial transient state — don't flash the banner
  // until we've actually seen offline.
  const offline = h.state === 'offline';
  const [clicked, setClicked] = useState(false);

  // When backend comes back online after the user tried to launch it,
  // kick refreshAll so the page state catches up faster than the next
  // 5s tick.
  useEffect(() => {
    if (h.state === 'online' && clicked) {
      refreshAll().catch(() => {});
      setClicked(false);
    }
  }, [h.state, clicked]);

  if (!offline) return null;

  return html`
    <div class="offline-banner">
      <div class="offline-banner-inner">
        <span class="offline-dot" aria-hidden="true"></span>
        <div class="offline-banner-text">
          <strong>Backend not running.</strong>
          <span class="muted-text">
            Click Start to launch · Windows will ask once
            (check "Always allow" to silence future prompts).
          </span>
        </div>
        <div class="offline-banner-actions">
          <a class="action primary" href="ccsm://start"
             onClick=${() => setClicked(true)}>Start ccsm</a>
        </div>
      </div>
    </div>`;
}
