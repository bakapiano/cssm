// Remote · expose this backend over a public tunnel URL so the same
// frontend can be loaded from a phone / another laptop / wherever.
// All API + WS calls are gated by a token the user sets here; the
// share URL embeds it (?token=…) so the remote browser captures it
// on first arrival and stashes it in localStorage.
//
// Layout mirrors ConfigurePage: .settings-scroll wrapper → Section →
// .config-grid → .field rows with label + content. No bespoke cards.

import { html } from '../html.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { setToast } from '../toast.js';
import { ccsmConfirm, ccsmPrompt } from '../dialog.js';
import { IconCopy, IconRecycle, IconExternal, IconInfo, IconPencil, IconClose } from '../icons.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';

function genToken() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setToast('Copied', 'ok');
  } catch {
    setToast('Copy failed · select + Ctrl+C', 'error');
  }
}

function shareUrl(tunnelUrl, token) {
  if (!tunnelUrl || !token) return '';
  try {
    const u = new URL(tunnelUrl);
    u.searchParams.set('token', token);
    return u.toString();
  } catch { return ''; }
}

function Section({ title, meta, children }) {
  return html`
    <section class="settings-section">
      <header class="settings-section-head">
        <h2 class="settings-section-title">${title}</h2>
        ${meta ? html`<p class="settings-section-meta">${meta}</p>` : null}
      </header>
      <div class="settings-section-body">${children}</div>
    </section>`;
}

function DeviceRow({ d, kind, onApprove, onReject, onRevoke, onRename, onDelete }) {
  const lastSeen = d.lastSeen ? fmtAgo(d.lastSeen) : '—';
  const ipShort = d.ip ? d.ip.split(',')[0].trim() : null;
  return html`
    <div class=${`remote-device is-${kind}`}>
      <div class="remote-device-main">
        <div class="remote-device-label">
          ${d.label || 'Unknown device'}
          ${kind === 'approved' ? html`
            <button class="icon-btn" title="Rename" onClick=${onRename}><${IconPencil} /></button>
          ` : null}
        </div>
        <div class="remote-device-meta">
          ${ipShort ? html`<span class="mono">${ipShort}</span> · ` : null}
          <span>seen ${lastSeen}</span>
          ${d.userAgent ? html` · <span class="remote-device-ua" title=${d.userAgent}>${d.userAgent.slice(0, 60)}${d.userAgent.length > 60 ? '…' : ''}</span>` : null}
        </div>
      </div>
      <div class="remote-device-actions">
        ${kind === 'pending' ? html`
          <button class="action primary small" onClick=${onApprove}>Approve</button>
          <button class="action subtle small" onClick=${onReject}>Reject</button>
        ` : null}
        ${kind === 'approved' ? html`
          <button class="action subtle danger small" onClick=${onRevoke}><${IconClose} /> Revoke</button>
        ` : null}
        ${kind === 'rejected' ? html`
          <button class="action subtle small" onClick=${onApprove}>Re-approve</button>
          <button class="action subtle danger small" onClick=${onDelete}><${IconClose} /> Delete</button>
        ` : null}
      </div>
    </div>`;
}

function ProviderChip({ id, label, selected, onSelect }) {
  return html`
    <label class=${`chip${selected ? ' checked' : ''}`}>
      <input type="radio" name="provider" value=${id} checked=${selected}
             onChange=${() => onSelect(id)} />
      ${label}
    </label>`;
}

function ProviderStatus({ id, info, onInstall, onLogin }) {
  if (!info) return html`<span class="muted">probing…</span>`;
  if (!info.installed) {
    return html`
      <span class="warn">not installed</span>
      <button type="button" class="action subtle small" onClick=${onInstall}>
        Install via winget
      </button>`;
  }
  const tag = id === 'devtunnel'
    ? (info.loggedIn ? html`signed in as <code>${info.user}</code>` : html`<span class="warn">not signed in</span>`)
    : html`anonymous`;
  return html`
    <span>${tag}</span>
    ${info.version ? html` · <span class="mono small-mono">${info.version}</span>` : null}
    ${id === 'devtunnel' && !info.loggedIn ? html`
      <button type="button" class="action subtle small" onClick=${onLogin}>How to sign in</button>
    ` : null}`;
}

