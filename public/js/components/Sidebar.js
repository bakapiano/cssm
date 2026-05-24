import { html } from '../html.js';
import {
  activeTab, sidebarCollapsed, sidebarForcedCollapsed, configDirty, capabilities, serverHealth,
  sessions, folders, sessionsByFolder, foldersCollapsed, activeSessionId,
  selectTab, selectSession, toggleSidebar, toggleFolder, setSidebarWidth,
} from '../state.js';
import { createFolder, renameFolder, deleteFolder, reorderFolders, setSessionFolder, deleteSession, resumeSession, setSessionTitle } from '../api.js';
import { ccsmPrompt, ccsmConfirm } from '../dialog.js';
import { setToast } from '../toast.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';
import { useDragSort } from './useDragSort.js';
import {
  IconLaunch, IconConfigure,
  IconSidebarToggle, IconPencil, IconClose, IconFolder, IconFolderOpen, BrandMark,
} from '../icons.js';

function NavItem({ tab, icon, label, dirty }) {
  const selected = activeTab.value === tab;
  return html`
    <button class=${`nav-item${dirty ? ' has-changes' : ''}${selected ? ' is-active' : ''}`}
            role="tab" aria-selected=${selected ? 'true' : 'false'}
            onClick=${() => selectTab(tab)}>
      <span class="nav-icon">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>`;
}

