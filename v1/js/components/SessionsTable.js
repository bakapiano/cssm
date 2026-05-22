import { html } from '../html.js';
import {
  sessions, sessionsOffset, sessionsLimit, clockTick,
} from '../state.js';
import { fmtAgo, fmtTime } from '../util.js';
import { focusSession } from '../actions.js';
import { TitleCell } from './TitleCell.js';
import { Pagination } from './Pagination.js';
import { IconMonitor } from '../icons.js';

export function SessionsTable() {
  // touch clockTick so fmtAgo refreshes each second
  void clockTick.value;

  const all = sessions.value;
  if (sessionsOffset.value >= all.length) {
    sessionsOffset.value = Math.max(0, Math.floor((all.length - 1) / sessionsLimit.value) * sessionsLimit.value);
  }
  const slice = all.slice(sessionsOffset.value, sessionsOffset.value + sessionsLimit.value);

  return html`
    <div class="table-scroll">
      <table class="data">
        <thead>
          <tr>
            <th class="col-mark"></th>
            <th>Title</th>
            <th>Working directory</th>
            <th class="num">Updated</th>
            <th class="num">Started</th>
            <th class="num">PID</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>${slice.map((s) => html`<${Row} key=${s.sessionId} session=${s} />`)}</tbody>
      </table>
    </div>
    ${all.length === 0 ? html`<div class="empty">No live sessions detected.</div>` : null}
    <${Pagination}
      total=${all.length}
      offset=${sessionsOffset.value}
      limit=${sessionsLimit.value}
      onChange=${(off, lim) => { sessionsOffset.value = off; sessionsLimit.value = lim; }} />`;
}

function Row({ session: s }) {
  const versionExtra = s.version ? html` · ${s.version}` : null;
  return html`
    <tr>
      <td><span class=${`status-mark ${s.status}`} title=${s.status}></span></td>
      <td>
        <${TitleCell}
          sessionId=${s.sessionId}
          title=${s.title}
          secondaryExtra=${versionExtra}
          snapshotData=${{ cwd: s.cwd, title: s.title, gitBranch: s.gitBranch || '' }} />
      </td>
      <td><div class="path-cell" title=${s.cwd}>${s.cwd}</div></td>
      <td class="num" title=${fmtTime(s.updatedAt)}>${fmtAgo(s.updatedAt)}</td>
      <td class="num" title=${fmtTime(s.startedAt)}>${fmtAgo(s.startedAt)}</td>
      <td class="num">${s.pid}</td>
      <td>
        <div class="row-actions">
          <button class="action small" title="raise the wt window already running this session"
                  onClick=${() => focusSession(s.sessionId)}>
            <${IconMonitor} /> Focus
          </button>
        </div>
      </td>
    </tr>`;
}
