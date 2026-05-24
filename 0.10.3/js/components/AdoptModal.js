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
// Tabs across the top switch the upstream type. Below the tabs, an
// "Adopt as <CLI ▾>" chip filters the configured CLIs by matching
// `type` and reuses the global PickerPanel popover. A search box
// filters rows by title + cwd. Each row is a card with the prompt
// summary, cwd, age, and an Import button.

import { html } from '../html.js';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { Modal } from './Modal.js';
import { Popover } from './Popover.js';
import { PickerPanel } from './Picker.js';
import { config } from '../state.js';
import { listLocalCliSessions, adoptSession } from '../api.js';
import { setToast } from '../toast.js';
import {
  IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor,
  IconSearch, IconClose, IconChevronDown, IconBranch,
} from '../icons.js';

const TABS = [
  { type: 'claude',  label: 'Claude',  Icon: IconClaudeColor },
  { type: 'codex',   label: 'Codex',   Icon: IconCodexColor },
  { type: 'copilot', label: 'Copilot', Icon: IconCopilotColor },
];

export function AdoptModal({ onClose, onAdopted }) {
  const [tab, setTab] = useState('claude');
  const [cache, setCache] = useState({});             // { type: { loading, error, items } }
  const [adopting, setAdopting] = useState(null);     // cliSessionId being adopted
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cliOverride, setCliOverride] = useState({}); // type → user-picked cli id
  const cliAnchorRef = useRef(null);

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
  // Clear search when switching tabs
  useEffect(() => { setQuery(''); }, [tab]);

  const cfg = config.value || {};
  const clis = cfg.clis || [];
  // CLIs of the same upstream `type` as the active tab — these are the
  // ones the row's `--resume <id>` template will actually work with.
  const matchingClis = useMemo(
    () => clis.filter((c) => c.type === tab),
    [clis, tab],
  );

  // Effective CLI for the current tab: user override → first matching
  // → configured default → first cli.
  const effectiveCliId =
    cliOverride[tab]
    || matchingClis[0]?.id
    || cfg.defaultCliId
    || clis[0]?.id
    || '';
  const effectiveCli = clis.find((c) => c.id === effectiveCliId) || null;

  // Items the picker shows — prefer same-type CLIs at top, then dim others.
  const pickerItems = useMemo(() => {
    const Icon = IconForCliType(tab);
    const top = matchingClis.map((c) => ({
      id: c.id,
      icon: html`<${Icon} />`,
      label: c.name,
      meta: c.command,
    }));
    const others = clis
      .filter((c) => c.type !== tab)
      .map((c) => {
        const I = IconForCliType(c.type);
        return {
          id: c.id,
          icon: html`<${I} />`,
          label: c.name,
          meta: `(non-${tab})`,
        };
      });
    return [...top, ...others];
  }, [clis, matchingClis, tab]);

  const state = cache[tab] || { loading: true, items: [], error: null };
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((it) => {
      const hay = `${it.summary || ''} ${it.cwd || ''} ${it.cliSessionId}`.toLowerCase();
      return hay.includes(q);
    });
  }, [state.items, query]);

  const unimportedCount = state.items.filter((it) => !it.adopted).length;

  const adopt = async (item) => {
    const cliId = effectiveCliId;
    if (!cliId) { setToast('configure a CLI first', 'error'); return; }
    setAdopting(item.cliSessionId);
    try {
      const r = await adoptSession({
        cliId,
        cliSessionId: item.cliSessionId,
        cwd: item.cwd,
        title: item.summary || '',
      });
      if (r.alreadyAdopted) setToast('already in ccsm — opened existing record');
      else setToast(`imported · ${item.cliSessionId.slice(0, 8)}…`);
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

  return html`
    <${Modal} title="Import existing session" onClose=${onClose} width=${680}>
      <div class="adopt">
        <!-- Tabs row -->
        <div class="adopt-tabs">
          ${TABS.map((t) => {
            const cnt = cache[t.type]?.items?.filter((x) => !x.adopted).length;
            return html`
              <button type="button" key=${t.type}
                      class=${`adopt-tab${tab === t.type ? ' is-active' : ''}`}
                      onClick=${() => setTab(t.type)}>
                <span class="adopt-tab-icon"><${t.Icon} /></span>
                <span>${t.label}</span>
                ${typeof cnt === 'number' && cnt > 0 ? html`
                  <span class="adopt-tab-count">${cnt}</span>
                ` : null}
              </button>`;
          })}
          <button type="button" class="adopt-icon-btn" title="Rescan"
                  onClick=${() => load(tab, { force: true })}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M2 8a6 6 0 0 1 10.3-4.2L14 2v4h-4l1.5-1.5A4.5 4.5 0 1 0 12.5 8H14a6 6 0 1 1-12 0z"
                    fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>

        <!-- Tools row: CLI picker + search -->
        <div class="adopt-tools">
          <button type="button" ref=${cliAnchorRef}
                  class=${`adopt-cli-pill${pickerOpen ? ' is-open' : ''}`}
                  onClick=${() => setPickerOpen((v) => !v)}>
            <span class="adopt-cli-pill-prefix">Adopt as</span>
            <span class="adopt-cli-pill-icon">
              ${effectiveCli ? html`${(() => {
                const I = IconForCliType(effectiveCli.type);
                return html`<${I} />`;
              })()}` : null}
            </span>
            <span class="adopt-cli-pill-name">${effectiveCli?.name || 'choose CLI'}</span>
            <${IconChevronDown} />
          </button>
          ${pickerOpen ? html`
            <${Popover} anchor=${cliAnchorRef} onClose=${() => setPickerOpen(false)} width=${300}>
              <${PickerPanel}
                title=${`CLI for ${tab} sessions`}
                items=${pickerItems}
                selectedId=${effectiveCliId}
                showSearch=${pickerItems.length > 6}
                emptyHint=${`No configured CLIs match ${tab}.`}
                onSelect=${(id) => { setCliOverride((m) => ({ ...m, [tab]: id })); }}
                onClose=${() => setPickerOpen(false)} />
            </${Popover}>` : null}

          <div class="adopt-search">
            <span class="adopt-search-icon"><${IconSearch} /></span>
            <input class="adopt-search-input"
                   placeholder=${state.loading ? 'Loading…' : `Search ${unimportedCount} sessions…`}
                   value=${query} disabled=${state.loading}
                   onInput=${(e) => setQuery(e.target.value)} />
            ${query ? html`
              <button class="adopt-search-clear" type="button"
                      onClick=${() => setQuery('')} title="Clear">
                <${IconClose} />
              </button>` : null}
          </div>
        </div>

        <!-- List body -->
        <div class="adopt-body">
          ${state.loading ? html`
            <div class="adopt-empty"><span class="adopt-empty-spinner"></span> Scanning…</div>
          ` : state.error ? html`
            <div class="adopt-empty adopt-error">${state.error}</div>
          ` : state.items.length === 0 ? html`
            <div class="adopt-empty">
              <div class="adopt-empty-mark">∅</div>
              No ${tab} sessions found on this machine.
            </div>
          ` : items.length === 0 ? html`
            <div class="adopt-empty">No matches for "${query}".</div>
          ` : html`
            <ul class="adopt-list">
              ${items.map((it) => html`
                <li class=${`adopt-row${it.adopted ? ' is-adopted' : ''}`}
                    key=${it.cliSessionId}>
                  <div class="adopt-row-main">
                    <div class="adopt-row-title">
                      ${it.summary || html`<span class="adopt-row-untitled">untitled session</span>`}
                    </div>
                    <div class="adopt-row-meta">
                      <span class="adopt-row-path mono" title=${it.cwd || ''}>${it.cwd || '—'}</span>
                      <span class="adopt-row-dot">·</span>
                      <span>${relTime(it.mtime)}</span>
                      <span class="adopt-row-dot">·</span>
                      <span class="adopt-row-id mono">${it.cliSessionId.slice(0, 8)}</span>
                    </div>
                  </div>
                  <div class="adopt-row-actions">
                    ${it.adopted ? html`
                      <span class="adopt-row-badge">Imported</span>
                    ` : html`
                      <button type="button" class="action primary adopt-row-btn"
                              disabled=${adopting === it.cliSessionId || !effectiveCliId}
                              onClick=${() => adopt(it)}>
                        ${adopting === it.cliSessionId ? 'Importing…' : 'Import'}
                      </button>
                    `}
                  </div>
                </li>`)}
            </ul>
          `}
        </div>
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
