import { html } from '../html.js';
import { workspaces, config } from '../state.js';

export function WorkspacesGrid() {
  const list = workspaces.value;
  if (list.length === 0) {
    return html`<div class="empty">No workspaces yet — the first launch will create one.</div>`;
  }
  return html`
    <div class="workspace-grid">
      ${list.map((w) => html`<${Card} key=${w.name} ws=${w} />`)}
    </div>`;
}

function Card({ ws }) {
  const cls = 'workspace-card' + (ws.inUse ? ' in-use' : '');
  const tag = ws.inUse ? `in use × ${ws.sessionsHere.length}` : 'free';
  return html`
    <div class=${cls}>
      <div class="ws-head">
        <div class="ws-name">${ws.name}</div>
        <span class="ws-tag">${tag}</span>
      </div>
      <div class="ws-path">${ws.path}</div>
      <div class="ws-repos">
        ${ws.repos.map((r) => html`
          <span class=${`ws-repo${r.cloned ? ' cloned' : ''}`} title=${r.url} key=${r.name}>
            ${r.name}${r.cloned ? ' ✓' : ''}
          </span>`)}
      </div>
    </div>`;
}

export function WorkspacesHeader() {
  return html`Under <code>${config.value?.workDir || '…'}</code>`;
}

// Wrapping component so the meta updates when config changes
export function WorkspacesHeaderInline() {
  return WorkspacesHeader();
}
