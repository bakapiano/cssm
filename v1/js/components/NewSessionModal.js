// FAB-triggered launch modal. Shares ReposEditor + RepoPicker with the
// inline Launch tab form, but maintains its own selected-repos + workspace
// state so the two don't clobber each other.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { modalOpen, config, capabilities, activeTerminalId, selectTab } from '../state.js';
import { api, loadWorkspaces, loadWebTerminals } from '../api.js';
import { setToast } from '../toast.js';
import { streamNewSession, resetProgress } from '../streaming.js';
import { IconClose } from '../icons.js';
import { RepoPicker } from './RepoPicker.js';
import { WorkspacePicker } from './WorkspacePicker.js';
import { ProgressList } from './ProgressList.js';
import { ReposEditor, addEmptyRepo } from './ReposEditor.js';

const ROOT_ID = 'modalProgress';
const modalSelected = signal(new Set());

// Top-level mounts ModalBody only when open. Keeping hooks inside ModalBody
// means hook count is stable across its lifetime (was previously being
// declared after a conditional return, which fights Preact's hook contract
// and makes opening feel laggy).
export function NewSessionModal() {
  return modalOpen.value ? html`<${ModalBody} />` : null;
}

function ModalBody() {
  const [workspace, setWorkspace] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [reposSavedAt, setReposSavedAt] = useState('');

  const close = () => {
    setResult('');
    setBusy(false);
    modalOpen.value = false;
  };

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  const onLaunch = async () => {
    const repos = [...modalSelected.value];
    setBusy(true);
    setResult('');
    resetProgress(repos, ROOT_ID);
    const wantWeb = capabilities.value?.webTerminal
      && (config.value?.defaultTerminalMode || 'wt') === 'web';
    const terminal = wantWeb ? 'web' : 'wt';
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
              if (l.mode === 'web') setResult(`web terminal launched · pid ${l.pid} · id ${l.id}`);
              else setResult(`terminal launching · pid ${l.pid} · ${l.terminal}`);
            }
          },
        },
      );
      if (final.success) {
        const summary = (final.cloneResults || []).map((c) => `${c.repo}: ${c.action || c.error}`).join(' · ');
        setResult(`launched in ${final.workspace.path}${final.created ? ' · newly created' : ''}${summary ? ' — ' + summary : ''}`);
        setToast(`launched · ${final.workspace.name}`);
        if (terminal === 'web' && final.launched?.id) {
          activeTerminalId.value = final.launched.id;
          await loadWebTerminals();
          selectTab('terminals');
          modalOpen.value = false;
        } else {
          setTimeout(close, 1500);
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

  const onSaveRepos = async () => {
    try {
      const cfg = await api('PUT', '/api/config', config.value);
      config.value = cfg;
      setReposSavedAt(`saved · ${new Date().toLocaleTimeString(undefined, { hour12: false })}`);
      setToast('repos saved');
    } catch (e) { setToast(e.message, 'error'); }
  };

  const onBackdropClick = (ev) => { if (ev.currentTarget === ev.target) close(); };

  return html`
    <div class="modal-backdrop" role="dialog" aria-modal="true" onClick=${onBackdropClick}>
      <div class="modal">
        <header class="modal-head">
          <h2>Launch new session</h2>
          <button class="modal-close" aria-label="close" onClick=${close}><${IconClose} /></button>
        </header>
        <div class="modal-body">
          <p class="modal-hint">Pick an unused workspace, clone any missing repos, open <code>claude</code> in a fresh terminal.</p>

          <div class="form-row">
            <span class="form-label">Repos</span>
            <${RepoPicker} selectedSig=${modalSelected} />
          </div>

          <details class="repos-inline-config">
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
          </div>

          <${ProgressList} rootId=${ROOT_ID} />
          <div class="post-result">${result}</div>
        </div>
        <footer class="modal-foot">
          <button class="action" onClick=${close}>Cancel</button>
          <button class="action primary" disabled=${busy} onClick=${onLaunch}>Launch new session</button>
        </footer>
      </div>
    </div>`;
}
