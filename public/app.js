'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  sessions: [],
  workspaces: [],
  snapshot: null,
  history: [],
  autoTimer: null,
};

// ---- API helpers ----

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

// ---- toast ----

const toastEl = $('#toast');
let toastT;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// ---- formatting ----

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { hour12: false });
}
function fmtAgo(ms) {
  if (!ms) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// ---- sessions render ----

function renderSessions() {
  const tb = $('#sessionsTable tbody');
  tb.innerHTML = '';
  for (const s of state.sessions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="status-dot ${escapeHtml(s.status)}" title="${escapeHtml(s.status)}"></span></td>
      <td><div class="ellipsis" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || '(no title)')}</div>
          <div class="mono small" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId.slice(0,8))}…</div></td>
      <td><div class="ellipsis mono" title="${escapeHtml(s.cwd)}">${escapeHtml(s.cwd)}</div></td>
      <td title="${escapeHtml(fmtTime(s.updatedAt))}">${escapeHtml(fmtAgo(s.updatedAt))}</td>
      <td title="${escapeHtml(fmtTime(s.startedAt))}">${escapeHtml(fmtAgo(s.startedAt))}</td>
      <td class="mono">${escapeHtml(String(s.pid))}</td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="btn small btn-primary" data-focus="${escapeHtml(s.sessionId)}" title="bring the wt window already hosting this session to the foreground">focus</button>
        <button class="btn small" data-resume="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd)}" title="open a NEW wt window with claude --resume">resume new</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  $('#sessionsMeta').textContent =
    state.sessions.length ? `${state.sessions.length} live · last refresh ${new Date().toLocaleTimeString()}` : 'no live sessions';
}

// ---- snapshot render ----

function renderSnapshot() {
  const snap = state.snapshot;
  if (!snap) {
    $('#snapshotMeta').textContent = 'no snapshot yet';
    $('#snapshotPreview').textContent = '';
    return;
  }
  $('#snapshotMeta').textContent =
    `${snap.sessions.length} session(s) — taken ${fmtAgo(snap.takenAt)} (${fmtTime(snap.takenAt)})`;
  const lines = snap.sessions.map((s) =>
    `${(s.title || s.sessionId.slice(0,8)).padEnd(40).slice(0,40)}  ${s.cwd}`
  );
  $('#snapshotPreview').textContent = lines.join('\n');

  const sel = $('#historySelect');
  sel.innerHTML = '<option value="">history…</option>' +
    state.history.map((h) => `<option value="${escapeHtml(h.file)}">${escapeHtml(h.file.replace('.json',''))}</option>`).join('');
}

// ---- workspaces render ----

function renderWorkspaces() {
  const ul = $('#workspaceList');
  ul.innerHTML = '';
  if (state.workspaces.length === 0) {
    ul.innerHTML = '<div class="muted small">no workspaces under workDir yet — first new-session will create one</div>';
  }
  for (const w of state.workspaces) {
    const repoTags = w.repos.map((r) =>
      `<span class="tag ${r.cloned ? 'ok' : ''}">${escapeHtml(r.name)}${r.cloned ? ' ✓' : ''}</span>`
    ).join(' ');
    const card = document.createElement('div');
    card.className = 'workspace-card' + (w.inUse ? ' in-use' : '');
    card.innerHTML = `
      <div>
        <div class="name">${escapeHtml(w.name)}
          ${w.inUse ? `<span class="tag warn">in use × ${w.sessionsHere.length}</span>` : '<span class="tag ok">free</span>'}
        </div>
        <div class="repos">${escapeHtml(w.path)}</div>
        <div style="margin-top:4px;">${repoTags}</div>
      </div>
    `;
    ul.appendChild(card);
  }

  const sel = $('#workspaceSelect');
  sel.innerHTML = '<option value="">(auto — find or create unused)</option>' +
    state.workspaces.filter((w) => !w.inUse).map((w) =>
      `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)}</option>`
    ).join('');
}

// ---- repo picker render (for "new session") ----

