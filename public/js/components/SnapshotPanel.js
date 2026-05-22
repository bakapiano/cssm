import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { snapshot, history, clockTick } from '../state.js';
import { api, loadSnapshot } from '../api.js';
import { fmtAgo, fmtTime } from '../util.js';
import { setToast } from '../toast.js';
import { ccsmConfirm } from '../dialog.js';

export function SnapshotMeta() {
  void clockTick.value;
  const snap = snapshot.value;
  const text = snap
    ? `${snap.sessions.length} session(s) · taken ${fmtAgo(snap.takenAt)} ago (${fmtTime(snap.takenAt)})`
    : 'no snapshot saved yet';
  return html`${text}`;
}

export function SnapshotPanel() {
  const [selectedHistory, setSelectedHistory] = useState('');
  const snap = snapshot.value;
  const hist = history.value;

  const preview = snap
    ? snap.sessions.map((s) =>
        `${(s.title || s.sessionId.slice(0, 8)).padEnd(44).slice(0, 44)}  ${s.cwd}`
      ).join('\n')
    : '';

  const onSave = async () => {
    try {
      const r = await api('POST', '/api/snapshot');
      snapshot.value = r.snapshot;
      const h = await api('GET', '/api/snapshot/history');
      history.value = h.history;
      setToast(`saved · ${r.snapshot.sessions.length} session(s)`);
    } catch (e) { setToast(e.message, 'error'); }
  };
  const onRestoreLatest = async () => {
    if (!snap || !snap.sessions.length) return setToast('no sessions in snapshot', 'error');
    const ok = await ccsmConfirm(
      `Restore ${snap.sessions.length} session(s)? Each opens a new wt window.`,
      { title: 'Restore latest snapshot', okLabel: `Restore ${snap.sessions.length}` },
    );
    if (!ok) return;
    try {
      const r = await api('POST', '/api/snapshot/restore');
      setToast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) { setToast(e.message, 'error'); }
  };
  const onRestoreHistory = async () => {
    if (!selectedHistory) return setToast('pick a history snapshot first', 'error');
    const ok = await ccsmConfirm(`Restore from ${selectedHistory}?`, {
      title: 'Restore from history', okLabel: 'Restore',
    });
    if (!ok) return;
    try {
      const r = await api('POST', '/api/snapshot/restore', { file: selectedHistory });
      setToast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) { setToast(e.message, 'error'); }
  };

  return html`
    <div class="row gap-row">
      <button class="action" onClick=${onSave}>Save snapshot now</button>
      <button class="action primary" onClick=${onRestoreLatest}>Restore latest</button>
      <span class="divider-dot">·</span>
      <select class="input narrow" value=${selectedHistory} onChange=${(e) => setSelectedHistory(e.target.value)}>
        <option value="">history…</option>
        ${hist.map((h) => html`<option key=${h.file} value=${h.file}>${h.file.replace('.json', '')}</option>`)}
      </select>
      <button class="action" onClick=${onRestoreHistory}>Restore selected</button>
    </div>
    <details class="snapshot-detail">
      <summary>View snapshot contents</summary>
      <pre class="preview">${preview}</pre>
    </details>`;
}
