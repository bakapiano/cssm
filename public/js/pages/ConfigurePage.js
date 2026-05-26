// Settings page · summary lists of CLIs / Repos / Folders + General
// (port / work dir / theme). Each row has Edit + Delete; "+ Add"
// opens the same modal form used inline-from-launch.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import {
  config, configDirty, accentColor, folders, workspaces,
  setAccentColor, ACCENT_DEFAULT,
} from '../state.js';
import {
  api, loadConfig, loadWorkspaces, loadFolders,
  createCli, updateCli, deleteCli, setDefaultCli, testCli,
  createRepo, updateRepo, deleteRepo,
  createFolder, renameFolder, deleteFolder, reorderFolders,
  deleteWorkspace, restartBackend,
} from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm } from '../dialog.js';
import { keybindings, setBinding, resetBinding, ACTIONS, formatCombo } from '../keybindings.js';
import { KeybindingRecorder } from '../components/KeybindingRecorder.js';
import { Card } from '../components/Card.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { EntityFormModal } from '../components/EntityFormModal.js';
import { useDragSort } from '../components/useDragSort.js';
import { IconPlus, IconPencil, IconClose, IconTerminal, IconFolder, IconBranch, IconRefresh, IconChevronUp, IconChevronDown, IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor } from '../icons.js';

// Type → smart defaults. Choosing a type in the form auto-fills resumeArgs
// (and command if blank) so users don't need to remember the per-CLI flag.
const CLI_TYPE_DEFAULTS = {
  claude:  { command: 'claude',  resumeIdArgs: '--resume <id>', newSessionIdArgs: '--session-id <id>' },
  codex:   { command: 'codex',   resumeIdArgs: 'resume <id>',   newSessionIdArgs: 'resume <id>' },
  copilot: { command: 'copilot', resumeIdArgs: '--resume <id>', newSessionIdArgs: '--session-id <id>' },
  other:   { resumeIdArgs: '', newSessionIdArgs: '' },
};

function cliFieldsFor({ creating } = {}) {
  return [
    { key: 'type', label: 'Type', type: 'iconRadio', default: 'other', options: [
      { value: 'claude',  label: 'Claude CLI',     icon: html`<${IconClaudeColor} />` },
      { value: 'codex',   label: 'Codex CLI',      icon: html`<${IconCodexColor} />` },
      { value: 'copilot', label: 'GitHub Copilot', icon: html`<${IconCopilotColor} />` },
      { value: 'other',   label: 'Other',          icon: html`<${IconTerminal} />` },
    ],
      // Type-change side effects. For known types we force the
      // integration args (newSessionIdArgs / resumeIdArgs) to the
      // canonical template — those fields are locked anyway so
      // there's no value in leaving stale strings around. For
      // type='other' we leave existing args alone so the user can
      // keep editing them. Name + command are only prefilled when
      // creating (don't clobber a saved CLI's name on edit).
      onChange: (v, next) => {
        const d = CLI_TYPE_DEFAULTS[v];
        if (!d) return null;
        const patch = {};
        if (v !== 'other') {
          patch.resumeIdArgs = d.resumeIdArgs;
          patch.newSessionIdArgs = d.newSessionIdArgs;
        }
        if (creating) {
          if (!next.command || !next.command.trim()) patch.command = d.command || '';
          if (!next.name || !next.name.trim()) {
            patch.name = v === 'claude' ? 'Claude Code'
                       : v === 'codex' ? 'OpenAI Codex'
                       : v === 'copilot' ? 'GitHub Copilot'
                       : '';
          }
        }
        return patch;
      },
    },
    { key: 'name', label: 'Name', placeholder: 'My CLI', required: true },
    { key: 'command', label: 'Command', mono: true, placeholder: 'ccp / claude / ...', required: true },
    { key: 'args', label: 'Args (space-separated)', mono: true, placeholder: '',
      hint: 'Used on every launch.' },
    { key: 'newSessionIdArgs', label: 'New session id args', mono: true, placeholder: '--session-id <id>',
      // Lock for known types — those args are an integration contract
      // with the upstream CLI, not a user knob. Only Type=Other allows
      // a custom value (for hand-rolled CLIs ccsm doesn't ship a
      // template for).
      readOnly: (d) => d.type && d.type !== 'other',
      hint: (d) => d.type && d.type !== 'other'
        ? `Locked to the canonical flags for ${d.type}. Change Type to "Other" to override.`
        : 'ccsm pre-generates a UUID and substitutes it for <id> on first launch — the upstream CLI session id is known immediately.' },
    { key: 'resumeIdArgs', label: 'Resume by id args', mono: true, placeholder: '--resume <id>',
      readOnly: (d) => d.type && d.type !== 'other',
      hint: (d) => d.type && d.type !== 'other'
        ? `Locked to the canonical flags for ${d.type}. Change Type to "Other" to override.`
        : 'Used on every resume. Substitutes <id> with the captured session UUID.' },
    { key: 'shell', label: 'Shell', type: 'select', default: 'direct', options: [
      { value: 'direct', label: 'direct (real .exe / .cmd)' },
      { value: 'pwsh',   label: 'pwsh (PowerShell aliases & functions)' },
      { value: 'cmd',    label: 'cmd (doskey)' },
    ] },
  ];
}

