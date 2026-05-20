'use strict';

/* ─────────────────────────────────────────────────────────────
   ccsm · frontend · v0.6 (light sidebar)
   ───────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  terminals: [],
  sessions: [],
  recent: [],
  recentTotal: 0,
  recentOffset: 0,
  recentLimit: 15,
  favorites: {},        // { sessionId: { sessionId, cwd, title, gitBranch, addedAt, label } }
  workspaces: [],
  snapshot: null,
  history: [],
  autoTimer: null,
  clockTimer: null,
  activeTab: 'sessions',
  // Tables that have already had their first render — used to suppress the
  // row stagger animation on subsequent re-renders so 5s auto-refresh
  // doesn't strobe.
  renderedTables: new Set(),
};

const TAB_HEADINGS = {
  sessions:  { title: 'Sessions',  subtitle: 'Live and recently-closed Claude Code sessions on this machine.' },
  launch:    { title: 'Launch',    subtitle: 'Spin up a new session in a fresh workspace, or restore from snapshot.' },
  configure: { title: 'Configure', subtitle: 'Persisted to ~/.ccsm/config.json.' },
};

/* ── API ── */
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

/* ── toast ── */
const toastEl = $('#toast');
let toastT;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

/* ── fmt ── */
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { hour12: false });
}
function fmtAgo(ms) {
  if (!ms) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* Mark a table as already-rendered so animations don't replay on
   subsequent updates. Call after the first innerHTML population. */
function markRendered(tableId) {
  const tb = document.querySelector(`#${tableId} tbody`);
  if (!tb) return;
  if (state.renderedTables.has(tableId)) {
    tb.classList.add('no-anim');
  } else {
    state.renderedTables.add(tableId);
    // first render: animation runs. We schedule no-anim for next paint
    // so the very next re-render doesn't restage.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => tb.classList.add('no-anim'));
    });
  }
}

const STAR_SVG_OUTLINE =
  `<svg class="star-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;
const STAR_SVG_FILLED =
  `<svg class="star-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

function starButtonHtml(sessionId, isFav) {
  return `<button class="star-btn ${isFav ? 'is-fav' : ''}" data-star="${escapeHtml(sessionId)}" title="${isFav ? 'remove favorite' : 'add favorite'}" aria-label="${isFav ? 'remove favorite' : 'add favorite'}">${isFav ? STAR_SVG_FILLED : STAR_SVG_OUTLINE}</button>`;
}

/* ─────────────────────────────────────────────────────────────
   Sidebar — tabs + collapse
   ───────────────────────────────────────────────────────────── */

