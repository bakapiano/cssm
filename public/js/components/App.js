import { html } from '../html.js';
import { activeTab } from '../state.js';
import { Sidebar } from './Sidebar.js';
import { PageHead } from './PageHead.js';
import { Footer } from './Footer.js';
import { Toast } from './Toast.js';
import { Fab } from './Fab.js';
import { NewSessionModal } from './NewSessionModal.js';
import { DialogHost } from './DialogHost.js';
import { SessionsPage } from '../pages/SessionsPage.js';
import { LaunchPage } from '../pages/LaunchPage.js';
import { ConfigurePage } from '../pages/ConfigurePage.js';
import { AboutPage } from '../pages/AboutPage.js';

function Panel({ name, children }) {
  const active = activeTab.value === name;
  return html`<section class="tab-panel" data-panel=${name} data-active=${active || null}>${children}</section>`;
}

export function App() {
  const tab = activeTab.value;

  return html`
    <div class="app">
      <${Sidebar} />
      <main class="main">
        <${PageHead} />
        <div class="content">
          ${tab === 'sessions'  ? html`<${Panel} name="sessions"><${SessionsPage}   /></${Panel}>` : null}
          ${tab === 'launch'    ? html`<${Panel} name="launch"><${LaunchPage}     /></${Panel}>` : null}
          ${tab === 'configure' ? html`<${Panel} name="configure"><${ConfigurePage} /></${Panel}>` : null}
          ${tab === 'about'     ? html`<${Panel} name="about"><${AboutPage}     /></${Panel}>` : null}
        </div>
        <${Footer} />
      </main>
      <${Fab} />
      <${NewSessionModal} />
      <${Toast} />
      <${DialogHost} />
    </div>`;
}