function Section({ title, meta, children }) {
  return html`
    <section class="settings-section">
      <header class="settings-section-head">
        <h2 class="settings-section-title">${title}</h2>
        ${meta ? html`<p class="settings-section-meta">${meta}</p>` : null}
      </header>
      <div class="settings-section-body">${children}</div>
    </section>`;
}

// ── Field definitions shared with Launch picker ──────────────────────
// (CLI fields built lazily via cliFieldsFor — see above.)

const repoFields = [
  { key: 'name', label: 'Name', placeholder: 'my-repo', autoFocus: true, required: true },
  { key: 'url',  label: 'URL', mono: true, placeholder: 'https://github.com/me/foo.git', required: true },
  { key: 'defaultSelected', label: 'Pre-select on launch', type: 'checkbox',
    hint: 'Auto-checked in the Repos picker for new sessions' },
];

const folderFields = [
  { key: 'name', label: 'Folder name', placeholder: 'Work / Personal / ...', autoFocus: true, required: true },
];

// ── Page ─────────────────────────────────────────────────────────────
export function ConfigurePage() {
  const cfg = config.value;
  const [edit, setEdit] = useState(null); // { kind, payload? }
  const [general, setGeneral] = useState(null);
  const [savedAt, setSavedAt] = useState('');

  const folderDnd = useDragSort(
    folders.value.map((f) => f.id),
    async (nextIds) => {
      try { await reorderFolders(nextIds); }
      catch (e) { setToast(e.message, 'error'); }
    },
  );

  useEffect(() => {
    if (cfg && !general) {
      setGeneral({ workDir: cfg.workDir });
    }
  }, [cfg]);

  if (!cfg || !general) return null;

  const saveGeneral = async (patch) => {
    const merged = { ...general, ...patch };
    setGeneral(merged);
    try {
      const saved = await api('PUT', '/api/config', {
        ...cfg,
        workDir: (merged.workDir || '').trim(),
      });
      config.value = saved;
      setToast('saved');
      await loadWorkspaces();
    } catch (e) { setToast(e.message, 'error'); }
  };

  const close = () => setEdit(null);

  return html`
    <${PageTitleBar} title="Settings" />
    <div class="settings-scroll">

    <${Section} title="General">
      <div class="config-grid">
        <div class="field">
          <span class="label">Theme accent</span>
          <${AccentPicker} />
        </div>
        <div class="field">
          <span class="label">Backend</span>
          <${RestartButton} />
        </div>
      </div>
    </${Section}>

    <${Section} title="CLIs" meta=${html`Built-in entries (<code>claude</code>, <code>codex</code>) auto-probe your PATH.`}>
      <${EntityList}
        kind="cli"
        addLabel="Add CLI"
        items=${(cfg.clis || []).map((c) => {
          const tags = [];
          if (cfg.defaultCliId === c.id) tags.push({ label: 'default', tone: 'accent' });
          if (c.builtin) tags.push({ label: c.installed ? 'installed' : 'not found', tone: c.installed ? 'ok' : 'warn' });
          const Icon = IconForCliType(c.type);
          return {
            id: c.id,
            icon: html`<${Icon} />`,
            primary: c.name,
            secondary: html`<span class="mono">${c.command}${c.args?.length ? ' ' + c.args.join(' ') : ''}</span>${c.shell && c.shell !== 'direct' ? html` · ${c.shell}` : null}`,
            badges: tags,
            undeletable: c.builtin,
            raw: c,
          };
        })}
        onAdd=${() => setEdit({ kind: 'cli-new' })}
        onEdit=${(it) => setEdit({ kind: 'cli-edit', payload: it.raw })}
        onDelete=${async (it) => {
          if (it.undeletable) return setToast(`"${it.primary}" is built-in and can't be deleted`, 'error');
          if (cfg.clis.length === 1) return setToast('cannot delete the last CLI', 'error');
          const ok = await ccsmConfirm(`Delete CLI "${it.primary}"?`, { okLabel: 'Delete', danger: true });
          if (!ok) return;
          try { await deleteCli(it.id); setToast('deleted'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        onActivate=${async (it) => {
          if (cfg.defaultCliId === it.id) return;
          try { await setDefaultCli(it.id); setToast(`default · ${it.primary}`); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="No CLIs configured."
      />
    </${Section}>

    <${Section} title="Repositories" meta="Available for clone-on-launch into a new workspace.">
      <${EntityList}
        kind="repo"
        addLabel="Add Repo"
        items=${(cfg.repos || []).map((r) => ({
          id: r.name,
          icon: html`<${IconBranch} />`,
          primary: r.name,
          secondary: html`<span class="mono">${r.url}</span>`,
          badge: r.defaultSelected ? 'auto' : null,
          raw: r,
        }))}
        onAdd=${() => setEdit({ kind: 'repo-new' })}
        onEdit=${(it) => setEdit({ kind: 'repo-edit', payload: it.raw })}
        onDelete=${async (it) => {
          const ok = await ccsmConfirm(`Remove repo "${it.primary}" from the list?`, { okLabel: 'Remove', danger: true });
          if (!ok) return;
          try { await deleteRepo(it.id); setToast('removed'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="No repos configured."
      />
    </${Section}>

    <${Section} title="Folders" meta="Buckets that group sessions in the sidebar.">
      <${EntityList}
        kind="folder"
        addLabel="Add Folder"
        dnd=${folderDnd}
        items=${folders.value.map((f) => ({
          id: f.id,
          icon: html`<${IconFolder} />`,
          primary: f.name,
          secondary: null,
          raw: f,
        }))}
        onAdd=${() => setEdit({ kind: 'folder-new' })}
        onEdit=${(it) => setEdit({ kind: 'folder-edit', payload: it.raw })}
        onDelete=${async (it) => {
          const ok = await ccsmConfirm(`Delete folder "${it.primary}"? Sessions inside move to Unsorted.`, { okLabel: 'Delete', danger: true });
          if (!ok) return;
          try { await deleteFolder(it.id); setToast('deleted'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="No folders yet."
      />
    </${Section}>

    <${Section} title="Workspaces"
                meta=${html`Auto-allocated <code>ws-N</code> folders under the work directory. Each holds one or more repo clones.`}>
      <div class="config-grid">
        <label class="field">
          <span class="label">Work directory</span>
          <input type="text" value=${general.workDir}
                 onChange=${(e) => saveGeneral({ workDir: e.target.value })} />
        </label>
      </div>
      <${WorkspaceList} />
    </${Section}>

    <${Section} title="Keyboard shortcuts"
                meta="Click a binding to record a new combo. Press Esc to cancel.">
      <${KeybindingsList} />
    </${Section}>

    </div>

    ${edit?.kind === 'cli-new' ? html`
      <${EntityFormModal} title="New CLI" fields=${cliFieldsFor({ creating: true })}
        onClose=${close} submitLabel="Create"
        onTest=${(v) => testCli({ command: v.command, shell: v.shell, type: v.type })}
        onSubmit=${async (v) => {
          try { await createCli(v); setToast(`created CLI · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'cli-edit' ? html`
      <${EntityFormModal} title=${`Edit ${edit.payload.name}`} fields=${cliFieldsFor()}
        readOnlyKeys=${edit.payload.builtin ? ['type'] : []}
        initial=${{
          ...edit.payload,
          args: (edit.payload.args || []).join(' '),
          resumeIdArgs: (edit.payload.resumeIdArgs || []).join(' '),
          newSessionIdArgs: (edit.payload.newSessionIdArgs || []).join(' '),
        }}
        onClose=${close}
        onTest=${(v) => testCli({ command: v.command, shell: v.shell, type: v.type })}
        onSubmit=${async (v) => {
          try {
            const patch = {
              ...v,
              args: typeof v.args === 'string' ? v.args.split(/\s+/).filter(Boolean) : v.args,
              resumeIdArgs: typeof v.resumeIdArgs === 'string' ? v.resumeIdArgs.split(/\s+/).filter(Boolean) : v.resumeIdArgs,
              newSessionIdArgs: typeof v.newSessionIdArgs === 'string' ? v.newSessionIdArgs.split(/\s+/).filter(Boolean) : v.newSessionIdArgs,
            };
            await updateCli(edit.payload.id, patch);
            setToast('saved');
          } catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'repo-new' ? html`
      <${EntityFormModal} title="New repo" fields=${repoFields}
        onClose=${close} submitLabel="Add"
        onSubmit=${async (v) => {
          try { await createRepo(v); setToast(`added repo · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'repo-edit' ? html`
      <${EntityFormModal} title=${`Edit ${edit.payload.name}`} fields=${repoFields}
        initial=${edit.payload}
        onClose=${close}
        onSubmit=${async (v) => {
          try { await updateRepo(edit.payload.name, v); setToast('saved'); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'folder-new' ? html`
      <${EntityFormModal} title="New folder" fields=${folderFields}
        onClose=${close} submitLabel="Create"
        onSubmit=${async (v) => {
          try { await createFolder(v.name); await loadFolders(); setToast(`created folder · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'folder-edit' ? html`
      <${EntityFormModal} title=${`Rename ${edit.payload.name}`} fields=${folderFields}
        initial=${edit.payload}
        onClose=${close}
        onSubmit=${async (v) => {
          try { await renameFolder(edit.payload.id, v.name.trim()); await loadFolders(); setToast('renamed'); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}
  `;
}

// Generic "list of rows + Add button" used by all three sections.
function EntityList({ items, onAdd, onEdit, onDelete, onActivate, emptyHint, dnd, addLabel = 'Add' }) {
  return html`
    <div class="entity-list">
      ${items.length === 0
        ? html`<div class="entity-empty">${emptyHint}</div>`
        : items.map((it) => {
          const rowProps = dnd ? dnd.rowProps(it.id) : {};
          const handleProps = dnd ? dnd.handleProps(it.id) : {};
          const badges = it.badges || (it.badge ? [{ label: it.badge, tone: 'accent' }] : []);
          return html`
          <div class=${`entity-row${dnd ? ' is-draggable' : ''}`} key=${it.id}
               ...${rowProps} ...${handleProps}>
            ${dnd ? html`<span class="entity-row-grip" aria-hidden="true">⋮⋮</span>` : null}
            <span class="entity-row-icon">${it.icon}</span>
            <span class="entity-row-main">
              <span class="entity-row-primary">
                ${it.primary}
                ${badges.map((b) => html`
                  <span class=${`entity-row-badge tone-${b.tone || 'accent'}`}>${b.label}</span>`)}
              </span>
              ${it.secondary ? html`<span class="entity-row-secondary">${it.secondary}</span>` : null}
            </span>
            <span class="entity-row-actions">
              ${onActivate ? html`
                <button class="entity-row-action" title="Set default"
                        onClick=${() => onActivate(it)}>★</button>` : null}
              <button class="entity-row-action" title="Edit"
                      onClick=${() => onEdit(it)}><${IconPencil} /></button>
              ${it.undeletable ? null : html`
                <button class="entity-row-action danger" title="Delete"
                        onClick=${() => onDelete(it)}><${IconClose} /></button>`}
            </span>
          </div>`;
        })}
      <button class="entity-add" type="button" onClick=${onAdd}>
        <span>${addLabel}</span>
      </button>
    </div>`;
}

// ── Workspace list ───────────────────────────────────────────────────
function WorkspaceList() {
  const ws = workspaces.value || [];
  if (ws.length === 0) {
    return html`<div class="entity-empty">No workspaces yet — they're created automatically on launch.</div>`;
  }
  const onDelete = async (w) => {
    if (w.inUse) return setToast(`"${w.name}" is in use by a running session`, 'error');
    const ok = await ccsmConfirm(
      `Delete workspace "${w.name}"? This removes the directory and all repo clones inside.`,
      { okLabel: 'Delete', danger: true },
    );
    if (!ok) return;
    try {
      await deleteWorkspace(w.name);
      await loadWorkspaces();
      setToast(`deleted · ${w.name}`);
    } catch (e) { setToast(e.message, 'error'); }
  };
  return html`
    <div class="entity-list">
      ${ws.map((w) => {
        const repoCount = (w.repos || []).filter((r) => r.exists).length;
        return html`
        <div class="entity-row" key=${w.path}>
          <span class="entity-row-icon"><${IconFolder} /></span>
          <span class="entity-row-main">
            <span class="entity-row-primary">
              ${w.name}
              ${w.inUse ? html`<span class="entity-row-badge tone-warn">in use</span>` : null}
            </span>
            <span class="entity-row-secondary">
              <span class="mono">${w.path}</span>
              ${repoCount > 0 ? html` · ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}` : null}
            </span>
          </span>
          <span class="entity-row-actions">
            <button class=${`entity-row-action danger${w.inUse ? ' is-disabled' : ''}`}
                    title=${w.inUse ? 'In use by a running session' : 'Delete'}
                    disabled=${w.inUse}
                    onClick=${() => onDelete(w)}><${IconClose} /></button>
          </span>
        </div>`;
      })}
    </div>`;
}

// ── Accent picker (unchanged) ────────────────────────────────────────
const PRESETS = [
  { name: 'Ocean',         hex: '#2f6fa3' },
  { name: 'Claude copper', hex: '#b3614a' },
  { name: 'Anthropic ink', hex: '#1a1815' },
  { name: 'Forest',        hex: '#3f7a4a' },
  { name: 'Amber',         hex: '#c4892b' },
  { name: 'Berry',         hex: '#a44b78' },
  { name: 'Slate',         hex: '#4a5563' },
  { name: 'Crimson',       hex: '#b73f3f' },
];

function RestartButton() {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    const ok = await ccsmConfirm(
      'Restart the ccsm backend? Active sessions will be killed and reattached on next launch.',
      { okLabel: 'Restart', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await restartBackend();
      setToast('restarting backend…');
      if (r?.closeFrontend) {
        // Backend respawn will pop a fresh browser window — close this
        // one so the user isn't stuck on the OfflineBanner during the
        // ~3s downtime. window.close() only fires in script-opened
        // windows (Edge --app=); regular tabs ignore it and stay open,
        // which is the right behavior for them.
        setTimeout(() => { try { window.close(); } catch {} }, 400);
      }
    } catch (e) {
      setBusy(false);
      setToast(e.message, 'error');
    }
  };
  return html`
    <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <button class="action" disabled=${busy} onClick=${onClick}>
        ${busy ? 'Restarting…' : 'Restart backend'}
      </button>
      <span class="hint">Stops the server, then spawns a fresh one on the same port.</span>
    </div>
  `;
}

function AccentPicker() {
  const current = (accentColor.value || '').toLowerCase();
  const matchedPreset = PRESETS.find((p) => p.hex.toLowerCase() === current);
  const [customOpen, setCustomOpen] = useState(!matchedPreset);
  const [text, setText] = useState(current);
  useEffect(() => { setText(current); }, [current]);

  const pickPreset = (hex) => {
    setAccentColor(hex);
    setCustomOpen(false);
  };
  const onText = (e) => {
    const v = e.target.value.trim();
    setText(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setAccentColor(v);
  };
  return html`
    <div class="accent-picker">
      <div class="accent-chips">
        ${PRESETS.map((p) => {
          const active = current === p.hex.toLowerCase();
          return html`
            <button key=${p.hex} type="button"
                    class=${`accent-chip${active ? ' is-active' : ''}`}
                    style=${`--c:${p.hex}`}
                    title=${p.hex}
                    onClick=${() => pickPreset(p.hex)}>
              <span class="accent-chip-dot" aria-hidden="true"></span>
              <span class="accent-chip-name">${p.name}</span>
            </button>`;
        })}
        <button type="button"
                class=${`accent-chip accent-chip-custom${customOpen ? ' is-open' : ''}${!matchedPreset ? ' is-active' : ''}`}
                style=${!matchedPreset ? `--c:${current}` : ''}
                onClick=${() => setCustomOpen((v) => !v)}>
          ${!matchedPreset
            ? html`<span class="accent-chip-dot" aria-hidden="true"></span>`
            : html`<span class="accent-chip-plus" aria-hidden="true">+</span>`}
          <span class="accent-chip-name">Custom</span>
        </button>
      </div>
      ${customOpen ? html`
        <div class="accent-custom">
          <input type="color" value=${current}
                 onInput=${(e) => setAccentColor(e.target.value)} />
          <input type="text" class="accent-hex mono" value=${text}
                 spellcheck="false" maxlength="7"
                 onInput=${onText} placeholder="#rrggbb" />
          <button type="button" class="accent-reset"
                  onClick=${() => { setAccentColor(ACCENT_DEFAULT); setCustomOpen(false); }}>
            Reset
          </button>
        </div>` : null}
    </div>`;
}


// ── Keyboard shortcuts ───────────────────────────────────────────────
const ACTION_ICONS = {
  'session-next':      IconChevronDown,
  'session-prev':      IconChevronUp,
  'session-move-down': IconChevronDown,
  'session-move-up':   IconChevronUp,
};

function KeybindingsList() {
  const map = keybindings.value;
  const [recording, setRecording] = useState(null); // actionId or null

  return html`
    <div class="entity-list">
      ${Object.entries(ACTIONS).map(([id, def]) => {
        const combo = map[id];
        const isCustom = combo !== def.defaultCombo;
        const Icon = ACTION_ICONS[id] || IconTerminal;
        return html`
          <div class="entity-row" key=${id}>
            <span class="entity-row-icon"><${Icon} /></span>
            <span class="entity-row-main">
              <span class="entity-row-primary">
                ${def.label}
                <span class="entity-row-badge tone-accent">${formatCombo(combo)}</span>
              </span>
              <span class="entity-row-secondary">
                <span class="mono">${id}</span> · default <span class="mono">${formatCombo(def.defaultCombo)}</span>
              </span>
            </span>
            <span class="entity-row-actions">
              <button class="entity-row-action" title="Rebind"
                      onClick=${() => setRecording(id)}><${IconPencil} /></button>
              ${isCustom ? html`
                <button class="entity-row-action" title="Reset to default"
                        onClick=${() => resetBinding(id)}><${IconRefresh} /></button>` : null}
            </span>
          </div>`;
      })}
    </div>
    ${recording ? html`
      <${KeybindingRecorder}
        actionLabel=${ACTIONS[recording]?.label || recording}
        onCommit=${(combo) => { setBinding(recording, combo); setRecording(null); }}
        onCancel=${() => setRecording(null)} />` : null}`;
}