function selectTab(name) {
  if (!TAB_HEADINGS[name]) name = 'sessions';
  state.activeTab = name;
  $$('.nav-item').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  $$('.tab-panel').forEach((p) => {
    if (p.dataset.panel === name) p.setAttribute('data-active', '');
    else p.removeAttribute('data-active');
  });
  const h = TAB_HEADINGS[name];
  $('#pageTitle').textContent = h.title;
  $('#pageSubtitle').textContent = h.subtitle;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function toggleSidebar() {
  const sb = $('#sidebar');
  const collapsed = sb.getAttribute('data-collapsed') === 'true';
  sb.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
  localStorage.setItem('ccsm.sidebar-collapsed', collapsed ? 'false' : 'true');
}
function restoreSidebar() {
  const v = localStorage.getItem('ccsm.sidebar-collapsed');
  if (v === 'true') $('#sidebar').setAttribute('data-collapsed', 'true');
}

/* ─────────────────────────────────────────────────────────────
   Render: sessions (live)
   ───────────────────────────────────────────────────────────── */

function renderSessions() {
  const tb = $('#sessionsTable tbody');
  tb.innerHTML = '';
  for (const s of state.sessions) {
    const isFav = !!state.favorites[s.sessionId];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="status-mark ${escapeHtml(s.status)}" title="${escapeHtml(s.status)}"></span></td>
      <td>
        <div class="title-cell">
          <div class="title-row">
            <span class="primary" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || '(no title)')}</span>
            ${starButtonHtml(s.sessionId, isFav)}
          </div>
          <div class="secondary" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId.slice(0, 8))}${s.version ? ' · ' + escapeHtml(s.version) : ''}</div>
        </div>
      </td>
      <td><div class="path-cell" title="${escapeHtml(s.cwd)}">${escapeHtml(s.cwd)}</div></td>
      <td class="num" title="${escapeHtml(fmtTime(s.updatedAt))}">${escapeHtml(fmtAgo(s.updatedAt))}</td>
      <td class="num" title="${escapeHtml(fmtTime(s.startedAt))}">${escapeHtml(fmtAgo(s.startedAt))}</td>
      <td class="num">${escapeHtml(String(s.pid))}</td>
      <td>
        <div class="row-actions">
          <button class="action small primary" data-focus="${escapeHtml(s.sessionId)}" title="raise the wt window already running this session">Focus</button>
          <button class="action small" data-resume="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd)}" title="open a new wt window with claude --resume">Resume new ↗</button>
        </div>
      </td>
    `;
    tr.dataset.cwd = s.cwd;
    tr.dataset.title = s.title || '';
    tb.appendChild(tr);
  }
  $('#sessionsEmpty').hidden = state.sessions.length > 0;
  const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
  $('#sessionsMeta').textContent = state.sessions.length
    ? `${state.sessions.length} live · refreshed ${ts}`
    : 'no live sessions';
  $('#navCount-sessions').textContent = state.sessions.length;
  markRendered('sessionsTable');
}

/* ─────────────────────────────────────────────────────────────
   Render: recently closed
   ───────────────────────────────────────────────────────────── */

function renderRecent() {
  const tb = $('#recentTable tbody');
  tb.innerHTML = '';
  const recent = state.recent || [];
  for (const s of recent) {
    const isFav = !!state.favorites[s.sessionId];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="title-cell">
          <div class="title-row">
            <span class="primary" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || '(no title)')}</span>
            ${starButtonHtml(s.sessionId, isFav)}
          </div>
          <div class="secondary" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId.slice(0, 8))}</div>
        </div>
      </td>
      <td><div class="path-cell" title="${escapeHtml(s.cwd || '')}">${escapeHtml(s.cwd || '')}</div></td>
      <td>${s.gitBranch ? `<span class="branch-tag">${escapeHtml(s.gitBranch)}</span>` : '<span class="muted-text">—</span>'}</td>
      <td class="num" title="${escapeHtml(fmtTime(s.updatedAt))}">${escapeHtml(fmtAgo(s.updatedAt))}</td>
      <td class="num" title="${escapeHtml(fmtTime(s.startedAt))}">${escapeHtml(fmtAgo(s.startedAt))}</td>
      <td>
        <div class="row-actions">
          <button class="action small primary" data-continue="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd)}" title="claude --resume in a fresh wt window">Continue ↗</button>
        </div>
      </td>
    `;
    tr.dataset.cwd = s.cwd || '';
    tr.dataset.title = s.title || '';
    tr.dataset.gitBranch = s.gitBranch || '';
    tb.appendChild(tr);
  }
  $('#recentEmpty').hidden = recent.length > 0;
  // Pagination footer
  const total = state.recentTotal;
  const limit = state.recentLimit;
  const offset = state.recentOffset;
  const pageNum = Math.floor(offset / limit) + 1;
  const pageTotal = Math.max(1, Math.ceil(total / limit));
  $('#recentMeta').textContent = total
    ? `${total} total · sorted by jsonl mtime, excluding live`
    : 'no recent sessions';
  if (total > limit) {
    $('#recentPagination').hidden = false;
    $('#recentPageNum').textContent = pageNum;
    $('#recentPageTotal').textContent = pageTotal;
    $('#recentTotal').textContent = total;
    $('#recentPrevBtn').disabled = offset === 0;
    $('#recentNextBtn').disabled = offset + limit >= total;
  } else {
    $('#recentPagination').hidden = true;
  }
  markRendered('recentTable');
}

