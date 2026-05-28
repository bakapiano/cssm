// Phone-only navigation affordance.
//
// On viewports ≤ 640px the sidebar is hidden via CSS (.is-mobile body
// class). Instead, a circular floating button sits bottom-left; tapping
// it sets mobileDrawerOpen, which the sidebar reads to flip into a
// full-screen overlay. A backdrop captures taps outside the sidebar
// and dismisses.
//
// Visible only when isMobile signal is true — saves a render branch
// elsewhere.

import { html } from '../html.js';
import { isMobile, mobileDrawerOpen } from '../state.js';
import { IconSidebarToggle, IconClose } from '../icons.js';

export function MobileNavFab() {
  if (!isMobile.value) return null;
  const open = mobileDrawerOpen.value;
  return html`
    ${open ? html`
      <div class="mobile-nav-backdrop"
           onClick=${() => { mobileDrawerOpen.value = false; }} />
    ` : null}
    <button class=${`mobile-nav-fab${open ? ' is-open' : ''}`}
            aria-label=${open ? 'close navigation' : 'open navigation'}
            onClick=${() => { mobileDrawerOpen.value = !open; }}>
      ${open ? html`<${IconClose} />` : html`<${IconSidebarToggle} />`}
    </button>`;
}
