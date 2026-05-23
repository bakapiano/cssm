// Settings form. Edits to inputs mark configDirty until Save / Discard.
// We write to a draft signal to avoid clobbering server-side state mid-edit;
// the draft initialises from config.value the first time configure tab mounts
// and after each successful save.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { config, terminals, configDirty, accentColor, setAccentColor, ACCENT_DEFAULT } from '../state.js';
import { api, loadWorkspaces } from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm } from '../dialog.js';
import { Card } from '../components/Card.js';
import { ReposEditor, addEmptyRepo } from '../components/ReposEditor.js';

function defaultsFrom(cfg) {
  if (!cfg) return null;
  return {
    port: cfg.port,
    workDir: cfg.workDir,
    snapshotIntervalMs: cfg.snapshotIntervalMs,
    snapshotHistoryKeep: cfg.snapshotHistoryKeep,
    claudeCommand: cfg.claudeCommand || 'claude',
    terminal: cfg.terminal,
    commandShell: cfg.commandShell || 'pwsh',
    defaultTerminalMode: cfg.defaultTerminalMode || 'wt',
    autoFocusOnLaunch: cfg.autoFocusOnLaunch !== false,
    focusMovesToCenter: cfg.focusMovesToCenter === true,
    browserMode: cfg.browserMode || (cfg.autoOpenBrowser === false ? 'none' : 'app'),
    finderPrompt: cfg.finderPrompt || '',
  };
}

export function ConfigurePage() {
  const cfg = config.value;
  const [draft, setDraft] = useState(() => defaultsFrom(cfg));
  const [savedAt, setSavedAt] = useState('');

  // re-init from config whenever a fresh load lands (rare — typically only at boot,
  // after Save, or after Discard). We compare a stringified snapshot so re-renders
  // from unrelated signals don't reset our in-progress edits.
  useEffect(() => {
    if (!cfg) return;
    if (!draft) { setDraft(defaultsFrom(cfg)); return; }
  }, [cfg]);

  if (!cfg || !draft) return null;

  const update = (patch) => {
    setDraft({ ...draft, ...patch });
    configDirty.value = true;
  };

  const reposChanged = () => {
    configDirty.value = true;
  };

  const onSave = async () => {
    const next = {
      ...draft,
      port: Number(draft.port) || 7777,
      snapshotIntervalMs: Math.max(5000, Number(draft.snapshotIntervalMs) || 60000),
      snapshotHistoryKeep: Math.max(1, Number(draft.snapshotHistoryKeep) || 30),
      claudeCommand: (draft.claudeCommand || 'claude').trim(),
      terminal: draft.terminal || 'wt',
      commandShell: draft.commandShell || 'pwsh',
      defaultTerminalMode: draft.defaultTerminalMode === 'web' ? 'web' : 'wt',
      browserMode: draft.browserMode || 'app',
      workDir: (draft.workDir || '').trim(),
      repos: (cfg.repos || []).filter((r) => r.name && r.url),
    };
    try {
      const saved = await api('PUT', '/api/config', next);
      config.value = saved;
      setDraft(defaultsFrom(saved));
      setSavedAt(`saved · ${new Date().toLocaleTimeString(undefined, { hour12: false })}`);
      configDirty.value = false;
      setToast('config saved');
      await loadWorkspaces();
    } catch (e) { setToast(e.message, 'error'); }
  };

  const onDiscard = async () => {
    const ok = await ccsmConfirm('Discard your unsaved changes?', {
      title: 'Discard changes', okLabel: 'Discard', danger: true,
    });
    if (!ok) return;
    const fresh = await api('GET', '/api/config');
    config.value = fresh;
    setDraft(defaultsFrom(fresh));
    configDirty.value = false;
    setToast('changes discarded');
  };

  return html`
    ${configDirty.value ? html`
      <div class="dirty-banner">
        <span class="dirty-dot"></span>
        <span class="dirty-text">You have unsaved changes</span>
        <button class="action small primary" onClick=${onSave}>Save now</button>
        <button class="action small subtle" onClick=${onDiscard}>Discard</button>
      </div>` : null}

    <${Card} title="Settings" meta=${html`Persisted to <code>~/.ccsm/config.json</code>`}>
      <div class="config-grid">
        <label class="field">
          <span class="label">Port</span>
          <input type="number" value=${draft.port}
                 onInput=${(e) => update({ port: e.target.value })} />
          <span class="hint">restart server to apply</span>
        </label>
        <label class="field">
          <span class="label">Work directory</span>
          <input type="text" value=${draft.workDir}
                 onInput=${(e) => update({ workDir: e.target.value })} />
        </label>
        <label class="field">
          <span class="label">Snapshot interval (ms)</span>
          <input type="number" min="5000" value=${draft.snapshotIntervalMs}
                 onInput=${(e) => update({ snapshotIntervalMs: e.target.value })} />
        </label>
        <label class="field">
          <span class="label">History kept</span>
          <input type="number" min="1" value=${draft.snapshotHistoryKeep}
                 onInput=${(e) => update({ snapshotHistoryKeep: e.target.value })} />
        </label>
        <label class="field">
          <span class="label">Claude command</span>
          <input type="text" placeholder="claude" value=${draft.claudeCommand}
                 onInput=${(e) => update({ claudeCommand: e.target.value })} />
          <span class="hint">alias / function / exe name</span>
        </label>
        <label class="field">
          <span class="label">Default mode <span class="hint inline">(new · resume · continue · finder)</span></span>
          <select class="input" value=${draft.defaultTerminalMode}
                  onChange=${(e) => update({ defaultTerminalMode: e.target.value })}>
            <option value="wt">system terminal · open a real ${draft.terminal || 'wt'} window</option>
            <option value="web">web · in-page xterm under the Terminals tab</option>
          </select>
          <span class="hint">web requires node-pty; per-launch radios can override</span>
        </label>
        <label class="field">
          <span class="label">Terminal</span>
          <select class="input" value=${draft.terminal}
                  onChange=${(e) => update({ terminal: e.target.value })}>
            ${(terminals.value || []).map((t) => html`
              <option key=${t.name} value=${t.name}>${t.name} · ${t.processName}</option>`)}
          </select>
        </label>
        <label class="field">
          <span class="label">Command shell <span class="hint inline">(wt only)</span></span>
          <select class="input" value=${draft.commandShell}
                  onChange=${(e) => update({ commandShell: e.target.value })}>
            <option value="pwsh">pwsh · PowerShell 7</option>
            <option value="powershell">powershell · Windows PowerShell 5.1</option>
            <option value="none">none · run command directly</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Browser open mode</span>
          <select class="input" value=${draft.browserMode}
                  onChange=${(e) => update({ browserMode: e.target.value })}>
            <option value="app">app · Edge/Chrome chromeless</option>
            <option value="tab">tab · default browser</option>
            <option value="none">off · don't open</option>
          </select>
        </label>
        <label class="field toggle">
          <input type="checkbox" checked=${draft.autoFocusOnLaunch}
                 onChange=${(e) => update({ autoFocusOnLaunch: e.target.checked })} />
          <span class="toggle-text">
            <span class="label">Auto-focus on launch</span>
            <span class="hint">raise newly-launched terminal window</span>
          </span>
        </label>
        <label class="field toggle">
          <input type="checkbox" checked=${draft.focusMovesToCenter}
                 onChange=${(e) => update({ focusMovesToCenter: e.target.checked })} />
          <span class="toggle-text">
            <span class="label">Move focused window to screen center</span>
            <span class="hint">centers the focused window on whichever monitor the cursor is on</span>
          </span>
        </label>
        <label class="field full">
          <span class="label">Finder prompt</span>
          <textarea rows="3" value=${draft.finderPrompt}
                    onInput=${(e) => update({ finderPrompt: e.target.value })}></textarea>
          <span class="hint">passed as initial prompt to the finder session</span>
        </label>

        <div class="field">
          <span class="label">Theme accent</span>
          <${AccentPicker} />
          <span class="hint">also tints the OS title bar (theme-color)</span>
        </div>

        <div class="field full">
          <div class="repos-head">
            <span class="label">Repositories</span>
            <button class="action small" onClick=${() => { addEmptyRepo(reposChanged); }}>+ Add repo</button>
          </div>
          <${ReposEditor} onChange=${reposChanged} />
        </div>

        <div class="form-actions full">
          <button class=${`action primary${configDirty.value ? ' is-dirty' : ''}`}
                  onClick=${onSave}>Save configuration</button>
          <span class="muted-text">${savedAt}</span>
        </div>
      </div>
    </${Card}>`;
}

