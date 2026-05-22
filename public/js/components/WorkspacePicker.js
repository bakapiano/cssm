// "auto" + each free workspace. In-use ones are filtered out (matches
// behaviour in the original app.js).

import { html } from '../html.js';
import { workspaces } from '../state.js';

export function WorkspacePicker({ value, onChange }) {
  const free = workspaces.value.filter((w) => !w.inUse);
  return html`
    <select class="input narrow" value=${value} onChange=${(e) => onChange(e.target.value)}>
      <option value="">auto — find or create unused</option>
      ${free.map((w) => html`<option key=${w.name} value=${w.name}>${w.name}</option>`)}
    </select>`;
}