export function RemotePage() {
  clockTick.value; // re-tick fmtAgo "last seen" labels
  const [status, setStatus] = useState(null);
  const [provider, setProvider] = useState('cloudflared');
  const [token, setTokenLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceList, setDeviceList] = useState([]);
  const pollRef = useRef(null);

  async function refresh() {
    try {
      const [s, devs] = await Promise.all([
        api('GET', '/api/tunnel/status'),
        api('GET', '/api/devices').catch(() => ({ devices: [] })),
      ]);
      setStatus(s);
      setDeviceList(devs.devices || []);
      setTokenLocal((cur) => cur || s.token || '');
      setProvider((cur) => {
        if (s.running && s.provider) return s.provider;
        if (cur) return cur;
        if (s.providers?.cloudflared?.installed) return 'cloudflared';
        if (s.providers?.devtunnel?.installed) return 'devtunnel';
        return cur || 'cloudflared';
      });
    } catch (e) { setToast(`status load failed · ${e.message}`, 'error'); }
  }

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 2500);
    return () => clearInterval(pollRef.current);
  }, []);

  async function onApproveDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/approve`); refresh(); setToast('Device approved', 'ok'); }
    catch (e) { setToast(`approve failed · ${e.message}`, 'error'); }
  }
  async function onRejectDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/reject`); refresh(); setToast('Device rejected', 'ok'); }
    catch (e) { setToast(`reject failed · ${e.message}`, 'error'); }
  }
  async function onDeleteDevice(d) {
    const ok = await ccsmConfirm(
      `Forget "${d.label || d.id}"? The device disappears from this list. If it ever tries again it'll come back as a fresh pending request.`,
      { title: 'Delete device record', okLabel: 'Delete', danger: true },
    );
    if (!ok) return;
    try { await api('DELETE', `/api/devices/${encodeURIComponent(d.id)}`); refresh(); setToast('Device deleted', 'ok'); }
    catch (e) { setToast(`delete failed · ${e.message}`, 'error'); }
  }
  async function onRevokeDevice(d) {
    const ok = await ccsmConfirm(`Revoke access for "${d.label || d.id}"? Any open tabs lose access immediately.`, {
      title: 'Revoke device', okLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    try { await api('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`); refresh(); setToast('Access revoked', 'ok'); }
    catch (e) { setToast(`revoke failed · ${e.message}`, 'error'); }
  }
  async function onRenameDevice(d) {
    const next = await ccsmPrompt('Rename device', d.label || '', { okLabel: 'Save' });
    if (next === null) return;
    try { await api('PUT', `/api/devices/${encodeURIComponent(d.id)}`, { label: next.trim() }); refresh(); }
    catch (e) { setToast(`rename failed · ${e.message}`, 'error'); }
  }

  async function onStart() {
    if (!token || token.length < 8) {
      setToast('Token must be at least 8 characters', 'error');
      return;
    }
    setBusy(true);
    try {
      const s = await api('POST', '/api/tunnel/start', { provider, token });
      setStatus(s);
      setToast(s.url ? 'Tunnel up' : 'Tunnel starting · URL appearing shortly', 'ok');
    } catch (e) {
      setToast(`start failed · ${e.message}`, 'error');
    } finally { setBusy(false); }
  }
  async function onStop() {
    setBusy(true);
    try {
      const s = await api('POST', '/api/tunnel/stop');
      setStatus(s);
      setToast('Tunnel stopped', 'ok');
    } catch (e) { setToast(`stop failed · ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }
  // Generate is the only path that mutates the token now — local React
  // state and the server's stored token stay in lockstep, so the Share
  // URL preview always embeds a token the server will accept. (The
  // previous design had a separate Save step; users would Generate +
  // copy the URL without saving, then the remote would 401 because
  // its embedded token didn't match what the server still had.)
  async function onGenerateToken() {
    const fresh = genToken();
    setTokenLocal(fresh);
    try {
      const s = await api('POST', '/api/tunnel/token', { token: fresh });
      setStatus(s);
      setToast('New token in effect', 'ok');
    } catch (e) { setToast(`token save failed · ${e.message}`, 'error'); }
  }
  async function onInstall(p) {
    const ok = await ccsmConfirm(`Install ${p} via winget? Runs in the background — refresh after ~30s.`, {
      title: 'Install tunnel provider', okLabel: 'Install',
    });
    if (!ok) return;
    try {
      await api('POST', '/api/tunnel/install', { provider: p });
      setToast(`${p} install running in background · check back in a minute`, 'ok');
    } catch (e) { setToast(`install failed · ${e.message}`, 'error'); }
  }
  function onLogin(p) {
    if (p === 'devtunnel') {
      copy('devtunnel user login');
      setToast('Command copied · paste in a terminal to sign in', 'ok');
    }
  }

  const running = status?.running;
  const url     = status?.url;
  const share   = shareUrl(url, token);
  const log     = status?.log || [];
  const cf      = status?.providers?.cloudflared;
  const dt      = status?.providers?.devtunnel;

  return html`
    <${PageTitleBar} title="Remote" />
    <div class="settings-scroll">

      <${Section}
        title="Connection"
        meta=${html`Pick the tunnel CLI ccsm should spawn. Loopback callers on this machine bypass the token automatically.`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">Provider</span>
            <div class="chip-row">
              <${ProviderChip} id="cloudflared" label="Cloudflare Tunnel"
                selected=${provider === 'cloudflared'} onSelect=${setProvider} />
              <${ProviderChip} id="devtunnel" label="Microsoft Dev Tunnel"
                selected=${provider === 'devtunnel'} onSelect=${setProvider} />
            </div>
          </div>
          <div class="field">
            <span class="label">Cloudflare Tunnel</span>
            <div class="remote-status-line">
              <${ProviderStatus} id="cloudflared" info=${cf}
                onInstall=${() => onInstall('cloudflared')} />
            </div>
          </div>
          <div class="field">
            <span class="label">Microsoft Dev Tunnel</span>
            <div class="remote-status-line">
              <${ProviderStatus} id="devtunnel" info=${dt}
                onInstall=${() => onInstall('devtunnel')}
                onLogin=${() => onLogin('devtunnel')} />
            </div>
          </div>
        </div>
      </${Section}>

      <${Section}
        title="Registration token"
        meta=${html`Embedded in the share URL. Only needed to <em>register</em> a new device for approval — once you approve a device, it keeps working even if you rotate the token.`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">Token</span>
            <div class="remote-token-row">
              <input type="text" class="input remote-token-input"
                     readonly
                     placeholder="click Generate to create a token"
                     value=${token} />
              <button type="button" class="action" title="Generate a new token and save it"
                      onClick=${onGenerateToken}>
                <${IconRecycle} /> Generate
              </button>
              <button type="button" class="action"
                      disabled=${!token}
                      onClick=${() => copy(token)}>
                <${IconCopy} /> Copy
              </button>
            </div>
            <span class="hint">
              ${(!status?.token && !token)
                ? html`<span class="warn">No token set · new devices can't register.</span>`
                : html`Active. Rotating it invalidates outstanding share URLs but doesn't kick out devices you've already approved.`}
            </span>
          </div>
        </div>
      </${Section}>

      <${Section}
        title="Tunnel"
        meta=${running
          ? html`Provider <code>${status?.provider}</code> · started ${new Date(status.startedAt).toLocaleTimeString()}`
          : html`Not running.`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">State</span>
            <div>
              ${!running ? html`
                <button type="button" class="action primary"
                        disabled=${busy || !token || token.length < 8}
                        onClick=${onStart}>
                  Start tunnel
                </button>
              ` : html`
                <button type="button" class="action danger"
                        disabled=${busy}
                        onClick=${onStop}>
                  Stop tunnel
                </button>
              `}
              ${running && !url ? html`<span class="hint inline">Waiting for URL…</span>` : null}
            </div>
          </div>

          ${running && url ? html`
            <div class="field">
              <span class="label">Share URL</span>
              <div class="remote-url-line">
                <code class="remote-url-value">${share}</code>
                <button type="button" class="action" onClick=${() => copy(share)}>
                  <${IconCopy} /> Copy
                </button>
                <a class="action" href=${share} target="_blank" rel="noreferrer noopener">
                  <${IconExternal} /> Open
                </a>
              </div>
              <span class="hint">
                Send this to the remote device · token embedded, stripped from the URL on first arrival.
              </span>
            </div>
          ` : null}

          ${log.length ? html`
            <div class="field">
              <span class="label">CLI log</span>
              <details class="remote-log">
                <summary>${log.length} lines</summary>
                <pre>${log.join('\n')}</pre>
              </details>
            </div>
          ` : null}
        </div>
      </${Section}>

      <${Section}
        title="Devices"
        meta=${html`Browsers that loaded the share URL. Approve once per device — token alone is not enough.`}>
        ${(() => {
          const pending  = deviceList.filter((d) => d.status === 'pending');
          const approved = deviceList.filter((d) => d.status === 'approved');
          const rejected = deviceList.filter((d) => d.status === 'rejected');
          if (!deviceList.length) {
            return html`<p class="remote-empty">No devices yet. Send the share URL to a phone or another laptop to add the first one.</p>`;
          }
          return html`
            <div class="remote-devices">
              ${pending.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Pending approval</span>
                    <span class="remote-devices-group-count">${pending.length}</span>
                  </div>
                  ${pending.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="pending"
                    onApprove=${() => onApproveDevice(d.id)}
                    onReject=${() => onRejectDevice(d.id)} />`)}
                </div>
              ` : null}
              ${approved.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Approved</span>
                    <span class="remote-devices-group-count">${approved.length}</span>
                  </div>
                  ${approved.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="approved"
                    onRename=${() => onRenameDevice(d)}
                    onRevoke=${() => onRevokeDevice(d)} />`)}
                </div>
              ` : null}
              ${rejected.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">Rejected</span>
                    <span class="remote-devices-group-count">${rejected.length}</span>
                    <span class="remote-devices-group-hint">auto-clears 1h after rejection</span>
                  </div>
                  ${rejected.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="rejected"
                    onApprove=${() => onApproveDevice(d.id)}
                    onDelete=${() => onDeleteDevice(d)} />`)}
                </div>
              ` : null}
            </div>`;
        })()}
      </${Section}>

      <${Section} title="How access works" meta="What the token does, what an approved device gets, and how to lock things back down.">
        <dl class="remote-facts">
          <div class="remote-fact">
            <dt>The token is just a knock</dt>
            <dd>
              The share URL embeds the token and the remote browser uses it once — only to register itself in the <strong>Pending</strong> list. After that the URL + token grant nothing on their own. Until you click <strong>Approve</strong>, the visitor's <code>/api/*</code> calls all return 403.
            </dd>
          </div>
          <div class="remote-fact">
            <dt>Approved devices are sticky</dt>
            <dd>
              Once approved, the device's per-browser UUID becomes the credential — every API + WebSocket call rides on that alone. <strong>Rotating the token doesn't kick them out</strong>; that only blocks new arrivals. To lock an existing device out, hit <strong>Revoke</strong> in the Devices list above.
            </dd>
          </div>
          <div class="remote-fact">
            <dt>This machine is exempt</dt>
            <dd>
              Loopback callers (<code>localhost</code>, <code>127.0.0.1</code>) skip both checks — your own browser on this host needs nothing. Tunnel traffic is distinguished by the <code>X-Forwarded-*</code> headers the proxies inject, so it can't masquerade as local.
            </dd>
          </div>
        </dl>
      </${Section}>

    </div>`;
}