/* ─────────────────────────────────────────────────────────────
   Render: favorites
   ───────────────────────────────────────────────────────────── */
function renderFavorites() {
  const tb = $('#favoritesTable tbody');
  tb.innerHTML = '';
  const list = Object.values(state.favorites).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const f of list) {
    const liveMatch = state.sessions.find((s) => s.sessionId === f.sessionId);
    const title = liveMatch?.title || f.title;
    const cwd = liveMatch?.cwd || f.cwd;
    const branch = f.gitBranch;
    const actions = liveMatch
      ? `<button class="action small primary" data-focus="${escapeHtml(f.sessionId)}" title="raise the wt window">Focus</button>
         <button class="action small" data-resume="${escapeHtml(f.sessionId)}" data-cwd="${escapeHtml(cwd)}" title="claude --resume in a fresh wt window">Resume new ↗</button>`
      : `<button class="action small primary" data-continue="${escapeHtml(f.sessionId)}" data-cwd="${escapeHtml(cwd || '')}" ${cwd ? '' : 'disabled'} title="claude --resume in a fresh wt window">Continue ↗</button>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="title-cell">
          <div class="title-row">
            <span class="primary" title="${escapeHtml(title || '')}">${escapeHtml(title || '(no title)')}</span>
            ${starButtonHtml(f.sessionId, true)}
          </div>
          <div class="secondary" title="${escapeHtml(f.sessionId)}">
            ${escapeHtml(f.sessionId.slice(0, 8))}${liveMatch ? ` · <span style="color:var(--green);">live</span>` : ''}
          </div>
        </div>
      </td>
      <td><div class="path-cell" title="${escapeHtml(cwd || '')}">${escapeHtml(cwd || '')}</div></td>
      <td>${branch ? `<span class="branch-tag">${escapeHtml(branch)}</span>` : '<span class="muted-text">—</span>'}</td>
      <td class="num" title="${escapeHtml(fmtTime(f.addedAt))}">${escapeHtml(fmtAgo(f.addedAt))}</td>
      <td><div class="row-actions">${actions}</div></td>
    `;
    tr.dataset.cwd = cwd || '';
    tr.dataset.title = title || '';
    tb.appendChild(tr);
  }
  const count = list.length;
  $('#favoritesEmpty').style.display = count === 0 ? 'block' : 'none';
  $('#favoritesTable').style.display = count === 0 ? 'none' : 'table';
  $('#favoritesMeta').textContent = count
    ? `${count} pinned`
    : 'click ☆ on any row to pin sessions here';
  markRendered('favoritesTable');
}

/* ─────────────────────────────────────────────────────────────
   Render: snapshot
   ───────────────────────────────────────────────────────────── */

function renderSnapshot() {
  const snap = state.snapshot;
  if (!snap) {
    $('#snapshotMeta').textContent = 'no snapshot saved yet';
    $('#snapshotPreview').textContent = '';
    return;
  }
  $('#snapshotMeta').textContent =
    `${snap.sessions.length} session(s) · taken ${fmtAgo(snap.takenAt)} ago (${fmtTime(snap.takenAt)})`;
  $('#snapshotPreview').textContent =
    snap.sessions.map((s) =>
      `${(s.title || s.sessionId.slice(0, 8)).padEnd(44).slice(0, 44)}  ${s.cwd}`
    ).join('\n');

  const sel = $('#historySelect');
  sel.innerHTML = '<option value="">history…</option>' +
    state.history.map((h) =>
      `<option value="${escapeHtml(h.file)}">${escapeHtml(h.file.replace('.json', ''))}</option>`
    ).join('');
}

