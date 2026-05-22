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
  const [cfg, terms, caps] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/terminals'),
    api('GET', '/api/capabilities').catch(() => ({ webTerminal: false })),
  ]);
  S.config.value = cfg;
  S.terminals.value = terms.terminals;
  S.capabilities.value = caps;
}

export async function loadWebTerminals() {
  try {
    const r = await api('GET', '/api/sessions/web');
    S.webTerminals.value = r.terminals || [];
  } catch { /* node-pty might be unavailable */ }
}

export async function killWebTerminal(id) {
  await api('DELETE', `/api/sessions/web/${id}`);
  await loadWebTerminals();
}

export async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  S.sessions.value = r.sessions;
}

export async function loadRecent() {
  const r = await api('GET', `/api/sessions/recent?limit=${S.recentLimit.value}&offset=${S.recentOffset.value}`);
  S.recent.value = r.recent;
  S.recentTotal.value = r.total || 0;
  S.recentLimit.value = r.limit || S.recentLimit.value;
  S.recentOffset.value = r.offset || 0;
}

export async function loadFavorites() {
  try {
    const r = await api('GET', '/api/favorites');
    const map = {};
    for (const f of r.favorites || []) map[f.sessionId] = f;
    S.favorites.value = map;
  } catch (e) { /* ignore — endpoint may not exist on older servers */ }
}

export async function loadLabels() {
  try {
    const r = await api('GET', '/api/labels');
    S.labels.value = r.labels || {};
  } catch (e) { /* ignore */ }
}

export async function loadSnapshot() {
  const r = await api('GET', '/api/snapshot');
  S.snapshot.value = r.snapshot;
  const h = await api('GET', '/api/snapshot/history');
  S.history.value = h.history;
}

export async function loadWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  S.workspaces.value = r.workspaces;
}

export async function refreshAll() {
  await Promise.all([
    loadSessions(), loadRecent(), loadSnapshot(),
    loadWorkspaces(), loadFavorites(), loadLabels(), loadWebTerminals(),
  ]);
  S.lastRefreshAt.value = Date.now();
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