// Curated preset palette + free hex input. Each preset is a hand-picked
// brand color that reads well on the cream surface. Selecting a swatch
// applies immediately via setAccentColor (which writes CSS vars +
// localStorage) — no save button needed since this is a per-browser
// UI preference, not part of the server-side config.
const PRESETS = [
  { name: 'Claude copper', hex: '#b3614a' },   // default
  { name: 'Anthropic ink', hex: '#1a1815' },
  { name: 'Ocean',         hex: '#2f6fa3' },
  { name: 'Forest',        hex: '#3f7a4a' },
  { name: 'Amber',         hex: '#c4892b' },
  { name: 'Berry',         hex: '#a44b78' },
  { name: 'Slate',         hex: '#4a5563' },
  { name: 'Crimson',       hex: '#b73f3f' },
];

function AccentPicker() {
  const current = accentColor.value;
  const [text, setText] = useState(current);
  // Keep the text input in sync if the signal changes from elsewhere
  // (preset click, reset). useState would otherwise drift on subsequent
  // applies. eslint-disable-next-line — intentionally re-syncing on prop change.
  useEffect(() => { setText(current); }, [current]);

  const onText = (e) => {
    const v = e.target.value.trim();
    setText(v);
    // Apply live only when it's a valid hex; otherwise let the user
    // keep typing without flicker.
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setAccentColor(v);
  };

  return html`
    <div class="accent-picker">
      <div class="accent-swatches">
        ${PRESETS.map((p) => html`
          <button key=${p.hex} class=${`accent-swatch${current.toLowerCase() === p.hex.toLowerCase() ? ' is-active' : ''}`}
                  style=${`background:${p.hex}`}
                  title=${`${p.name} · ${p.hex}`}
                  aria-label=${p.name}
                  onClick=${() => setAccentColor(p.hex)}></button>`)}
      </div>
      <div class="accent-custom">
        <input type="color" value=${current}
               onInput=${(e) => setAccentColor(e.target.value)} />
        <input type="text" class="accent-hex" value=${text}
               spellcheck="false" maxlength="7"
               onInput=${onText} placeholder="#rrggbb" />
        <button class="action subtle small"
                onClick=${() => setAccentColor(ACCENT_DEFAULT)}>Reset</button>
      </div>
    </div>`;
}
