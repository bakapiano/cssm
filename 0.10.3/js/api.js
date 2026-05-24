// Fetch wrapper + every loader. Loaders push into signals from ./state.js.
// Cross-origin (hosted frontend → local backend) flows through httpBase().

import * as S from './state.js';
import { httpBase } from './backend.js';

export async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(httpBase() + url, opts);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

export async function loadConfig() {
  const [cfg, caps] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/capabilities').catch(() => ({ webTerminal: false })),
  ]);
  S.config.value = cfg;
  S.capabilities.value = caps;
}

// Update an existing CLI by id. patch is shallow-merged into the record.
export async function updateCli(id, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  // Built-in CLIs lock down identity-defining fields. UI already greys these
  // out; we belt-and-braces here so a tampered request from elsewhere
  // can't change them either.
  if (target?.builtin) {
    delete patch.command;
    delete patch.id;
    delete patch.builtin;
  }
  const toArr = (v, fallback) => Array.isArray(v) ? v :
    typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : fallback;
  const next = {
    ...cfg,
    clis: (cfg.clis || []).map((c) => c.id === id ? {
      ...c, ...patch,
      args: toArr(patch.args, c.args),
      resumeArgs: toArr(patch.resumeArgs, c.resumeArgs || []),
      shell: ['direct', 'pwsh', 'cmd'].includes(patch.shell ?? c.shell) ? (patch.shell ?? c.shell) : 'direct',
    } : c),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

export async function deleteCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  if (target?.builtin) throw new Error(`"${target.name}" is built-in and can't be deleted`);
  const clis = (cfg.clis || []).filter((c) => c.id !== id);
  if (clis.length === 0) throw new Error('cannot delete the last CLI');
  const next = { ...cfg, clis };
  if (next.defaultCliId === id) next.defaultCliId = clis[0].id;
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function updateRepo(name, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = {
    ...cfg,
    repos: (cfg.repos || []).map((r) => r.name === name ? {
      ...r,
      name: (patch.name ?? r.name).trim(),
      url: (patch.url ?? r.url).trim(),
      defaultSelected: patch.defaultSelected ?? r.defaultSelected,
    } : r),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function deleteRepo(name) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = { ...cfg, repos: (cfg.repos || []).filter((r) => r.name !== name) };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function setDefaultCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const saved = await api('PUT', '/api/config', { ...cfg, defaultCliId: id });
  S.config.value = saved;
}

// Add a new CLI to config.clis and return its id. Generates a fresh id
// from the command name + an integer suffix when collisions exist.
export async function createCli({ name, command, args, resumeArgs, shell, type }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const base = (name || command || 'cli').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cli';
  let id = base, n = 1;
  while ((cfg.clis || []).some((c) => c.id === id)) { id = `${base}-${++n}`; }
  const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);
  const next = {
    ...cfg,
    clis: [...(cfg.clis || []), {
      id,
      name: (name || command || id).trim(),
      command: (command || '').trim(),
      args: toArr(args),
      resumeArgs: toArr(resumeArgs),
      shell: ['direct', 'pwsh', 'cmd'].includes(shell) ? shell : 'direct',
      type: ['claude', 'codex', 'other'].includes(type) ? type : 'other',
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

// Add a new repo to config.repos. Repos are addressed by name (which must
// be unique). Returns the name on success, throws on duplicate.
export async function createRepo({ name, url, defaultSelected }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const cleanName = (name || '').trim();
  const cleanUrl = (url || '').trim();
  if (!cleanName) throw new Error('repo name required');
  if (!cleanUrl) throw new Error('repo url required');
  if ((cfg.repos || []).some((r) => r.name === cleanName)) {
    throw new Error(`repo "${cleanName}" already exists`);
  }
  const next = {
    ...cfg,
    repos: [...(cfg.repos || []), {
      name: cleanName,
      url: cleanUrl,
      defaultSelected: !!defaultSelected,
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return cleanName;
}

export async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  S.sessions.value = r.sessions || [];
  try { localStorage.setItem('ccsm.sessions-cache', JSON.stringify(S.sessions.value)); } catch {}
}

export async function loadFolders() {
  const r = await api('GET', '/api/folders');
  S.folders.value = (r.folders || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  try { localStorage.setItem('ccsm.folders-cache', JSON.stringify(S.folders.value)); } catch {}
}

export async function createFolder(name) {
  const r = await api('POST', '/api/folders', { name });
  await loadFolders();
  return r.folder;
}

export async function renameFolder(id, name) {
  const r = await api('PUT', `/api/folders/${id}`, { name });
  await loadFolders();
  return r.folder;
}

export async function deleteFolder(id) {
  await api('DELETE', `/api/folders/${id}`);
  await Promise.all([loadFolders(), loadSessions()]);
}

export async function reorderFolders(ids) {
  const r = await api('POST', '/api/folders/reorder', { ids });
  await loadFolders();
  return r.folders;
}

export async function setSessionFolder(sessionId, folderId) {
  await api('PUT', `/api/sessions/${sessionId}`, { folderId: folderId || null });
  await loadSessions();
}

export async function setSessionTitle(sessionId, title) {
  await api('PUT', `/api/sessions/${sessionId}`, { title });
  await loadSessions();
}

export async function deleteSession(sessionId) {
  await api('DELETE', `/api/sessions/${sessionId}`);
  await loadSessions();
}

// Per-session in-flight resume promise. Sidebar.onClick and the
// SessionsPage auto-resume effect can both fire for the same exited
// session in the same tick (clicking an exited row mounts SessionsPage
// which runs its effect AND awaits Sidebar's own POST). Without this
// dedup the backend gets two concurrent /resume requests and may spawn
// two PTYs against the same record. Cleared on resolve/reject.
const resumeInFlight = new Map(); // sessionId → Promise

export function resumeSession(sessionId) {
  const cached = resumeInFlight.get(sessionId);
  if (cached) return cached;
  const p = (async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/resume`);
    await loadSessions();
    return r.launched;
  })();
  resumeInFlight.set(sessionId, p);
  p.finally(() => { resumeInFlight.delete(sessionId); });
  return p;
}

export async function loadWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  S.workspaces.value = r.workspaces;
}

export async function deleteWorkspace(name) {
  await api('DELETE', `/api/workspaces/${encodeURIComponent(name)}`);
}

export async function refreshAll() {
  await Promise.all([
    loadSessions(),
    loadFolders(),
    loadWorkspaces(),
  ]);
  S.lastRefreshAt.value = Date.now();
}

// List existing CLI sessions discovered on disk for a given cli type.
// Returns array of { cliType, cliSessionId, cwd, mtime, summary, adopted }.
export async function listLocalCliSessions(cliType) {
  const r = await api('GET', `/api/cli-sessions/${cliType}`);
  return r.sessions || [];
}

// Adopt an existing upstream CLI session into ccsm. Returns the created
// (or existing) persistedSessions record.
export async function adoptSession({ cliId, cliSessionId, cwd, title, folderId }) {
  const r = await api('POST', '/api/sessions/adopt', { cliId, cliSessionId, cwd, title, folderId });
  return r;
}

export async function pollHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(httpBase() + '/api/health', { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    S.serverHealth.value = { state: 'online', version: j.version, pid: j.pid };
  } catch (e) {
    S.serverHealth.value = { state: 'offline', error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}
