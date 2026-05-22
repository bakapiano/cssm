import { html } from '../html.js';
import { config } from '../state.js';

export function Footer() {
  const cfg = config.value;
  return html`
    <footer class="footer-status">
      <span class="fs-key">Data</span> <span class="fs-val">~/.ccsm</span>
      <span class="fs-divider">·</span>
      <span class="fs-key">Workspaces</span> <span class="fs-val">${cfg?.workDir ?? '—'}</span>
    </footer>`;
}
