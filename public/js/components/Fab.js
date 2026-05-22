import { html } from '../html.js';
import { modalOpen } from '../state.js';
import { IconPlus } from '../icons.js';

export function Fab() {
  return html`
    <button class="fab" title="Launch new session" aria-label="Launch new session"
            onClick=${() => (modalOpen.value = true)}>
      <${IconPlus} />
    </button>`;
}
