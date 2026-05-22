import { html } from '../html.js';
import { serverHealth } from '../state.js';
import { Card } from '../components/Card.js';
import { BrandMark, IconGithub, IconExternal } from '../icons.js';

const REPO_URL = 'https://github.com/bakapiano/cssm';
const NPM_URL  = 'https://www.npmjs.com/package/@bakapiano/ccsm';

export function AboutPage() {
  const version = serverHealth.value.version;

  return html`
    <${Card} title="ccsm">
      <div class="about-block">
        <div class="about-hero">
          <span class="about-mark"><${BrandMark} /></span>
          <div>
            <div class="about-name">ccsm <span class="about-version">${version ? `v${version}` : ''}</span></div>
            <div class="about-tagline">Claude Code Session Manager · a single pane over every live <code>claude</code> session on this box.</div>
          </div>
        </div>

        <p class="about-copy">
          Lists live and recently-closed sessions, snapshots them every minute, restores them through Windows Terminal,
          and launches fresh sessions inside isolated workspaces. Designed for running 8–10 concurrent sessions across
          ad-hoc repo clones.
        </p>

        <div class="about-links">
          <a class="action" href=${REPO_URL} target="_blank" rel="noopener">
            <${IconGithub} /> GitHub <${IconExternal} />
          </a>
          <a class="action subtle" href=${NPM_URL} target="_blank" rel="noopener">
            npm <${IconExternal} />
          </a>
        </div>

        <dl class="about-meta">
          <dt>Install</dt>
          <dd><code>npx @bakapiano/ccsm</code></dd>
          <dt>Data directory</dt>
          <dd><code>~/.ccsm/</code> (override with <code>CCSM_HOME</code>)</dd>
          <dt>Platform</dt>
          <dd>Windows · Node 18+</dd>
          <dt>License</dt>
          <dd>MIT</dd>
        </dl>
      </div>
    </${Card}>`;
}
