// Sessions page · the main pane. Shows the terminal for the currently
// selected session (activeSessionId), with a thin header providing
// session metadata + rename/delete actions. When a session is selected
// but not running we auto-resume it — no manual button.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { activeSessionId, sessions, config, selectTab, selectSession, clockTick } from '../state.js';
import { resumeSession, deleteSession, setSessionTitle } from '../api.js';
import { setToast } from '../toast.js';
import { ccsmConfirm, ccsmPrompt } from '../dialog.js';
import { TerminalView } from '../components/TerminalView.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { IconPencil, IconClose } from '../icons.js';
import { fmtAgo } from '../util.js';

export function SessionsPage() {
  clockTick.value; // resubscribe fmtAgo
  const id = activeSessionId.value;
  const list = sessions.value;
  const session = id ? list.find((s) => s.id === id) : null;
  const [resumeError, setResumeError] = useState(null);
  // Bumps to force the auto-resume effect to re-run on Retry without
  // mutating any signal. Primitive in the dep array → identity changes.
  const [retryNonce, setRetryNonce] = useState(0);

  // No session selected → bounce to the Launch page. Done in an effect so
  // we don't mutate signals during render. Returning null while the bounce
  // is in flight avoids a flash of empty content.
  useEffect(() => {
    if (!session) selectTab('launch');
  }, [session]);

  // Auto-resume when the active session is exited. resumeSession() in
  // api.js dedups in-flight calls per session id, so simultaneous fires
  // from here and from Sidebar.onClick collapse into one request.
  useEffect(() => {
    if (!session) return;
    if (session.status === 'running') { setResumeError(null); return; }
    setResumeError(null);
    resumeSession(session.id)
      .then((launched) => { if (launched?.id) selectSession(launched.id); })
      .catch((e) => { setResumeError(e.message); setToast(e.message, 'error'); });
  }, [session?.id, session?.status, retryNonce]);

  if (!session) return null;

  const cli = (config.value?.clis || []).find((c) => c.id === session.cliId);
  const running = session.status === 'running';
  const title = session.title || session.workspace || session.id.slice(0, 12);

  const onRename = async () => {
    const next = await ccsmPrompt('Rename session', title, { okLabel: 'Save' });
    if (next === null) return;
    try { await setSessionTitle(session.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };
  const onDelete = async () => {
    const ok = await ccsmConfirm(`Delete session ${title}? PTY will be killed if alive.`, {
      title: 'Delete session', okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deleteSession(session.id);
      activeSessionId.value = null;
    } catch (e) { setToast(e.message, 'error'); }
  };
  const onRetry = () => setRetryNonce((n) => n + 1);

  return html`
    <${PageTitleBar} title=${html`
        <span class="session-title-text">${title}</span>
        <span class="session-title-meta">
          <span class="mono">${session.cwd}</span>
          <span>·</span>
          <span>${cli ? cli.name : session.cliId}</span>
          ${session.repos.length ? html`<span>·</span><span>${session.repos.join(', ')}</span>` : null}
          <span>·</span>
          <span>${running ? 'running' : (resumeError ? 'resume failed' : 'resuming…')}</span>
        </span>
      `}>
    </${PageTitleBar}>
    <div class="session-pane">
      <div class="session-pane-body">
        ${running
          ? html`<${TerminalView} terminalId=${session.id} />`
          : html`
            <div class="terminal-empty">
              ${resumeError ? html`
                <div>Failed to resume: <span class="mono">${resumeError}</span></div>
                <button class="action primary" onClick=${onRetry}>Retry</button>
              ` : html`
                <div>Resuming session…</div>
              `}
            </div>`}
      </div>
    </div>`;
}
