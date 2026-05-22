import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { capabilities, activeTerminalId, selectTab } from '../state.js';
import { loadWorkspaces, loadWebTerminals } from '../api.js';
import { setToast } from '../toast.js';
import { streamNewSession, resetProgress } from '../streaming.js';
import { Card } from '../components/Card.js';
import { RepoPicker } from '../components/RepoPicker.js';
import { WorkspacePicker } from '../components/WorkspacePicker.js';
import { ProgressList } from '../components/ProgressList.js';
import { WorkspacesGrid, WorkspacesHeader } from '../components/WorkspacesGrid.js';
import { SnapshotPanel, SnapshotMeta } from '../components/SnapshotPanel.js';

const ROOT_ID = 'newSessionProgress';
const inlineSelected = signal(new Set());

function NewSessionCard() {
  const [workspace, setWorkspace] = useState('');
  // 'web' = run inside this page (in-process PTY · bridges to xterm.js)
  // 'wt'  = open a new Windows Terminal window
  const initialMode = capabilities.value.webTerminal ? 'web' : 'wt';
  const [terminal, setTerminal] = useState(initialMode);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  const onLaunch = async () => {
    const repos = [...inlineSelected.value];
    if (repos.length === 0) return setToast('select at least one repo', 'error');
    setBusy(true);
    setResult('');
    resetProgress(repos, ROOT_ID);
    try {
      const final = await streamNewSession(
        { repos, workspace: workspace || undefined, terminal },
        {
          progressRootId: ROOT_ID,
          onMeta: (ev) => {
            if (ev.type === 'workspace') {
              setResult(`workspace: ${ev.workspace.path}${ev.created ? ' · newly created' : ''}`);
            } else if (ev.type === 'launched') {
              const l = ev.launched || {};
              if (l.mode === 'web') {
                setResult(`web terminal launched · pid ${l.pid} · id ${l.id}`);
              } else {
                setResult(`terminal launching · pid ${l.pid} · ${l.terminal}`);
              }
            }
          },
        },
      );
      if (final.success) {
        const summary = (final.cloneResults || []).map((c) => `${c.repo}: ${c.action || c.error}`).join(' · ');
        setResult(`launched in ${final.workspace.path}${final.created ? ' · newly created' : ''} — ${summary}`);
        setToast(`launched · ${final.workspace.name}`);
        // For web mode, hop to the Terminals tab and open the new session.
        if (terminal === 'web' && final.launched?.id) {
          activeTerminalId.value = final.launched.id;
          await loadWebTerminals();
          selectTab('terminals');
        }
      } else {
        setResult(`error: ${final.error}`);
        setToast(final.error || 'new session failed', 'error');
      }
      await loadWorkspaces();
    } catch (e) {
      setResult(`error: ${e.message}`);
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${Card} title="New session"
             meta=${html`Picks an unused workspace, clones missing repos, opens <code>claude</code> in a fresh terminal.`}>
      <div class="form-row">
        <span class="form-label">Repos</span>
        <${RepoPicker} selectedSig=${inlineSelected} />
      </div>
      ${capabilities.value.webTerminal ? html`
        <div class="form-row">
          <span class="form-label">Open in</span>
          <div class="radio-row">
            <label class=${`radio${terminal === 'web' ? ' is-checked' : ''}`}>
              <input type="radio" name="terminal" value="web"
                     checked=${terminal === 'web'} onChange=${() => setTerminal('web')} />
              this page
            </label>
            <label class=${`radio${terminal === 'wt' ? ' is-checked' : ''}`}>
              <input type="radio" name="terminal" value="wt"
                     checked=${terminal === 'wt'} onChange=${() => setTerminal('wt')} />
              wt window
            </label>
          </div>
        </div>` : null}
      <div class="form-row">
        <label class="form-label">Workspace</label>
        <${WorkspacePicker} value=${workspace} onChange=${setWorkspace} />
        <button class="action primary" disabled=${busy} onClick=${onLaunch}>Launch new session</button>
      </div>
      <${ProgressList} rootId=${ROOT_ID} />
      <div class="post-result">${result}</div>
    </${Card}>`;
}

export function LaunchPage() {
  return html`
    <${NewSessionCard} />
    <${Card} title="Snapshot & restore" meta=${html`<${SnapshotMeta} />`}>
      <${SnapshotPanel} />
    </${Card}>
    <${Card} title="Workspaces on disk" meta=${html`<${WorkspacesHeader} />`}>
      <${WorkspacesGrid} />
    </${Card}>`;
}
