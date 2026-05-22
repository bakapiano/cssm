import { html } from '../html.js';
import {
  favoritesList, favoritesOffset, favoritesLimit,
  sessions, clockTick,
} from '../state.js';
import { fmtAgo, fmtTime } from '../util.js';
import { focusSession, resumeSession } from '../actions.js';
import { TitleCell } from './TitleCell.js';
import { Pagination } from './Pagination.js';
import { IconMonitor, IconExternal } from '../icons.js';

export function FavoritesTable() {
  void clockTick.value;
  const full = favoritesList.value;
  if (favoritesOffset.value >= full.length) {
    favoritesOffset.value = Math.max(0, Math.floor((full.length - 1) / favoritesLimit.value) * favoritesLimit.value);
  }
  const slice = full.slice(favoritesOffset.value, favoritesOffset.value + favoritesLimit.value);

  if (full.length === 0) {
    return html`<div class="empty" id="favoritesEmpty">No favorites yet. Star a session row to pin it here.</div>`;
  }

  return html`
    <div class="table-scroll">
      <table class="data">
        <thead>
          <tr>
            <th>Title</th>
            <th>Working directory</th>
            <th>Branch</th>
            <th class="num">Pinned</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>${slice.map((f) => html`<${Row} key=${f.sessionId} fav=${f} />`)}</tbody>
      </table>
    </div>
    <${Pagination}
      total=${full.length}
      offset=${favoritesOffset.value}
      limit=${favoritesLimit.value}
      onChange=${(off, lim) => { favoritesOffset.value = off; favoritesLimit.value = lim; }} />`;
}

function Row({ fav: f }) {
  const live = sessions.value.find((s) => s.sessionId === f.sessionId);
  const title = live?.title || f.title;
  const cwd   = live?.cwd   || f.cwd;
  const branch = f.gitBranch;
  const liveExtra = live ? html` · <span style="color:var(--green);">live</span>` : null;
  const actions = live
    ? html`
        <button class="action small" title="raise the wt window"
                onClick=${() => focusSession(f.sessionId)}>
          <${IconMonitor} /> Focus
        </button>`
    : html`
        <button class="action small" title="claude --resume in a fresh wt window"
                disabled=${!cwd}
                onClick=${() => resumeSession(f.sessionId, cwd, { kind: 'continue' })}>
          <${IconExternal} /> Continue
        </button>`;

  return html`
    <tr>
      <td>
        <${TitleCell}
          sessionId=${f.sessionId}
          title=${title}
          secondaryExtra=${liveExtra}
          snapshotData=${{ cwd: cwd || '', title, gitBranch: branch || '' }} />
      </td>
      <td><div class="path-cell" title=${cwd || ''}>${cwd || ''}</div></td>
      <td>
        ${branch ? html`<span class="branch-tag">${branch}</span>` : html`<span class="muted-text">—</span>`}
      </td>
      <td class="num" title=${fmtTime(f.addedAt)}>${fmtAgo(f.addedAt)}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
}
