// Shared pagination footer. Hidden when total ≤ limit.
// onChange(nextOffset, nextLimit) is called for both arrow clicks and page-size change.

import { html } from '../html.js';

export function Pagination({ total, offset, limit, onChange }) {
  if (total <= limit) return null;
  const pageNum = Math.floor(offset / limit) + 1;
  const pageTotal = Math.max(1, Math.ceil(total / limit));
  const prev = () => onChange(Math.max(0, offset - limit), limit);
  const next = () => onChange(offset + limit, limit);
  const resize = (e) => onChange(0, Math.max(1, Number(e.target.value) || 10));

  return html`
    <footer class="pagination">
      <button class="action subtle small" disabled=${offset === 0} onClick=${prev}>← Prev</button>
      <span class="pagination-info">
        Page <strong>${pageNum}</strong> of <strong>${pageTotal}</strong> · <span>${total}</span> total
      </span>
      <button class="action subtle small" disabled=${offset + limit >= total} onClick=${next}>Next →</button>
      <select class="input" style="max-width: 100px;" value=${limit} onChange=${resize}>
        <option value="10">10 / page</option>
        <option value="20">20 / page</option>
        <option value="50">50 / page</option>
      </select>
    </footer>`;
}