/* ─────────────────────────────────────────────────────────────
   Render: workspaces
   ───────────────────────────────────────────────────────────── */

function renderWorkspaces() {
  const grid = $('#workspaceList');
  grid.innerHTML = '';
  if (state.workspaces.length === 0) {
    grid.innerHTML = '<div class="empty">No workspaces yet — the first launch will create one.</div>';
  }
  for (const w of state.workspaces) {
    const repos = w.repos.map((r) =>
      `<span class="ws-repo ${r.cloned ? 'cloned' : ''}" title="${escapeHtml(r.url)}">${escapeHtml(r.name)}${r.cloned ? ' ✓' : ''}</span>`
    ).join('');
    const card = document.createElement('div');
    card.className = 'workspace-card' + (w.inUse ? ' in-use' : '');
    card.innerHTML = `
      <div class="ws-head">
        <div class="ws-name">${escapeHtml(w.name)}</div>
        <span class="ws-tag">${w.inUse ? `in use × ${w.sessionsHere.length}` : 'free'}</span>
      </div>
      <div class="ws-path">${escapeHtml(w.path)}</div>
      <div class="ws-repos">${repos}</div>
    `;
    grid.appendChild(card);
  }

  const sel = $('#workspaceSelect');
  sel.innerHTML = '<option value="">auto — find or create unused</option>' +
    state.workspaces.filter((w) => !w.inUse).map((w) =>
      `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)}</option>`
    ).join('');

  if (state.config) $('#workDirDisplay').textContent = state.config.workDir;
}

/* ─────────────────────────────────────────────────────────────
   Render: repo picker
   ───────────────────────────────────────────────────────────── */

function renderRepoPicker() {
  const root = $('#repoPicker');
  const repos = state.config?.repos || [];
  if (repos.length === 0) {
    root.innerHTML = '<span class="muted-text">no repos configured · add some in <strong>Configure</strong></span>';
    return;
  }
  root.innerHTML = '';
  for (const r of repos) {
    const chip = document.createElement('label');
    chip.className = 'chip' + (r.defaultSelected ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" data-repo="${escapeHtml(r.name)}" ${r.defaultSelected ? 'checked' : ''}/>${escapeHtml(r.name)}`;
    chip.querySelector('input').addEventListener('change', (e) => {
      chip.classList.toggle('checked', e.target.checked);
    });
    root.appendChild(chip);
  }
}

/* ─────────────────────────────────────────────────────────────
   Render: config form
   ───────────────────────────────────────────────────────────── */

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
    `<option value="${escapeHtml(t.name)}" ${t.name === state.config.terminal ? 'selected' : ''}>${escapeHtml(t.name)} · ${escapeHtml(t.processName)}</option>`
  ).join('');

  $('#cfgFinderPrompt').value = state.config.finderPrompt || '';

  const tb = $('#reposTable tbody');
  tb.innerHTML = '';
  (state.config.repos || []).forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(r.name)}" data-field="name" data-idx="${idx}" /></td>
      <td><input type="text" value="${escapeHtml(r.url)}" data-field="url" data-idx="${idx}" /></td>
      <td class="num"><input type="checkbox" data-field="defaultSelected" data-idx="${idx}" ${r.defaultSelected ? 'checked' : ''} /></td>
      <td><div class="row-actions"><button class="action tiny danger" data-remove-repo="${idx}">Remove</button></div></td>
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

/* ─────────────────────────────────────────────────────────────
   Header + footer status
   ───────────────────────────────────────────────────────────── */

function renderHeaderStatus() {
  if (!state.config) return;
  $('#hdPort').textContent = String(state.config.port);
  $('#hdTerminal').textContent =
    `${state.config.terminal} · ${state.config.claudeCommand}` +
    (state.config.terminal === 'wt' ? ` (${state.config.commandShell})` : '');
  $('#footWorkDir').textContent = state.config.workDir;
  $('#footData').textContent = '~/.ccsm';
}
function tickClock() {
  const t = new Date().toLocaleTimeString(undefined, { hour12: false });
  const el = $('#hdTime');
  if (el) el.textContent = t;
}

