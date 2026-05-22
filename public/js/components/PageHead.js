import { html } from '../html.js';
import { activeTab, TAB_HEADINGS, lastRefreshAt, clockTick } from '../state.js';
import { refreshAll } from '../api.js';
import { setToast } from '../toast.js';
import { fmtAgo } from '../util.js';
import { ServerStatus } from './ServerStatus.js';
import { IconRefresh } from '../icons.js';

export function PageHead() {
  const heading = TAB_HEADINGS[activeTab.value] || TAB_HEADINGS.sessions;
  // subscribe to clockTick so the "Ns ago" relative label updates every second
  void clockTick.value;
  const last = lastRefreshAt.value;
  const lastLabel = last ? `${fmtAgo(last)} ago` : 'never';

  const onRefresh = () =>
    refreshAll().then(() => setToast('refreshed')).catch((e) => setToast(e.message, 'error'));

  return html`
    <header class="page-head">
      <div class="page-head-inner">
        <h1 class="page-title">${heading.title}</h1>
        <p class="page-subtitle">${heading.subtitle}</p>
      </div>
      <div class="page-head-meta">
        <${ServerStatus} />
        <button class="action subtle small" title=${`last refresh: ${lastLabel}`} onClick=${onRefresh}>
          <${IconRefresh} size=${13} /> Refresh
          <span class="refresh-ago">${lastLabel}</span>
        </button>
      </div>
    </header>`;
}
