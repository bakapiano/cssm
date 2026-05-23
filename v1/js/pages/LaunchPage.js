import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { capabilities, activeTerminalId, selectTab, config } from '../state.js';
import { api, loadWorkspaces, loadWebTerminals } from '../api.js';
import { setToast } from '../toast.js';
import { streamNewSession, resetProgress } from '../streaming.js';
import { Card } from '../components/Card.js';
import { RepoPicker } from '../components/RepoPicker.js';
import { ReposEditor, addEmptyRepo } from '../components/ReposEditor.js';
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
  const [reposSavedAt, setReposSavedAt] = useState('');
  const repos = config.value?.repos || [];
  const hasRepos = repos.length > 0;
  // Always follow the global Configure → "Default mode" setting. The
  // per-launch picker was removed; users who want a one-off override
  // change the global setting first. This keeps "new" / "resume" /
  // "continue" / "finder" all consistent.
  const cfgDefault = config.value?.defaultTerminalMode || 'wt';
  const terminal = capabilities.value.webTerminal ? cfgDefault : 'wt';

  const onSaveRepos = async () => {
    try {
      const cfg = await api('PUT', '/api/config', config.value);
      config.value = cfg;
      setReposSavedAt(`saved · ${new Date().toLocaleTimeString(undefined, { hour12: false })}`);
      setToast('repos saved');
    } catch (e) { setToast(e.message, 'error'); }
  };

  const onLaunch = async () => {
    const repos = [...inlineSelected.value];
    // Allow zero-repo launches: workspace is created empty, claude opens there.
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
        ${hasRepos
          ? html`<${RepoPicker} selectedSig=${inlineSelected} />`
          : html`<span class="muted-text">no repos configured · add one below, or launch with no repos for an empty workspace</span>`}
      </div>
      <details class="repos-inline-config" open=${!hasRepos}>
        <summary>Manage repos</summary>
        <div class="repos-inline-body">
          <${ReposEditor} />
          <div class="repos-inline-actions">
            <button class="action small" onClick=${() => addEmptyRepo()}>+ Add repo</button>
            <button class="action small primary" onClick=${onSaveRepos}>Save changes</button>
            <span class="muted-text">${reposSavedAt}</span>
          </div>
        </div>
      </details>
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
