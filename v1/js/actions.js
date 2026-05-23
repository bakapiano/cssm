// Mutation actions shared by SessionsPage, FavoritesTable etc. — each
// optimistically updates the relevant signal and rolls back on error.

import { favorites, labels, sessions, recent, config, capabilities, activeTerminalId, selectTab } from './state.js';
import { api, loadSessions, loadRecent, loadWebTerminals } from './api.js';
import { setToast } from './toast.js';
import { ccsmPrompt } from './dialog.js';

export async function renameSession(sessionId, currentLabel) {
  const next = await ccsmPrompt('Rename session', currentLabel || '', {
    title: 'Rename session',
    placeholder: 'leave empty to clear the label',
    okLabel: 'Save',
  });
  if (next === null) return;
  const trimmed = next.trim();
  const prev = labels.value[sessionId];
  const nextLabels = { ...labels.value };
  if (trimmed) nextLabels[sessionId] = trimmed;
  else delete nextLabels[sessionId];
  labels.value = nextLabels;
  try {
    if (trimmed) {
      await api('PUT', `/api/labels/${sessionId}`, { label: trimmed });
      setToast(`renamed · ${sessionId.slice(0, 8)}`);
    } else {
      await api('DELETE', `/api/labels/${sessionId}`);
      setToast(`cleared label · ${sessionId.slice(0, 8)}`);
    }
  } catch (e) {
    const rollback = { ...labels.value };
    if (prev !== undefined) rollback[sessionId] = prev;
    else delete rollback[sessionId];
    labels.value = rollback;
    setToast('rename failed: ' + e.message, 'error');
  }
}

// snapshotData: { cwd, title, gitBranch } — captured from the source row so
// the favorite stays renderable after the session leaves live/recent.
export async function toggleFavorite(sessionId, snapshotData = {}) {
  const wasFav = !!favorites.value[sessionId];
  if (wasFav) {
    const next = { ...favorites.value };
    delete next[sessionId];
    favorites.value = next;
    try { await api('DELETE', `/api/favorites/${sessionId}`); }
    catch (e) { setToast('unfavorite failed: ' + e.message, 'error'); }
  } else {
    const { cwd = '', title = '', gitBranch = '' } = snapshotData;
    favorites.value = {
      ...favorites.value,
      [sessionId]: { sessionId, cwd, title, gitBranch, addedAt: Date.now() },
    };
    try { await api('POST', `/api/favorites/${sessionId}`, { cwd, title, gitBranch }); }
    catch (e) { setToast('favorite failed: ' + e.message, 'error'); }
  }
}

export async function focusSession(sessionId) {
  try {
    const r = await api('POST', `/api/sessions/${sessionId}/focus`);
    if (r.ok && r.activated) setToast(`focused · ${r.windowTitle || sessionId.slice(0, 8)}`);
    else if (r.ok) setToast(`window found, focus blocked (${r.windowProcess})`, 'error');
    else setToast(`no window for pid · ${(r.chain || []).map((c) => c.name).join('→')}`, 'error');
  } catch (e) { setToast(e.message, 'error'); }
}

export async function resumeSession(sessionId, cwd, { kind = 'resume' } = {}) {
  if (!cwd) return setToast('no cwd for this session', 'error');
  const wantWeb = capabilities.value?.webTerminal
    && (config.value?.defaultTerminalMode || 'wt') === 'web';
  const terminal = wantWeb ? 'web' : 'wt';
  try {
    const r = await api('POST', `/api/sessions/${sessionId}/resume`, { cwd, terminal });
    if (r.launched?.mode === 'web') {
      setToast(`${kind === 'continue' ? 'continuing' : 'resuming'} in web · ${sessionId.slice(0, 8)}…`);
      await loadWebTerminals();
      if (r.launched.id) activeTerminalId.value = r.launched.id;
      selectTab('terminals');
    } else {
      const verb = kind === 'continue' ? 'continuing' : 'opening wt';
      setToast(`${verb} · ${sessionId.slice(0, 8)}…`);
    }
    if (kind === 'continue') {
      setTimeout(() => loadSessions().catch(() => {}), 3000);
      setTimeout(() => loadRecent().catch(() => {}), 4000);
    }
  } catch (e) { setToast(e.message, 'error'); }
}

export async function runFinder() {
  const wantWeb = capabilities.value?.webTerminal
    && (config.value?.defaultTerminalMode || 'wt') === 'web';
  const terminal = wantWeb ? 'web' : 'wt';
  try {
    const r = await api('POST', '/api/sessions/finder', { terminal });
    if (r.launched?.mode === 'web') {
      await loadWebTerminals();
      if (r.launched.id) activeTerminalId.value = r.launched.id;
      selectTab('terminals');
      setToast('finder launching in web terminal');
    } else {
      setToast('finder session launching in a new wt window');
    }
  } catch (e) { setToast(e.message, 'error'); }
}
