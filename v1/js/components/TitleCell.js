// Title cell shared by the three row types: shown text + rename + star.
// Includes the session-id secondary line and the row hover-only icon set.

import { html } from '../html.js';
import { labels, favorites } from '../state.js';
import { displayTitle } from '../util.js';
import { toggleFavorite, renameSession } from '../actions.js';
import { StarFilled, StarOutline, IconPencil } from '../icons.js';

export function TitleCell({ sessionId, title, secondaryExtra, snapshotData }) {
  const label = labels.value[sessionId];
  const hasLabel = !!label;
  const isFav = !!favorites.value[sessionId];
  const shown = displayTitle(label, title);
  const tooltip = hasLabel ? `${shown}\n(original: ${title || '—'})` : shown;

  const onRename = (ev) => { ev.stopPropagation(); renameSession(sessionId, label || ''); };
  const onStar   = (ev) => { ev.stopPropagation(); toggleFavorite(sessionId, snapshotData); };

  return html`
    <div class="title-cell">
      <div class="title-row">
        <span class="primary" title=${tooltip}>${shown}</span>
        <button class=${`rename-btn${hasLabel ? ' has-label' : ''}`}
                title=${hasLabel ? 'rename · custom label set' : 'rename'}
                aria-label="rename" onClick=${onRename}>
          <${IconPencil} />
        </button>
        <button class=${`star-btn${isFav ? ' is-fav' : ''}`}
                title=${isFav ? 'remove favorite' : 'add favorite'}
                aria-label=${isFav ? 'remove favorite' : 'add favorite'}
                onClick=${onStar}>
          ${isFav ? html`<${StarFilled} />` : html`<${StarOutline} />`}
        </button>
      </div>
      <div class="secondary" title=${sessionId}>
        ${sessionId.slice(0, 8)}${secondaryExtra || null}
      </div>
    </div>`;
}
