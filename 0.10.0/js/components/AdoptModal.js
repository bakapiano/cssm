// "Import existing session" modal. Browses sessions discovered on disk
// for claude / codex / copilot, lets the user pick one, choose which
// configured CLI it should be tied to, and adopts it — a ccsm
// persistedSessions record is created with the upstream session id
// pre-filled so clicking it later runs `<cli> --resume <id>` (via
// cli.resumeIdArgs).
//
// Props:
//   onClose()                    — close request
//   onAdopted(sessionId)         — fires after a successful adopt with
//                                  the new (or pre-existing) record id
//
// Shows a row of cli-type tabs at the top. Each tab loads on first
// click. Adopted rows are greyed out and labelled.

import { html } from '../html.js';
import { useState, useEffect } from 'preact/hooks';
import { Modal } from './Modal.js';
import { config } from '../state.js';
import { listLocalCliSessions, adoptSession } from '../api.js';
import { setToast } from '../toast.js';
import { IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor } from '../icons.js';

const TABS = [
  { type: 'claude',  label: 'Claude',  Icon: IconClaudeColor },
  { type: 'codex',   label: 'Codex',   Icon: IconCodexColor },
  { type: 'copilot', label: 'Copilot', Icon: IconCopilotColor },
];

export function AdoptModal({ onClose, onAdopted }) {
  const [tab, setTab] = useState('claude');
  // cache per tab so flipping back is instant
  const [cache, setCache] = useState({}); // { claude: {loading, error, items} }
  const [adopting, setAdopting] = useState(null); // cliSessionId being adopted

  const load = async (type, { force = false } = {}) => {
    if (!force && cache[type] && !cache[type].error) return;
    setCache((c) => ({ ...c, [type]: { loading: true, items: [], error: null } }));
    try {
      const items = await listLocalCliSessions(type);
      setCache((c) => ({ ...c, [type]: { loading: false, items, error: null } }));
    } catch (e) {
      setCache((c) => ({ ...c, [type]: { loading: false, items: [], error: e.message } }));
    }
  };

  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

  const cfg = config.value || {};
  const clis = cfg.clis || [];
  // Pick first matching configured CLI for the current upstream type; fall
  // back to the configured default. Users can change per-row via the select.
  const defaultCliFor = (type) => {
    const match = clis.find((c) => c.type === type);
    if (match) return match.id;
    return cfg.defaultCliId || clis[0]?.id || '';
  };
  const [chosenCli, setChosenCli] = useState({}); // cliSessionId → cli id override

  const adopt = async (item) => {
    const cliId = chosenCli[item.cliSessionId] || defaultCliFor(item.cliType);
    if (!cliId) { setToast('configure a CLI first', 'error'); return; }
    setAdopting(item.cliSessionId);
    try {
      const r = await adoptSession({
        cliId,
        cliSessionId: item.cliSessionId,
        cwd: item.cwd,
        title: item.summary || '',
      });
      if (r.alreadyAdopted) {
        setToast('already in ccsm — opened existing record');
      } else {
        setToast(`imported · ${item.cliSessionId.slice(0, 8)}…`);
      }
      // Mark adopted in the cache so the UI updates instantly.
      setCache((c) => ({
        ...c,
        [tab]: c[tab] ? {
          ...c[tab],
          items: c[tab].items.map((x) => x.cliSessionId === item.cliSessionId
            ? { ...x, adopted: true } : x),
        } : c[tab],
      }));
      onAdopted?.(r.session?.id);
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setAdopting(null);
    }
  };

  const state = cache[tab] || { loading: true, items: [], error: null };

  return html`
    <${Modal} title="Import existing session" onClose=${onClose} width=${640}>
      <div class="adopt-tabs">
        ${TABS.map((t) => html`
          <button type="button"
                  class=${`adopt-tab${tab === t.type ? ' is-active' : ''}`}
                  onClick=${() => setTab(t.type)}>
            <span class="adopt-tab-icon"><${t.Icon} /></span>
            <span>${t.label}</span>
          </button>`)}
        <button type="button" class="action subtle adopt-refresh"
                title="Rescan"
                onClick=${() => load(tab, { force: true })}>Refresh</button>
      </div>

      <div class="adopt-body">
        ${state.loading ? html`
          <div class="adopt-empty">Scanning…</div>
        ` : state.error ? html`
          <div class="adopt-empty adopt-error">${state.error}</div>
        ` : state.items.length === 0 ? html`
          <div class="adopt-empty">No ${tab} sessions found on this machine.</div>
        ` : html`
          <ul class="adopt-list">
            ${state.items.map((it) => html`
              <li class=${`adopt-item${it.adopted ? ' is-adopted' : ''}`}
                  key=${it.cliSessionId}>
                <div class="adopt-main">
                  <div class="adopt-title">
                    ${it.summary || html`<span class="ink-faint">(no preview)</span>`}
                  </div>
                  <div class="adopt-meta mono">
                    ${it.cwd}
                    <span class="adopt-sep">·</span>
                    ${relTime(it.mtime)}
                    <span class="adopt-sep">·</span>
                    ${it.cliSessionId.slice(0, 8)}…
                  </div>
                </div>
                <div class="adopt-actions">
                  ${clis.length > 1 ? html`
                    <select class="adopt-cli-select"
                            value=${chosenCli[it.cliSessionId] || defaultCliFor(it.cliType)}
                            onChange=${(e) => setChosenCli((m) => ({ ...m, [it.cliSessionId]: e.target.value }))}
                            disabled=${it.adopted}>
                      ${clis.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
                    </select>
                  ` : null}
                  ${it.adopted ? html`
                    <span class="adopt-badge">Imported</span>
                  ` : html`
                    <button type="button" class="action primary adopt-btn"
                            disabled=${adopting === it.cliSessionId}
                            onClick=${() => adopt(it)}>
                      ${adopting === it.cliSessionId ? 'Importing…' : 'Import'}
                    </button>
                  `}
                </div>
              </li>`)}
          </ul>
        `}
      </div>
    </${Modal}>`;
}

function relTime(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
