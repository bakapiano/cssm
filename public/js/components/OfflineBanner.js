// Shown when the backend probe fails. Tells the user how to start the
// local ccsm backend — the page itself can't spawn processes (PWA /
// hosted frontend lives in the browser sandbox), so we just surface the
// shell command and let the user paste it into a terminal.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { serverHealth } from '../state.js';
import { refreshAll } from '../api.js';
import { setToast } from '../toast.js';

const CMD = 'ccsm';

export function OfflineBanner() {
  const h = serverHealth.value;
  // "connecting" is the initial transient state — don't flash the banner
  // until we've actually seen offline.
  const offline = h.state === 'offline';
  const [tried, setTried] = useState(false);

  // When backend comes back online after the banner has been shown at
  // least once, kick a refreshAll so the page state catches up faster
  // than the next 5s tick.
  useEffect(() => {
    if (h.state === 'online' && tried) {
      refreshAll().catch(() => {});
      setTried(false);
    }
  }, [h.state, tried]);

  if (!offline) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMD);
      setToast('copied · paste into a terminal and hit enter');
      setTried(true);
    } catch (e) {
      setToast('clipboard blocked · copy the command manually', 'error');
    }
  };

  return html`
    <div class="offline-banner">
      <div class="offline-banner-inner">
        <span class="offline-dot" aria-hidden="true"></span>
        <div class="offline-banner-text">
          <strong>Backend not running.</strong>
          <span class="muted-text">
            Open a terminal and run <code>${CMD}</code> · the page will auto-reconnect.
          </span>
        </div>
        <div class="offline-banner-actions">
          <button class="action primary" onClick=${copy}>Copy command</button>
        </div>
      </div>
    </div>`;
}