// One row in the session tree. Click → open in main pane. Right-click /
// long-press not implemented; "..." menu via the inline kebab.
function SessionRow({ s }) {
  clockTick.value; // subscribe for fmtAgo refresh
  const isActive = activeSessionId.value === s.id;
  const running = s.status === 'running';
  const title = s.title || s.workspace || s.id.slice(0, 12);

  const onClick = async (ev) => {
    ev.preventDefault();
    selectSession(s.id);
    // Auto-resume on click if the session is stopped — saves the user
    // from a second click on the "Resume" button in the right pane.
    // No-op if already running.
    if (s.status !== 'running') {
      try { await resumeSession(s.id); }
      catch (e) { setToast(e.message, 'error'); }
    }
  };

  const onContext = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Quick menu: Rename / Move / Delete. We use sequential prompts
    // to avoid building a real context-menu component for now.
    const action = await ccsmPrompt(
      `${title} · ${running ? 'running' : 'stopped'}\nType: rename / move / delete / resume / cancel`,
      'cancel', { title: s.id, okLabel: 'OK' });
    if (!action) return;
    const verb = action.trim().toLowerCase();
    if (verb === 'rename') {
      const next = await ccsmPrompt('New title', title, { title: 'Rename session', okLabel: 'Save' });
      if (next === null) return;
      try { await setSessionTitle(s.id, next.trim()); setToast('renamed'); }
      catch (e) { setToast(e.message, 'error'); }
    } else if (verb === 'move') {
      // Move to a folder by name
      const folderNames = folders.value.map((f) => f.name).join(', ');
      const target = await ccsmPrompt(
        `Move to which folder? (empty = Unsorted)\nExisting: ${folderNames || '(none)'}`,
        '', { title: 'Move', okLabel: 'Move' });
      if (target === null) return;
      const t = target.trim();
      const folder = t ? folders.value.find((f) => f.name.toLowerCase() === t.toLowerCase()) : null;
      if (t && !folder) { setToast(`no folder named "${t}"`, 'error'); return; }
      try { await setSessionFolder(s.id, folder ? folder.id : null); setToast('moved'); }
      catch (e) { setToast(e.message, 'error'); }
    } else if (verb === 'delete') {
      const ok = await ccsmConfirm(`Delete session ${title}? PTY will be killed if alive.`, {
        title: 'Delete session', okLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await deleteSession(s.id);
        if (activeSessionId.value === s.id) activeSessionId.value = null;
      } catch (e) { setToast(e.message, 'error'); }
    } else if (verb === 'resume' && !running) {
      try { await resumeSession(s.id); selectSession(s.id); }
      catch (e) { setToast(e.message, 'error'); }
    }
  };

  const onRenameClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const next = await ccsmPrompt('New title', title, { title: 'Rename session', okLabel: 'Save' });
    if (next === null) return;
    try { await setSessionTitle(s.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDeleteClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ok = await ccsmConfirm(`Delete session ${title}? PTY will be killed if alive.`, {
      title: 'Delete session', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deleteSession(s.id);
      if (activeSessionId.value === s.id) activeSessionId.value = null;
    } catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <div class=${`tree-session${isActive ? ' is-active' : ''}${running ? ' is-running' : ' is-stopped'}`}
         onClick=${onClick}
         onContextMenu=${onContext}
         title=${`${title}\n${s.cwd}\n${running ? 'running' : 'stopped'} · ${s.cliId}`}>
      <span class=${`tree-dot ${running ? 'is-running' : 'is-stopped'}`}></span>
      <span class="tree-label">${title}</span>
      <span class="tree-session-actions">
        <button class="tree-session-action" title="rename" onClick=${onRenameClick}><${IconPencil} /></button>
        <button class="tree-session-action" title="delete" onClick=${onDeleteClick}><${IconClose} /></button>
      </span>
      <span class="tree-meta">${fmtAgo(s.lastActiveAt)}</span>
    </div>`;
}

function FolderGroup({ folder, sessionList, dndHandle, dndRow }) {
  const key = folder ? folder.id : 'unsorted';
  const collapsed = !!foldersCollapsed.value[key];
  const name = folder ? folder.name : 'Unsorted';
  const onToggle = () => toggleFolder(folder ? folder.id : null);

  const onRename = async (ev) => {
    ev.stopPropagation();
    if (!folder) return;
    const next = await ccsmPrompt('Rename folder', folder.name, { title: folder.name, okLabel: 'Save' });
    if (next === null || !next.trim()) return;
    try { await renameFolder(folder.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDelete = async (ev) => {
    ev.stopPropagation();
    if (!folder) return;
    const ok = await ccsmConfirm(`Delete folder "${folder.name}"? Sessions inside move to Unsorted.`, {
      title: 'Delete folder', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await deleteFolder(folder.id); }
    catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <div class="tree-folder" ...${dndRow || {}}>
      <button class=${`tree-folder-head${collapsed ? '' : ' is-open'}`} onClick=${onToggle}
              ...${dndHandle || {}}>
        <span class="tree-folder-icon">
          ${collapsed ? html`<${IconFolder} />` : html`<${IconFolderOpen} />`}
        </span>
        <span class="tree-folder-name">${name}</span>
        ${folder ? html`
          <span class="tree-folder-actions">
            <button class="tree-folder-action" title="rename" onClick=${onRename}><${IconPencil} /></button>
            <button class="tree-folder-action" title="delete" onClick=${onDelete}><${IconClose} /></button>
          </span>` : null}
      </button>
      ${!collapsed ? html`
        <div class="tree-folder-body">
          ${sessionList.length === 0
            ? html`<div class="tree-empty">no sessions</div>`
            : sessionList.map((s) => html`<${SessionRow} key=${s.id} s=${s} />`)}
        </div>
      ` : null}
    </div>`;
}

function SessionTree() {
  const grouped = sessionsByFolder.value;
  const orderedFolders = folders.value;
  const dnd = useDragSort(
    orderedFolders.map((f) => f.id),
    async (nextIds) => {
      try { await reorderFolders(nextIds); }
      catch (e) { setToast(e.message, 'error'); }
    },
  );

  const onNewFolder = async () => {
    const name = await ccsmPrompt('Folder name', '', { title: 'New folder', okLabel: 'Create' });
    if (!name || !name.trim()) return;
    try { await createFolder(name.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <div class="tree">
      <div class="tree-head">
        <span class="tree-head-label">Sessions</span>
      </div>
      ${orderedFolders.map((f) => html`
        <${FolderGroup} key=${f.id} folder=${f}
                        sessionList=${grouped.get(f.id) || []}
                        dndHandle=${dnd.handleProps(f.id)}
                        dndRow=${dnd.rowProps(f.id)} />`)}
      <${FolderGroup} folder=${null} sessionList=${grouped.get(null) || []} />
    </div>`;
}

export function Sidebar() {
  const collapsed = sidebarCollapsed.value || sidebarForcedCollapsed.value;
  const forced = sidebarForcedCollapsed.value;

  const onResizeStart = (ev) => {
    if (collapsed) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-resizing-sidebar');
    const move = (e) => setSidebarWidth(e.clientX);
    const up = () => {
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      document.body.classList.remove('is-resizing-sidebar');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return html`
    <aside class="sidebar" data-collapsed=${collapsed ? 'true' : 'false'}>
      <div class="sidebar-top">
        <button class="sidebar-brand sidebar-brand-button"
                role="tab" aria-selected=${activeTab.value === 'about' ? 'true' : 'false'}
                title="About"
                onClick=${() => selectTab('about')}>
          <span class="brand-mark"><${BrandMark} /></span>
          <span class="brand-name">CCSM<span class="brand-dot">.</span></span>
          ${serverHealth.value.version ? html`
            <span class="brand-version">v${serverHealth.value.version}</span>
          ` : null}
        </button>
      </div>

      <nav class="sidebar-nav compact" role="tablist" aria-label="Sections">
        <${NavItem} tab="launch"    icon=${html`<${IconLaunch} />`}    label="New Session" />
        <${NavItem} tab="configure" icon=${html`<${IconConfigure} />`} label="Settings" dirty=${configDirty.value} />
      </nav>

      ${!collapsed ? html`<${SessionTree} />` : null}

      <div class="sidebar-foot">
        ${!forced ? html`
          <button class="util-item collapse-toggle" aria-label=${collapsed ? 'expand sidebar' : 'collapse sidebar'}
                  title=${collapsed ? 'expand sidebar' : 'collapse sidebar'}
                  onClick=${toggleSidebar}>
            <span class="nav-icon"><${IconSidebarToggle} /></span>
          </button>
        ` : null}
      </div>

      ${!collapsed ? html`
        <div class="sidebar-resize-handle" role="separator" aria-orientation="vertical"
             aria-label="resize sidebar"
             title="drag to resize · double-click to reset"
             onPointerDown=${onResizeStart}
             onDblClick=${() => setSidebarWidth(232)}></div>
      ` : null}
    </aside>`;
}
