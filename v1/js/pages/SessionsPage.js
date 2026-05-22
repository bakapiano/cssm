import { html } from '../html.js';
import { sessions, recentTotal, favoritesList, clockTick } from '../state.js';
import { Card } from '../components/Card.js';
import { SessionsTable } from '../components/SessionsTable.js';
import { RecentTable } from '../components/RecentTable.js';
import { FavoritesTable } from '../components/FavoritesTable.js';
import { runFinder } from '../actions.js';
import { IconSearch, StarSmallFilled } from '../icons.js';
import { nowClock } from '../util.js';

export function SessionsPage() {
  void clockTick.value;
  const sessCount = sessions.value.length;
  const favCount = favoritesList.value.length;

  const sessionsMeta = sessCount
    ? `${sessCount} live · refreshed ${nowClock()}`
    : 'no live sessions';
  const recentMeta = recentTotal.value
    ? `${recentTotal.value} total · sorted by jsonl mtime, excluding live`
    : 'no recent sessions';
  const favMeta = favCount ? `${favCount} pinned` : 'click ☆ on any row to pin sessions here';

  return html`
    <div class="page-actions">
      <span class="page-actions-hint">Looking through your past conversations?</span>
      <button class="action primary" onClick=${runFinder}
              title="open a Claude session with context on the ccsm data dir">
        <${IconSearch} stroke=${2} /> Ask Claude to find a session
      </button>
    </div>

    <${Card} foldKey="favorites"
             title=${html`Favorites <${StarSmallFilled} />`}
             meta=${favMeta}
             flush=${true}>
      <${FavoritesTable} />
    </${Card}>

    <${Card} foldKey="sessions" title="Live sessions" meta=${sessionsMeta} flush=${true}>
      <${SessionsTable} />
    </${Card}>

    <${Card} foldKey="recent" title="Recently closed" meta=${recentMeta} flush=${true}>
      <${RecentTable} />
    </${Card}>`;
}
