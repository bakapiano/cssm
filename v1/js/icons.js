// SVG icon components. Each accepts {size, className} but most callers
// just take the default — sizing happens via CSS.

import { html } from './html.js';

const ic = (vb, body, defaultSize = 16) => ({ size = defaultSize, className = '', stroke = 1.6, fill = 'none' } = {}) =>
  html`<svg viewBox=${vb} width=${size} height=${size} fill=${fill} stroke="currentColor"
            stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" class=${className} aria-hidden="true">${body}</svg>`;

export const IconSessions = ic('0 0 24 24', html`
  <line x1="3" y1="6" x2="21" y2="6"/>
  <line x1="3" y1="12" x2="21" y2="12"/>
  <line x1="3" y1="18" x2="14" y2="18"/>
`, 18);

export const IconLaunch = ic('0 0 24 24', html`
  <path d="M7 17L17 7"/><path d="M9 7h8v8"/>
`, 18);

export const IconConfigure = ic('0 0 24 24', html`
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
`, 18);

export const IconRefresh = ic('0 0 24 24', html`
  <polyline points="23 4 23 10 17 10"/>
  <polyline points="1 20 1 14 7 14"/>
  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
`, 16);

export const IconChevronLeft = ic('0 0 24 24', html`<polyline points="15 18 9 12 15 6"/>`, 14);
export const IconChevronDown = ic('0 0 24 24', html`<polyline points="6 9 12 15 18 9"/>`, 14);

export const IconSearch = ic('0 0 24 24', html`
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
`, 14);

export const IconClose = ic('0 0 24 24', html`
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
`, 18);

export const IconPlus = ic('0 0 24 24', html`
  <line x1="12" y1="5" x2="12" y2="19"/>
  <line x1="5" y1="12" x2="19" y2="12"/>
`, 22);

export const IconPencil = ic('0 0 24 24', html`
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
`, 13);

export const IconInfo = ic('0 0 24 24', html`
  <circle cx="12" cy="12" r="10"/>
  <line x1="12" y1="16" x2="12" y2="12"/>
  <line x1="12" y1="8" x2="12.01" y2="8"/>
`, 18);

export const IconGithub = ic('0 0 24 24', html`
  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
`, 16);

export const IconExternal = ic('0 0 24 24', html`
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  <polyline points="15 3 21 3 21 9"/>
  <line x1="10" y1="14" x2="21" y2="3"/>
`, 13);

// Monitor outline — used on "Focus" buttons since the action raises an
// existing terminal window. Reads as "go to that window".
export const IconMonitor = ic('0 0 24 24', html`
  <rect x="3" y="4" width="18" height="12" rx="2" ry="2"/>
  <line x1="8" y1="20" x2="16" y2="20"/>
  <line x1="12" y1="16" x2="12" y2="20"/>
`, 13);

// "> _" terminal prompt — for the Terminals nav tab
export const IconTerminal = ic('0 0 24 24', html`
  <polyline points="4 17 10 11 4 5"/>
  <line x1="12" y1="19" x2="20" y2="19"/>
`, 18);

// Two variants used in the StarButton.
export const StarOutline = ({ size = 15 } = {}) => html`
  <svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

export const StarFilled = ({ size = 15 } = {}) => html`
  <svg viewBox="0 0 24 24" width=${size} height=${size} fill="currentColor" stroke="currentColor"
       stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

// Used as the favorites card title decoration
export const StarSmallFilled = ({ size = 14 } = {}) => html`
  <svg class="title-icon title-icon-after" viewBox="0 0 24 24" width=${size} height=${size} fill="currentColor" stroke="none" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>`;

// brand mark (terminal window + ccsm text — matches /favicon.svg)
export const BrandMark = () => html`
  <svg viewBox="0 0 32 32" width="32" height="32">
    <rect x="2" y="4" width="28" height="24" rx="3" fill="#1a1815"/>
    <line x1="2" y1="10" x2="30" y2="10" stroke="#faf9f5" stroke-width="0.6" opacity="0.45"/>
    <circle cx="6"   cy="7" r="1" fill="#faf9f5"/>
    <circle cx="9.5" cy="7" r="1" fill="#faf9f5" opacity="0.65"/>
    <circle cx="13"  cy="7" r="1" fill="#faf9f5" opacity="0.4"/>
    <text x="16" y="19.5" text-anchor="middle" dominant-baseline="central"
          font-family="'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace"
          font-weight="700" font-size="10" fill="#faf9f5">ccsm</text>
  </svg>`;
