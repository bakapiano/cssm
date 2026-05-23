import { html } from '../html.js';
import {
  activeTab, sidebarCollapsed, configDirty, sessions, webTerminals, capabilities,
  selectTab, toggleSidebar, setSidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX,
} from '../state.js';
import {
  IconSessions, IconLaunch, IconTerminal, IconConfigure, IconInfo,
  IconChevronLeft, BrandMark,
} from '../icons.js';

function NavItem({ tab, icon, label, badge, dirty }) {
  const selected = activeTab.value === tab;
  const cls = `nav-item${dirty ? ' has-changes' : ''}`;
  return html`
    <button class=${cls} role="tab" aria-selected=${selected ? 'true' : 'false'}
            onClick=${() => selectTab(tab)}>
      <span class="nav-icon">${icon}</span>
      <span class="nav-label">${label}</span>
      ${badge != null ? html`<span class="nav-badge">${badge}</span>` : null}
    </button>`;
}

export function Sidebar() {
  const collapsed = sidebarCollapsed.value;

  // Drag-to-resize handle. Pointer events let one handler cover mouse,
  // touch, pen uniformly + setPointerCapture means dragging continues
  // even if cursor leaves the 4px-wide handle. Collapsed sidebars don't
  // expose a handle — Collapse-toggle is the only way out/in.
  const onResizeStart = (ev) => {
    if (collapsed) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-resizing-sidebar');
    const move = (e) => setSidebarWidth(e.clientX);
    const up = (e) => {
      el.releasePointerCapture(ev.pointerId);
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
      <div class="sidebar-brand">
        <span class="brand-mark"><${BrandMark} /></span>
        <span class="brand-name">CCSM<span class="brand-dot">.</span></span>
      </div>

      <nav class="sidebar-nav" role="tablist" aria-label="Sections">
        <${NavItem} tab="sessions"  icon=${html`<${IconSessions} />`}  label="Sessions"  badge=${sessions.value.length} />
        <${NavItem} tab="launch"    icon=${html`<${IconLaunch} />`}    label="Launch" />
        ${capabilities.value.webTerminal ? html`
          <${NavItem} tab="terminals" icon=${html`<${IconTerminal} />`} label="Terminals" badge=${webTerminals.value.length || null} />
        ` : null}
        <${NavItem} tab="configure" icon=${html`<${IconConfigure} />`} label="Configure" dirty=${configDirty.value} />
        <${NavItem} tab="about"     icon=${html`<${IconInfo} />`}      label="About" />
      </nav>

      <div class="sidebar-foot">
        <button class="util-item collapse-toggle" aria-label="collapse sidebar"
                title=${collapsed ? 'expand sidebar' : 'collapse sidebar'}
                onClick=${toggleSidebar}>
          <span class="nav-icon"><${IconChevronLeft} /></span>
          <span class="nav-label">Collapse</span>
        </button>
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
