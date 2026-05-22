import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { loadWorkspaces } from '../api.js';
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
        { repos, workspace: workspace || undefined },
        {
          progressRootId: ROOT_ID,
          onMeta: (ev) => {
            if (ev.type === 'workspace') {
              setResult(`workspace: ${ev.workspace.path}${ev.created ? ' · newly created' : ''}`);
            } else if (ev.type === 'launched') {
              setResult(`terminal launching · pid ${ev.launched.pid} · ${ev.launched.terminal}`);
            }
          },
        },
      );
      if (final.success) {
        const summary = (final.cloneResults || []).map((c) => `${c.repo}: ${c.action || c.error}`).join(' · ');
        setResult(`launched in ${final.workspace.path}${final.created ? ' · newly created' : ''} — ${summary}`);
        setToast(`launched · ${final.workspace.name}`);
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