/* ─────────────────────────────────────────────────────────────
   Loaders
   ───────────────────────────────────────────────────────────── */

async function loadConfig() {
  const [cfg, terminals] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/terminals'),
  ]);
  state.config = cfg;
  state.terminals = terminals.terminals;
  renderConfig();
  renderRepoPicker();
  renderHeaderStatus();
}
async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  state.sessions = r.sessions;
  renderSessions();
}
async function loadRecent() {
  const r = await api('GET', `/api/sessions/recent?limit=${state.recentLimit}&offset=${state.recentOffset}`);
  state.recent = r.recent;
  state.recentTotal = r.total || 0;
  state.recentLimit = r.limit || state.recentLimit;
  state.recentOffset = r.offset || 0;
  renderRecent();
}

async function loadFavorites() {
  try {
    const r = await api('GET', '/api/favorites');
    const map = {};
    for (const f of r.favorites || []) map[f.sessionId] = f;
    state.favorites = map;
    renderFavorites();
  } catch (e) { /* ignore */ }
}

async function toggleFavorite(sessionId, sourceRow) {
  const wasFav = !!state.favorites[sessionId];
  if (wasFav) {
    // optimistic remove
    delete state.favorites[sessionId];
    renderFavorites();
    renderSessions();
    renderRecent();
    try { await api('DELETE', `/api/favorites/${sessionId}`); }
    catch (e) { toast('unfavorite failed: ' + e.message, 'error'); }
  } else {
    // optimistic add — snapshot row's data so the favorite is meaningful
    // even when the session later moves out of live/recent
    const cwd = sourceRow?.dataset?.cwd || '';
    const title = sourceRow?.dataset?.title || '';
    const gitBranch = sourceRow?.dataset?.gitBranch || '';
    state.favorites[sessionId] = { sessionId, cwd, title, gitBranch, addedAt: Date.now() };
    renderFavorites();
    renderSessions();
    renderRecent();
    try { await api('POST', `/api/favorites/${sessionId}`, { cwd, title, gitBranch }); }
    catch (e) { toast('favorite failed: ' + e.message, 'error'); }
  }
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
  await Promise.all([loadSessions(), loadRecent(), loadSnapshot(), loadWorkspaces(), loadFavorites()]);
}

/* ─────────────────────────────────────────────────────────────
   Clone progress stream (NDJSON)
   ───────────────────────────────────────────────────────────── */

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
        `workspace: ${ev.workspace.path}${ev.created ? ' · newly created' : ''}`;
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
        setProgress(ev.repo, { phase: ev.action || 'done', percent: 100, detail: ev.path || '', state: 'ok' });
      } else {
        setProgress(ev.repo, { phase: 'error', detail: ev.error, state: 'error' });
      }
      break;
    case 'launched':
      $('#newSessionResult').textContent =
        `terminal launching · pid ${ev.launched.pid} · ${ev.launched.terminal}`;
      break;
  }
}

/* ─────────────────────────────────────────────────────────────
   Wiring
   ───────────────────────────────────────────────────────────── */

