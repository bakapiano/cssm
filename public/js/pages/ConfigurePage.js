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
  createCli, updateCli, deleteCli, setDefaultCli,
  createRepo, updateRepo, deleteRepo,
  createFolder, renameFolder, deleteFolder, reorderFolders,
  deleteWorkspace,
} from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm } from '../dialog.js';
import { Card } from '../components/Card.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { EntityFormModal } from '../components/EntityFormModal.js';
import { useDragSort } from '../components/useDragSort.js';
import { IconPlus, IconPencil, IconClose, IconTerminal, IconFolder, IconBranch, IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor } from '../icons.js';

// Type → smart defaults. Choosing a type in the form auto-fills resumeArgs
// (and command if blank) so users don't need to remember the per-CLI flag.
const CLI_TYPE_DEFAULTS = {
  claude:  { command: 'claude',  resumeArgs: '--continue',    resumeIdArgs: '--resume <id>' },
  codex:   { command: 'codex',   resumeArgs: 'resume --last', resumeIdArgs: 'resume <id>' },
  copilot: { command: 'copilot', resumeArgs: '--continue',    resumeIdArgs: '--resume <id>' },
  other:   { resumeArgs: '', resumeIdArgs: '' },
};

function cliFieldsFor({ creating } = {}) {
  return [
    { key: 'type', label: 'Type', type: 'iconRadio', default: 'other', options: [
      { value: 'claude',  label: 'Claude CLI',     icon: html`<${IconClaudeColor} />` },
      { value: 'codex',   label: 'Codex CLI',      icon: html`<${IconCodexColor} />` },
      { value: 'copilot', label: 'GitHub Copilot', icon: html`<${IconCopilotColor} />` },
      { value: 'other',   label: 'Other',          icon: html`<${IconTerminal} />` },
    ],
      // When user picks a type while creating, prefill command + resumeArgs.
      // For edit mode we don't override what the user already has.
      onChange: creating ? (v, next) => {
        const d = CLI_TYPE_DEFAULTS[v];
        if (!d) return null;
        const patch = { resumeArgs: d.resumeArgs, resumeIdArgs: d.resumeIdArgs };
        if (!next.command || !next.command.trim()) patch.command = d.command || '';
        if (!next.name || !next.name.trim()) {
          patch.name = v === 'claude' ? 'Claude Code'
                     : v === 'codex' ? 'OpenAI Codex'
                     : v === 'copilot' ? 'GitHub Copilot'
                     : '';
        }
        return patch;
      } : undefined,
    },
    { key: 'name', label: 'Name', placeholder: 'My CLI', required: true },
    { key: 'command', label: 'Command', mono: true, placeholder: 'ccp / claude / ...', required: true },
    { key: 'args', label: 'Args (space-separated)', mono: true, placeholder: '',
      hint: 'Used on every launch.' },
    { key: 'resumeArgs', label: 'Resume args (fallback)', mono: true, placeholder: '--continue',
      hint: 'Used when ccsm has no captured upstream session id — usually "open last session in cwd".' },
    { key: 'resumeIdArgs', label: 'Resume by id args', mono: true, placeholder: '--resume <id>',
      hint: 'Use <id> as the placeholder for the captured upstream session UUID. Leave empty to always use the fallback.' },
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

  // Refresh workspace list when the page mounts so sizes are fresh.
  useEffect(() => { loadWorkspaces().catch(() => {}); }, []);

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

    </div>

    ${edit?.kind === 'cli-new' ? html`
      <${EntityFormModal} title="New CLI" fields=${cliFieldsFor({ creating: true })}
        onClose=${close} submitLabel="Create"
        onSubmit=${async (v) => {
          try { await createCli(v); setToast(`created CLI · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'cli-edit' ? html`
      <${EntityFormModal} title=${`Edit ${edit.payload.name}`} fields=${cliFieldsFor()}
        readOnlyKeys=${edit.payload.builtin ? ['type', 'command'] : []}
        initial=${{
          ...edit.payload,
          args: (edit.payload.args || []).join(' '),
          resumeArgs: (edit.payload.resumeArgs || []).join(' '),
          resumeIdArgs: (edit.payload.resumeIdArgs || []).join(' '),
        }}
        onClose=${close}
        onSubmit=${async (v) => {
          try {
            const patch = {
              ...v,
              args: typeof v.args === 'string' ? v.args.split(/\s+/).filter(Boolean) : v.args,
              resumeArgs: typeof v.resumeArgs === 'string' ? v.resumeArgs.split(/\s+/).filter(Boolean) : v.resumeArgs,
              resumeIdArgs: typeof v.resumeIdArgs === 'string' ? v.resumeIdArgs.split(/\s+/).filter(Boolean) : v.resumeIdArgs,
            };
            // command is locked on builtins — drop any tampered value.
            if (edit.payload.builtin) delete patch.command;
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
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function WorkspaceList() {
  const ws = workspaces.value || [];
  if (ws.length === 0) {
    return html`<div class="entity-empty">No workspaces yet — they're created automatically on launch.</div>`;
  }
  const onDelete = async (w) => {
    if (w.inUse) return setToast(`"${w.name}" is in use by a running session`, 'error');
    const ok = await ccsmConfirm(
      `Delete workspace "${w.name}"? This removes the directory and all repo clones inside (${fmtBytes(w.size)}).`,
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
              · ${fmtBytes(w.size)}
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
