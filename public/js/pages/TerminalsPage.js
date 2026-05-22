// Left rail · list of active web sessions + right pane with selected one's xterm.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { webTerminals, activeTerminalId, selectTab } from '../state.js';
import { loadWebTerminals, killWebTerminal } from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm } from '../dialog.js';
import { TerminalView } from '../components/TerminalView.js';
import { fmtAgo } from '../util.js';

export function TerminalsPage() {
  const list = webTerminals.value;
  const activeId = activeTerminalId.value;

  // Auto-select the first available terminal if nothing is active
  useEffect(() => {
    if (!activeId && list.length > 0) activeTerminalId.value = list[0].id;
    if (activeId && !list.find((t) => t.id === activeId)) {
      activeTerminalId.value = list[0]?.id || null;
    }
  }, [list.map((t) => t.id).join('|'), activeId]);

  if (list.length === 0) {
    return html`
      <div class="terminal-empty-page">
        <div class="card">
          <div class="card-body" style="text-align: center; padding: 60px var(--s-6);">
            <p style="font-size: 14px; color: var(--ink-mid); margin-bottom: var(--s-4);">
              No terminals open yet.
            </p>
            <button class="action primary" onClick=${() => selectTab('launch')}>
              + Launch a session
            </button>
          </div>
        </div>
      </div>`;
  }

  return html`
    <div class="terminals-layout">
      <aside class="terminals-rail">
        <div class="terminals-rail-head">
          <span>${list.length} active</span>
          <button class="action subtle tiny" title="refresh list" onClick=${() => loadWebTerminals()}>↻</button>
        </div>
        ${list.map((t) => html`
          <button key=${t.id} class=${`terminal-row${activeId === t.id ? ' is-active' : ''}`}
                  onClick=${() => (activeTerminalId.value = t.id)}>
            <span class=${`status-mark ${t.exitedAt ? 'unknown' : 'busy'}`}></span>
            <span class="terminal-row-title">${t.meta.title || t.id.slice(0, 12)}</span>
            <span class="terminal-row-meta">${fmtAgo(t.meta.startedAt)}</span>
            <span class="terminal-row-actions">
              <button class="action tiny danger" title="kill this session"
                      onClick=${(ev) => { ev.stopPropagation(); confirmKill(t); }}>×</button>
            </span>
          </button>`)}
      </aside>
      <main class="terminals-main">
        <${TerminalView} terminalId=${activeId} />
      </main>
    </div>`;
}

async function confirmKill(t) {
  const ok = await ccsmConfirm(`Kill ${t.meta.title || t.id}? The PTY process will be terminated.`, {
    title: 'Kill session', okLabel: 'Kill', danger: true,
  });
  if (!ok) return;
  try {
    await killWebTerminal(t.id);
    setToast(`killed · ${t.id.slice(0, 12)}`);
  } catch (e) { setToast(e.message, 'error'); }
}
