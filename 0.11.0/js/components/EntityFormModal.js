// Generic create/edit form rendered inside a Modal. Field shape mirrors
// the createFields prop used by Picker.js so the same field-definition
// objects power both the inline-create-in-popover flow and the standalone
// edit flow used from Configure.
//
// Usage:
//   <${EntityFormModal}
//     title="Edit CLI"
//     fields=${cliFields}
//     initial=${currentValues}
//     onSubmit=${async (values) => { ... }}
//     onClose=${close} />

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { Modal } from './Modal.js';

export function EntityFormModal({
  title, fields, initial = {}, submitLabel = 'Save',
  readOnlyKeys = [],
  onSubmit, onClose, danger,
}) {
  const [draft, setDraft] = useState(() => ({ ...initialFrom(fields), ...initial }));
  const [saving, setSaving] = useState(false);

  const isReadOnly = (key) => readOnlyKeys.includes(key);

  const submit = async (ev) => {
    ev?.preventDefault?.();
    for (const f of fields) {
      if (f.required && !String(draft[f.key] || '').trim()) return;
    }
    setSaving(true);
    try { await onSubmit?.(draft); onClose?.(); }
    catch { /* caller toasts; stay open */ }
    finally { setSaving(false); }
  };

  return html`
    <${Modal} title=${title} onClose=${onClose} width=${440}>
      <form class="entity-form" onSubmit=${submit}>
        ${fields.map((f) => html`
          <label class="entity-field" key=${f.key}>
            <span class="entity-field-label">${f.label}</span>
            ${f.type === 'select' ? html`
              <select class="input" value=${draft[f.key] || ''}
                      disabled=${isReadOnly(f.key)}
                      onChange=${(e) => {
                        const next = { ...draft, [f.key]: e.target.value };
                        const sideEffects = f.onChange?.(e.target.value, next);
                        setDraft(sideEffects ? { ...next, ...sideEffects } : next);
                      }}>
                ${(f.options || []).map((opt) => html`
                  <option value=${opt.value}>${opt.label}</option>`)}
              </select>
            ` : f.type === 'iconRadio' ? html`
              <div class=${`icon-radio${isReadOnly(f.key) ? ' is-disabled' : ''}`}>
                ${(f.options || []).map((opt) => html`
                  <button type="button" key=${opt.value}
                          class=${`icon-radio-opt${draft[f.key] === opt.value ? ' is-active' : ''}`}
                          disabled=${isReadOnly(f.key)}
                          onClick=${() => {
                            if (isReadOnly(f.key)) return;
                            const next = { ...draft, [f.key]: opt.value };
                            const sideEffects = f.onChange?.(opt.value, next);
                            setDraft(sideEffects ? { ...next, ...sideEffects } : next);
                          }}>
                    ${opt.icon ? html`<span class="icon-radio-icon">${opt.icon}</span>` : null}
                    <span>${opt.label}</span>
                  </button>`)}
              </div>
            ` : f.type === 'checkbox' ? html`
              <span class="entity-checkbox-row">
                <input type="checkbox" checked=${!!draft[f.key]}
                       disabled=${isReadOnly(f.key)}
                       onChange=${(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
                ${f.hint ? html`<span class="entity-field-hint">${f.hint}</span>` : null}
              </span>
            ` : html`
              <input type=${f.type || 'text'}
                     class=${`input${f.mono ? ' mono' : ''}`}
                     placeholder=${f.placeholder || ''}
                     value=${draft[f.key] || ''}
                     readonly=${isReadOnly(f.key)}
                     onInput=${(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                     autoFocus=${f.autoFocus && !isReadOnly(f.key)} />`}
            ${f.hint && f.type !== 'checkbox' ? html`
              <span class="entity-field-hint">${f.hint}</span>` : null}
          </label>`)}
        <div class="entity-form-actions">
          <button type="button" class="action small subtle" onClick=${onClose}>Cancel</button>
          <button type="submit" class=${`action small ${danger ? 'danger' : 'primary'}`}
                  disabled=${saving}>
            ${saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </${Modal}>`;
}

function initialFrom(fields) {
  const out = {};
  for (const f of fields) out[f.key] = f.default ?? '';
  return out;
}