function renderRepoPicker() {
  const root = $('#repoPicker');
  root.innerHTML = '';
  for (const r of (state.config?.repos || [])) {
    const id = `repo_${r.name}`;
    const chip = document.createElement('label');
    chip.className = 'repo-chip' + (r.defaultSelected ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" id="${id}" data-repo="${escapeHtml(r.name)}" ${r.defaultSelected ? 'checked' : ''}/>${escapeHtml(r.name)}`;
    chip.querySelector('input').addEventListener('change', (e) => {
      chip.classList.toggle('checked', e.target.checked);
    });
    root.appendChild(chip);
  }
}

// ---- config form render ----

function renderConfig() {
  if (!state.config) return;
  $('#cfgPort').value = state.config.port;
  $('#cfgWorkDir').value = state.config.workDir;
  $('#cfgInterval').value = state.config.snapshotIntervalMs;
  $('#cfgKeep').value = state.config.snapshotHistoryKeep;
  $('#cfgClaudeCommand').value = state.config.claudeCommand || 'claude';
  $('#cfgCommandShell').value = state.config.commandShell || 'pwsh';
  $('#cfgAutoFocus').checked = state.config.autoFocusOnLaunch !== false;
  $('#cfgBrowserMode').value =
    state.config.browserMode ||
    (state.config.autoOpenBrowser === false ? 'none' : 'app');
  const termSel = $('#cfgTerminal');
  termSel.innerHTML = (state.terminals || []).map((t) =>
    `<option value="${escapeHtml(t.name)}" ${t.name === state.config.terminal ? 'selected' : ''}>${escapeHtml(t.name)} (${escapeHtml(t.processName)})</option>`
  ).join('');
  $('#cfgFinderPrompt').value = state.config.finderPrompt || '';

  const tb = $('#reposTable tbody');
  tb.innerHTML = '';
  (state.config.repos || []).forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(r.name)}" data-field="name" data-idx="${idx}" style="width:140px;" /></td>
      <td><input type="text" value="${escapeHtml(r.url)}" data-field="url" data-idx="${idx}" style="width:100%;" /></td>
      <td style="text-align:center;"><input type="checkbox" data-field="defaultSelected" data-idx="${idx}" ${r.defaultSelected ? 'checked' : ''} /></td>
      <td style="text-align:right;"><button class="btn small btn-danger" data-remove-repo="${idx}">remove</button></td>
    `;
    tb.appendChild(tr);
  });
}

function readConfigFromForm() {
  const repos = $$('#reposTable tbody tr').map((tr) => {
    const inputs = tr.querySelectorAll('input');
    return {
      name: inputs[0].value.trim(),
      url: inputs[1].value.trim(),
      defaultSelected: inputs[2].checked,
    };
  }).filter((r) => r.name && r.url);

  return {
    port: Number($('#cfgPort').value) || 7777,
    workDir: $('#cfgWorkDir').value.trim(),
    snapshotIntervalMs: Math.max(5000, Number($('#cfgInterval').value) || 60000),
    snapshotHistoryKeep: Math.max(1, Number($('#cfgKeep').value) || 30),
    claudeCommand: ($('#cfgClaudeCommand').value || 'claude').trim(),
    terminal: $('#cfgTerminal').value || 'wt',
    commandShell: $('#cfgCommandShell').value || 'pwsh',
    autoFocusOnLaunch: $('#cfgAutoFocus').checked,
    browserMode: $('#cfgBrowserMode').value || 'app',
    finderPrompt: $('#cfgFinderPrompt').value,
    repos,
  };
}

// ---- data fetching ----

async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  state.sessions = r.sessions;
  renderSessions();
}

async function loadConfig() {
  const [cfg, terminals] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/terminals'),
  ]);
  state.config = cfg;
  state.terminals = terminals.terminals;
  renderConfig();
  renderRepoPicker();
  $('#serverInfo').textContent =
    `port ${state.config.port} · workDir ${state.config.workDir} · terminal ${state.config.terminal} · ${state.config.claudeCommand}`;
}

async function loadSnapshot() {
  const r = await api('GET', '/api/snapshot');
  state.snapshot = r.snapshot;
  const h = await api('GET', '/api/snapshot/history');
  state.history = h.history;
  renderSnapshot();
}

async function loadWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  state.workspaces = r.workspaces;
  renderWorkspaces();
}

async function refreshAll() {
  await Promise.all([loadSessions(), loadSnapshot(), loadWorkspaces()]);
}

// ---- event wiring ----

function wireUp() {
  $('#refreshBtn').onclick = () => refreshAll().then(() => toast('refreshed'));

  $('#autoRefresh').onchange = (e) => {
    if (e.target.checked) startAutoRefresh();
    else stopAutoRefresh();
  };

  $('#sessionsTable').addEventListener('click', async (ev) => {
    const focusBtn = ev.target.closest('button[data-focus]');
    if (focusBtn) {
      const sessionId = focusBtn.dataset.focus;
      focusBtn.disabled = true;
      try {
        const r = await api('POST', `/api/sessions/${sessionId}/focus`);
        if (r.ok && r.activated) {
          toast(`focused: ${r.windowTitle || r.windowProcess || sessionId.slice(0,8)}`);
        } else if (r.ok) {
          toast(`window found but Windows blocked focus (${r.windowProcess}); try clicking the wt taskbar icon`, 'error');
        } else {
          toast(`no window for pid — chain: ${(r.chain||[]).map(c=>c.name).join('→')}`, 'error');
        }
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        focusBtn.disabled = false;
      }
      return;
    }
    const btn = ev.target.closest('button[data-resume]');
    if (!btn) return;
    const sessionId = btn.dataset.resume;
    const cwd = btn.dataset.cwd;
    btn.disabled = true;
    try {
      await api('POST', `/api/sessions/${sessionId}/resume`, { cwd });
      toast(`opening wt for ${sessionId.slice(0,8)}…`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#finderBtn').onclick = async () => {
    try {
      await api('POST', '/api/sessions/finder');
      toast('finder session launching in a new wt window');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#snapshotSaveBtn').onclick = async () => {
    try {
      const r = await api('POST', '/api/snapshot');
      state.snapshot = r.snapshot;
      const h = await api('GET', '/api/snapshot/history');
      state.history = h.history;
      renderSnapshot();
      toast(`saved snapshot with ${r.snapshot.sessions.length} session(s)`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#snapshotRestoreBtn').onclick = async () => {
    const snap = state.snapshot;
    if (!snap || !snap.sessions.length) return toast('no sessions in snapshot', 'error');
    if (!confirm(`Restore ${snap.sessions.length} session(s)? Each opens a new wt window.`)) return;
    try {
      const r = await api('POST', '/api/snapshot/restore');
      toast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#historyRestoreBtn').onclick = async () => {
    const file = $('#historySelect').value;
    if (!file) return toast('pick a history snapshot first', 'error');
    if (!confirm(`Restore from ${file}?`)) return;
    try {
      const r = await api('POST', '/api/snapshot/restore', { file });
      toast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#newSessionBtn').onclick = async () => {
    const repos = $$('#repoPicker input:checked').map((i) => i.dataset.repo);
    if (repos.length === 0) return toast('select at least one repo', 'error');
    const workspace = $('#workspaceSelect').value || undefined;
    const btn = $('#newSessionBtn');
    btn.disabled = true;
    $('#newSessionResult').textContent = '';
    resetProgress(repos);
    try {
      const result = await streamNewSession({ repos, workspace });
      if (result.success) {
        const ws = result.workspace;
        const summary = (result.cloneResults || []).map((c) => `${c.repo}: ${c.action || c.error}`).join(' · ');
        $('#newSessionResult').textContent =
          `launched in ${ws.path}${result.created ? ' (newly created)' : ''} — ${summary}`;
        toast(`launched new session in ${ws.name}`);
      } else {
        $('#newSessionResult').textContent = `error: ${result.error}`;
        toast(result.error || 'new session failed', 'error');
      }
      await loadWorkspaces();
    } catch (e) {
      $('#newSessionResult').textContent = `error: ${e.message}`;
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  $('#saveConfigBtn').onclick = async () => {
    const next = readConfigFromForm();
    try {
      const cfg = await api('PUT', '/api/config', next);
      state.config = cfg;
      renderConfig();
      renderRepoPicker();
      $('#configSavedAt').textContent = `saved at ${new Date().toLocaleTimeString()}`;
      toast('config saved');
      await loadWorkspaces();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  $('#addRepoBtn').onclick = () => {
    state.config.repos.push({ name: '', url: '', defaultSelected: false });
    renderConfig();
  };

  $('#reposTable').addEventListener('click', (ev) => {
    const rm = ev.target.closest('button[data-remove-repo]');
    if (!rm) return;
    const idx = Number(rm.dataset.removeRepo);
    state.config.repos.splice(idx, 1);
    renderConfig();
  });
}

// ---- auto refresh ----

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoTimer = setInterval(() => {
    loadSessions().catch(() => {});
    loadSnapshot().catch(() => {});
  }, 5000);
}
function stopAutoRefresh() {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
}

// ---- NDJSON streaming for /api/sessions/new ----

function resetProgress(repoNames) {
  const root = $('#newSessionProgress');
  root.innerHTML = '';
  for (const r of repoNames) {
    const el = document.createElement('div');
    el.className = 'progress-item';
    el.dataset.repo = r;
    el.innerHTML = `
      <div class="head">
        <span class="name">${escapeHtml(r)}</span>
        <span class="phase">queued</span>
        <span class="pct"></span>
      </div>
      <div class="progress-bar"><div class="fill"></div></div>
      <div class="detail"></div>
    `;
    root.appendChild(el);
  }
}

function progressItem(repo) {
  return document.querySelector(`#newSessionProgress .progress-item[data-repo="${CSS.escape(repo)}"]`);
}

