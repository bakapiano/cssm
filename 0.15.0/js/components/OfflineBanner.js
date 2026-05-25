// Fullscreen overlay shown when the backend is offline. Blocks
// interaction with the rest of the UI until backend comes back.
//
// The hosted frontend (https://bakapiano.github.io/ccsm/v1/) can't
// spawn processes directly, so we surface a ccsm://start link instead.
// Windows hands that off to the registered protocol handler
// (ccsm.cmd), which spawns the backend silently. Our health probe
// picks it up on the next tick and the overlay auto-hides.
//
// First click triggers a Windows confirmation dialog ("Open ccsm.cmd?").
// User can check "Always allow" to suppress future prompts.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { serverHealth } from '../state.js';
import { refreshAll, pollHealth } from '../api.js';
import { BrandMark } from '../icons.js';

// Silent ccsm:// launch via hidden iframe. Same trick as the router.
// If the protocol is registered AND the user has already OK'd the
// Windows confirmation prompt, ccsm wakes up within ~2s and the
// banner auto-dismisses on the next health poll. On a cold first
// visit (protocol not registered, or "Always allow" not yet ticked),
// the iframe noops silently and the manual "Start ccsm" button is
// still there as fallback.
function silentProtocolLaunch() {
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = 'ccsm://start';
    document.body.appendChild(f);
    setTimeout(() => { try { f.remove(); } catch {} }, 1500);
  } catch {}
}

export function OfflineBanner() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const [clicked, setClicked] = useState(false);
  const [autoTried, setAutoTried] = useState(false);

  // First time we see offline state, try a silent ccsm:// launch and
  // tighten the health-poll cadence for a few seconds so the redirect
  // happens within ~2-3s without any visible UI flash.
  useEffect(() => {
    if (!offline || autoTried) return;
    setAutoTried(true);
    silentProtocolLaunch();
    let n = 0;
    const tick = async () => {
      if (n++ > 12) return;                  // ~6s of tight polling
      await pollHealth();
      if (serverHealth.value.state === 'online') return;
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }, [offline]);

  useEffect(() => {
    if (h.state === 'online' && clicked) {
      refreshAll().catch(() => {});
      setClicked(false);
    }
  }, [h.state, clicked]);

  if (!offline) return null;

  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-labelledby="offline-title">
      <div class="offline-card">
        <div class="offline-brand"><${BrandMark} /></div>
        <h1 id="offline-title" class="offline-title">Backend not running</h1>
        <p class="offline-copy">
          ccsm's local backend isn't reachable. Click Start to launch it —
          Windows may ask for permission once. Tick <em>Always allow</em>
          to silence future prompts.
        </p>
        <div class="offline-actions">
          <a class="action primary big" href="ccsm://start"
             onClick=${() => setClicked(true)}>Start ccsm</a>
        </div>
        <details class="offline-fallback">
          <summary>Don't have ccsm installed?</summary>
          <div class="offline-fallback-body">
            <p>Install once via npm, then come back here:</p>
            <pre><code>npm i -g @bakapiano/ccsm</code></pre>
            <p>Or run a one-shot trial without installing:</p>
            <pre><code>npx @bakapiano/ccsm</code></pre>
          </div>
        </details>
      </div>
    </div>`;
}
