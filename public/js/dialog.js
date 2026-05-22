// Promise-based confirm/prompt rendered through DialogHost. The stack
// signal lets us nest dialogs if ever needed; .close() pops by id.

import { signal } from '@preact/signals';
import { html } from './html.js';

export const dialogs = signal([]);
let nextId = 1;

function push(entry) {
  return new Promise((resolve) => {
    const id = nextId++;
    const close = (action, host) => {
      dialogs.value = dialogs.value.filter((d) => d.id !== id);
      resolve(entry.onResolve(action, host));
    };
    dialogs.value = [...dialogs.value, { id, ...entry, close }];
  });
}

export function ccsmConfirm(message, opts = {}) {
  const { title = 'Confirm', okLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = opts;
  return push({
    render: () => html`<div class="modal modal-dialog">
      <header class="modal-head"><h2>${title}</h2></header>
      <div class="modal-body"><p class="dialog-msg">${message}</p></div>
      <footer class="modal-foot">
        <button class="action" data-action="cancel">${cancelLabel}</button>
        <button class=${`action ${danger ? 'danger' : 'primary'}`} data-action="ok">${okLabel}</button>
      </footer>
    </div>`,
    onResolve: (action) => action === 'ok' || action === 'enter',
  });
}

export function ccsmPrompt(message, defaultValue = '', opts = {}) {
  const { title, okLabel = 'Save', cancelLabel = 'Cancel', placeholder = '' } = opts;
  return push({
    render: () => html`<div class="modal modal-dialog">
      <header class="modal-head"><h2>${title || message}</h2></header>
      <div class="modal-body">
        ${title ? html`<p class="dialog-msg">${message}</p>` : null}
        <input type="text" class="input" placeholder=${placeholder} value=${defaultValue} />
      </div>
      <footer class="modal-foot">
        <button class="action" data-action="cancel">${cancelLabel}</button>
        <button class="action primary" data-action="ok">${okLabel}</button>
      </footer>
    </div>`,
    initialFocus: (host) => {
      const inp = host.querySelector('input');
      if (inp) { inp.focus(); inp.select(); }
    },
    onResolve: (action, host) => {
      const inp = host?.querySelector('input');
      return (action === 'ok' || action === 'enter') ? (inp?.value ?? '') : null;
    },
  });
}