function wireUp() {
  /* sidebar */
  $$('.nav-item').forEach((b) => {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
  });
  $('#collapseBtn').addEventListener('click', toggleSidebar);

  /* hash routing */
  const hash = location.hash.slice(1);
  if (TAB_HEADINGS[hash]) state.activeTab = hash;

  $('#refreshBtn').onclick = () => refreshAll().then(() => toast('refreshed'));

  /* delegated star toggle across all tables */
  for (const tableSel of ['#sessionsTable', '#recentTable', '#favoritesTable']) {
    $(tableSel).addEventListener('click', (ev) => {
      const starBtn = ev.target.closest('button[data-star]');
      if (!starBtn) return;
      ev.stopPropagation();
      const sessionId = starBtn.dataset.star;
      const row = starBtn.closest('tr');
      toggleFavorite(sessionId, row);
    });
  }

  /* favorites table delegated actions (focus / resume / continue) */
  $('#favoritesTable').addEventListener('click', async (ev) => {
    const focusBtn = ev.target.closest('button[data-focus]');
    if (focusBtn) {
      const sessionId = focusBtn.dataset.focus;
      focusBtn.disabled = true;
      try {
        const r = await api('POST', `/api/sessions/${sessionId}/focus`);
        if (r.ok && r.activated) toast(`focused · ${r.windowTitle || sessionId.slice(0, 8)}`);
        else toast(`focus blocked or not running`, 'error');
      } catch (e) { toast(e.message, 'error'); }
      finally { focusBtn.disabled = false; }
      return;
    }
    const resumeBtn = ev.target.closest('button[data-resume], button[data-continue]');
    if (!resumeBtn) return;
    const sessionId = resumeBtn.dataset.resume || resumeBtn.dataset.continue;
    const cwd = resumeBtn.dataset.cwd;
    if (!cwd) return toast('no cwd for this favorite', 'error');
    resumeBtn.disabled = true;
    try {
      await api('POST', `/api/sessions/${sessionId}/resume`, { cwd });
      toast(`opening wt · ${sessionId.slice(0, 8)}…`);
    } catch (e) { toast(e.message, 'error'); }
    finally { resumeBtn.disabled = false; }
  });

  /* inline finder button on Sessions tab — same handler as the sidebar one */
  const inlineFinder = $('#finderInlineBtn');
  if (inlineFinder) {
    inlineFinder.onclick = () => $('#finderBtn').click();
  }

  /* recent pagination */
  $('#recentPrevBtn').onclick = () => {
    state.recentOffset = Math.max(0, state.recentOffset - state.recentLimit);
    loadRecent().catch(() => {});
  };
  $('#recentNextBtn').onclick = () => {
    state.recentOffset = state.recentOffset + state.recentLimit;
    loadRecent().catch(() => {});
  };
  $('#recentPageSize').onchange = (e) => {
    state.recentLimit = Math.max(1, Number(e.target.value) || 15);
    state.recentOffset = 0;
    loadRecent().catch(() => {});
  };

  /* live sessions actions */
  $('#sessionsTable').addEventListener('click', async (ev) => {
    if (ev.target.closest('button[data-star]')) return;
    const focusBtn = ev.target.closest('button[data-focus]');
    if (focusBtn) {
      const sessionId = focusBtn.dataset.focus;
      focusBtn.disabled = true;
      try {
        const r = await api('POST', `/api/sessions/${sessionId}/focus`);
        if (r.ok && r.activated) toast(`focused · ${r.windowTitle || sessionId.slice(0, 8)}`);
        else if (r.ok) toast(`window found, focus blocked (${r.windowProcess})`, 'error');
        else toast(`no window for pid · ${(r.chain || []).map((c) => c.name).join('→')}`, 'error');
      } catch (e) { toast(e.message, 'error'); }
      finally { focusBtn.disabled = false; }
      return;
    }
    const resumeBtn = ev.target.closest('button[data-resume]');
    if (!resumeBtn) return;
    const sessionId = resumeBtn.dataset.resume;
    const cwd = resumeBtn.dataset.cwd;
    resumeBtn.disabled = true;
    try {
      await api('POST', `/api/sessions/${sessionId}/resume`, { cwd });
      toast(`opening wt · ${sessionId.slice(0, 8)}…`);
    } catch (e) { toast(e.message, 'error'); }
    finally { resumeBtn.disabled = false; }
  });

  /* recent continue */
  $('#recentTable').addEventListener('click', async (ev) => {
    if (ev.target.closest('button[data-star]')) return;
    const btn = ev.target.closest('button[data-continue]');
    if (!btn) return;
    const sessionId = btn.dataset.continue;
    const cwd = btn.dataset.cwd;
    btn.disabled = true;
    try {
      await api('POST', `/api/sessions/${sessionId}/resume`, { cwd });
      toast(`continuing · ${sessionId.slice(0, 8)}…`);
      setTimeout(() => loadSessions().catch(() => {}), 3000);
      setTimeout(() => loadRecent().catch(() => {}), 4000);
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  });

  /* finder */
  $('#finderBtn').onclick = async () => {
    try {
      await api('POST', '/api/sessions/finder');
      toast('finder session launching in a new wt window');
    } catch (e) { toast(e.message, 'error'); }
  };

  /* snapshot */
  $('#snapshotSaveBtn').onclick = async () => {
    try {
      const r = await api('POST', '/api/snapshot');
      state.snapshot = r.snapshot;
      const h = await api('GET', '/api/snapshot/history');
      state.history = h.history;
      renderSnapshot();
      toast(`saved · ${r.snapshot.sessions.length} session(s)`);
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#snapshotRestoreBtn').onclick = async () => {
    const snap = state.snapshot;
    if (!snap || !snap.sessions.length) return toast('no sessions in snapshot', 'error');
    if (!confirm(`Restore ${snap.sessions.length} session(s)? Each opens a new wt window.`)) return;
    try {
      const r = await api('POST', '/api/snapshot/restore');
      toast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#historyRestoreBtn').onclick = async () => {
    const file = $('#historySelect').value;
    if (!file) return toast('pick a history snapshot first', 'error');
    if (!confirm(`Restore from ${file}?`)) return;
    try {
      const r = await api('POST', '/api/snapshot/restore', { file });
      toast(`launched ${r.restored.launched.length} / ${r.count}`);
    } catch (e) { toast(e.message, 'error'); }
  };

  /* new session */
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
          `launched in ${ws.path}${result.created ? ' · newly created' : ''} — ${summary}`;
        toast(`launched · ${ws.name}`);
      } else {
        $('#newSessionResult').textContent = `error: ${result.error}`;
        toast(result.error || 'new session failed', 'error');
      }
      await loadWorkspaces();
    } catch (e) {
      $('#newSessionResult').textContent = `error: ${e.message}`;
      toast(e.message, 'error');
    } finally { btn.disabled = false; }
  };

  /* config save */
  $('#saveConfigBtn').onclick = async () => {
    const next = readConfigFromForm();
    try {
      const cfg = await api('PUT', '/api/config', next);
      state.config = cfg;
      renderConfig();
      renderRepoPicker();
      renderHeaderStatus();
      $('#configSavedAt').textContent = `saved · ${new Date().toLocaleTimeString(undefined, { hour12: false })}`;
      toast('config saved');
      await loadWorkspaces();
    } catch (e) { toast(e.message, 'error'); }
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

function startAutoRefresh() {
  if (state.autoTimer) clearInterval(state.autoTimer);
  state.autoTimer = setInterval(() => {
    loadSessions().catch(() => {});
    loadRecent().catch(() => {});
    loadSnapshot().catch(() => {});
  }, 5000);
}

// Re-render favorites when sessions update so live status of favorited rows refreshes.
function reRenderFavoritesIfNeeded() {
  if (Object.keys(state.favorites).length === 0) return;
  renderFavorites();
}

/* ─────────────────────────────────────────────────────────────
   Boot
   ───────────────────────────────────────────────────────────── */

(async () => {
  restoreSidebar();
  wireUp();
  try {
    await loadConfig();
    await refreshAll();
    selectTab(state.activeTab);
    startAutoRefresh();
    tickClock();
    state.clockTimer = setInterval(tickClock, 1000);
  } catch (e) {
    toast('initial load failed · ' + e.message, 'error');
  }
})();