function setProgress(repo, { phase, percent, detail, state, indeterminate } = {}) {
  const el = progressItem(repo);
  if (!el) return;
  if (state) {
    el.classList.remove('ok', 'error');
    if (state === 'ok' || state === 'error') el.classList.add(state);
  }
  if (phase != null) el.querySelector('.phase').textContent = phase;
  if (percent != null) {
    el.querySelector('.pct').textContent = `${percent}%`;
    el.querySelector('.fill').style.width = `${percent}%`;
    el.querySelector('.fill').classList.remove('indeterminate');
  }
  if (indeterminate) {
    el.querySelector('.fill').classList.add('indeterminate');
    el.querySelector('.pct').textContent = '';
  }
  if (detail != null) el.querySelector('.detail').textContent = detail;
}

async function streamNewSession(body) {
  const res = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.headers.get('content-type')?.startsWith('application/json')) {
    const j = await res.json();
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      handleNewSessionEvent(event);
      if (event.type === 'done') final = event;
    }
  }
  if (buf.trim()) {
    try {
      const event = JSON.parse(buf);
      handleNewSessionEvent(event);
      if (event.type === 'done') final = event;
    } catch {}
  }
  return final || { success: false, error: 'stream ended unexpectedly' };
}

function handleNewSessionEvent(ev) {
  switch (ev.type) {
    case 'workspace':
      $('#newSessionResult').textContent =
        `workspace: ${ev.workspace.path}${ev.created ? ' (new)' : ''}`;
      break;
    case 'clone-start':
      setProgress(ev.repo, { phase: 'starting', indeterminate: true });
      break;
    case 'clone-progress':
      setProgress(ev.repo, {
        phase: ev.phase,
        percent: ev.percent,
        detail: ev.detail || (ev.current != null ? `${ev.current}/${ev.total}` : ''),
      });
      break;
    case 'clone-end':
      if (ev.ok) {
        setProgress(ev.repo, {
          phase: ev.action || 'done',
          percent: 100,
          detail: ev.path || '',
          state: 'ok',
        });
      } else {
        setProgress(ev.repo, {
          phase: 'error',
          detail: ev.error,
          state: 'error',
        });
      }
      break;
    case 'launched':
      $('#newSessionResult').textContent =
        `terminal launching — pid ${ev.launched.pid} (${ev.launched.terminal})`;
      break;
    case 'done':
      // handled by caller
      break;
  }
}

// ---- boot ----

(async () => {
  wireUp();
  try {
    await loadConfig();
    await refreshAll();
    startAutoRefresh();
  } catch (e) {
    toast('initial load failed: ' + e.message, 'error');
  }
})();
