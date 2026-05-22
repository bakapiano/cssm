import { html } from '../html.js';
import {
  recent, recentTotal, recentOffset, recentLimit, clockTick,
} from '../state.js';
import { loadRecent } from '../api.js';
import { fmtAgo, fmtTime } from '../util.js';
import { resumeSession } from '../actions.js';
import { TitleCell } from './TitleCell.js';
import { Pagination } from './Pagination.js';
import { IconExternal } from '../icons.js';

export function RecentTable() {
  void clockTick.value;
  const list = recent.value;

  return html`
    <div class="table-scroll">
      <table class="data">
        <thead>
          <tr>
            <th>Title</th>
            <th>Working directory</th>
            <th>Branch</th>
            <th class="num">Last activity</th>
            <th class="num">Started</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>${list.map((s) => html`<${Row} key=${s.sessionId} session=${s} />`)}</tbody>
      </table>
    </div>
    ${list.length === 0 ? html`<div class="empty">Nothing in <code>~/.claude/projects/</code>.</div>` : null}
    <${Pagination}
      total=${recentTotal.value}
      offset=${recentOffset.value}
      limit=${recentLimit.value}
      onChange=${(off, lim) => {
        recentOffset.value = off;
        recentLimit.value = lim;
        loadRecent().catch(() => {});
      }} />`;
}

function Row({ session: s }) {
  return html`
    <tr>
      <td>
        <${TitleCell}
          sessionId=${s.sessionId}
          title=${s.title}
          snapshotData=${{ cwd: s.cwd || '', title: s.title, gitBranch: s.gitBranch || '' }} />
      </td>
      <td><div class="path-cell" title=${s.cwd || ''}>${s.cwd || ''}</div></td>
      <td>
        ${s.gitBranch ? html`<span class="branch-tag">${s.gitBranch}</span>` : html`<span class="muted-text">—</span>`}
      </td>
      <td class="num" title=${fmtTime(s.updatedAt)}>${fmtAgo(s.updatedAt)}</td>
      <td class="num" title=${fmtTime(s.startedAt)}>${fmtAgo(s.startedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="action small" title="claude --resume in a fresh wt window"
                  onClick=${() => resumeSession(s.sessionId, s.cwd, { kind: 'continue' })}>
            <${IconExternal} /> Continue
          </button>
        </div>
      </td>
    </tr>`;
}
