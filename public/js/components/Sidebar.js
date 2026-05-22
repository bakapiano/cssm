import { html } from '../html.js';
import {
  activeTab, sidebarCollapsed, configDirty, sessions,
  selectTab, toggleSidebar,
} from '../state.js';
import {
  IconSessions, IconLaunch, IconConfigure, IconInfo,
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

  return html`
    <aside class="sidebar" data-collapsed=${collapsed ? 'true' : 'false'}>
      <div class="sidebar-brand">
        <span class="brand-mark"><${BrandMark} /></span>
        <span class="brand-name">CCSM<span class="brand-dot">.</span></span>
      </div>

      <nav class="sidebar-nav" role="tablist" aria-label="Sections">
        <${NavItem} tab="sessions"  icon=${html`<${IconSessions} />`}  label="Sessions"  badge=${sessions.value.length} />
        <${NavItem} tab="launch"    icon=${html`<${IconLaunch} />`}    label="Launch" />
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
    </aside>`;
}
