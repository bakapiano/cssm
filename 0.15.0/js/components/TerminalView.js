// xterm.js wrapper. Mounts a terminal into a ref'd div, opens a WebSocket
// to /ws/terminal/<id>, forwards keystrokes/resize as JSON frames, renders
// output frames into xterm. Disposes everything on unmount or id change.

import { html } from '../html.js';
import { useEffect, useRef } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { wsBase } from '../backend.js';

// Dark xterm theme. We give the terminal a near-black ink background to
// match what claude code's TUI assumes (it paints its own input box +
// prompt with hardcoded dark backgrounds — a light terminal makes those
// regions look like black blocks). Cursor uses the favorite-star gold so
// it pops against the ink without dragging brand orange back in.
const THEME = {
  background: '#1a1815',
  foreground: '#e8e3d5',
  cursor:     '#e3b341',
  cursorAccent: '#1a1815',
  selectionBackground: '#3a3530',
  black:   '#1a1815', brightBlack:   '#534e44',
  red:     '#e07b6e', brightRed:     '#f0a098',
  green:   '#7fb670', brightGreen:   '#a0d28f',
  yellow:  '#e3b341', brightYellow:  '#f0c860',
  blue:    '#7d9fc4', brightBlue:    '#9bb8d8',
  magenta: '#c08fd0', brightMagenta: '#d8aae2',
  cyan:    '#6fb0b0', brightCyan:    '#90c8c8',
  white:   '#e8e3d5', brightWhite:   '#faf9f5',
};

export function TerminalView({ terminalId }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!terminalId || !hostRef.current) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Geist Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
      // Modern keyboard protocols. Without these, xterm.js encodes
      // Shift+Enter, Ctrl+Enter, Ctrl+Shift+key etc. the same as their
      // unmodified versions (e.g. both Enter and Shift+Enter send \r),
      // so TUIs like claude code can't tell them apart.
      //
      // - kittyKeyboard: opt-in protocol that apps enable per-session;
      //   xterm emits CSI u sequences that uniquely encode every modifier
      //   combo. Claude / vim / fish recognise it.
      // - win32InputMode: ConPTY-specific protocol that surfaces raw
      //   Win32 KEY_EVENT_RECORD to the child process, again preserving
      //   modifier info. Required for full key fidelity on Windows.
      // (Same set VSCode enables — see vscode/src/.../xtermTerminal.ts)
      vtExtensions: {
        kittyKeyboard: true,
        win32InputMode: true,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // OSC 52 clipboard integration. Lets TUI apps initiate clipboard reads/
    // writes via escape sequences (e.g. `tmux set-buffer` or claude code
    // saying "copied to clipboard"). Does NOT handle the browser-side
    // Ctrl+V — that's still our document-level paste handler below.
    term.loadAddon(new ClipboardAddon());
    // WebGL renderer for performance. The default DOM renderer struggles
    // when claude code produces dense color output (its diff panels,
    // syntax-highlighted code). WebGL paints onto a canvas, much smoother
    // at thousands-of-cells per frame. Falls back to DOM if WebGL is
    // unavailable (e.g. older GPU, hardware accel disabled).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      term.loadAddon(webgl);
    } catch (e) {
      console.warn('[ccsm] WebGL addon failed, using DOM renderer:', e);
    }
    // Ctrl+C with a selection: by default xterm.js sends \x03 AND the
    // browser's own copy event fires — so the user gets "selection
    // copied to clipboard" AND the running CLI gets SIGINT. Mirror
    // VSCode/Windows Terminal behaviour: when there's a selection,
    // suppress \x03 and let the copy event do its thing. With no
    // selection, Ctrl+C still sends \x03 normally.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown'
          && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey
          && ev.key.toLowerCase() === 'c'
          && term.hasSelection()) {
        return false;
      }
      return true;
    });

    const host = hostRef.current;
    term.open(host);
    // Defer fit one tick so the container has measured layout
    requestAnimationFrame(() => { try { fit.fit(); } catch {} });
    termRef.current = term;

    const ws = new WebSocket(`${wsBase()}/ws/terminal/${encodeURIComponent(terminalId)}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      // tell server the initial size (cols/rows after fit)
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'output') {
        term.write(frame.data);
      } else if (frame.type === 'exit') {
        term.write(`\r\n\x1b[2m[process exited · code ${frame.code}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
    };

    const onData = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    };
    const onResize = ({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    };
    term.onData(onData);
    term.onResize(onResize);

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(hostRef.current);

    // Tab-switch refresh. The terminal lives inside a .tab-panel which gets
    // display:none when another tab is active. WebGL renderers keep a glyph
    // texture atlas in GPU memory; when the canvas hides + redisplays at a
    // potentially different devicePixelRatio, the atlas isn't invalidated
    // and old glyphs blend with newly-rasterized ones — visible as scrolling
    // text ghosting / double-strikes. Watching the tab-panel's data-active
    // attribute and clearing the atlas + re-fitting + forcing a full
    // refresh wipes the cache cleanly.
    const panel = host.closest('.tab-panel');
    let panelMo = null;
    if (panel) {
      panelMo = new MutationObserver(() => {
        if (panel.hasAttribute('data-active')) {
          requestAnimationFrame(() => {
            try { term.clearTextureAtlas?.(); } catch {}
            try { fit.fit(); } catch {}
            try { term.refresh(0, term.rows - 1); } catch {}
          });
        }
      });
      panelMo.observe(panel, { attributes: true, attributeFilter: ['data-active'] });
    }

    // give focus to terminal so user can type immediately
    term.focus();

    // Explicit paste handler. xterm.js relies on the browser routing paste
    // events to its hidden .xterm-helper-textarea, which only works if that
    // textarea has focus at the moment of Ctrl+V. When the user clicks
    // elsewhere then hits Ctrl+V over the terminal, or pastes via the
    // right-click menu on the host div, the event lands on the host and
    // xterm never sees it. Catch it here and route through term.paste()
    // so xterm wraps the text in bracketed-paste markers when the app
    // (claude code) has DECSET 2004 enabled — that's what makes claude
    // show the "[Pasted text]" affordance instead of treating it as
    // typed input.
    const isOurs = () => {
      const ae = document.activeElement;
      return ae && host.contains(ae);
    };
    const doPaste = (text) => {
      if (!text) return;
      if (ws.readyState !== 1) return;
      // Normalize line endings to \r (CR / Enter). This mirrors VSCode's
      // terminal sendText path (terminalInstance.ts ~L1385):
      //   text = text.replace(/\r?\n/g, '\r');
      // Bracketed-paste markers protect each \r from being interpreted
      // as a submit by the host app — claude / pwsh / vim all treat
      // bracketed contents as opaque payload regardless of what's inside.
      // Use \n instead and you trip apps that look for "real" line breaks.
      const normalized = text.replace(/\r?\n/g, '\r');
      // Wrap in bracketed-paste markers. Claude Code enables DECSET 2004
      // on startup, so the markers let it detect a paste and render
      // "[Pasted text]". If the host app doesn't have bracketed paste on,
      // it just sees two ignored escape sequences plus the text.
      const wrapped = `\x1b[200~${normalized}\x1b[201~`;
      ws.send(JSON.stringify({ type: 'input', data: wrapped }));
    };
    const onPaste = async (ev) => {
      if (!isOurs()) return;
      let text = '';
      if (ev.clipboardData) text = ev.clipboardData.getData('text');
      if (!text && navigator.clipboard) {
        try { text = await navigator.clipboard.readText(); } catch {}
      }
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      doPaste(text);
    };
    document.addEventListener('paste', onPaste, true);

    // Ctrl/Cmd+V fallback for cases the paste event is suppressed (some
    // extensions, or when our IME workaround moved the helper textarea
    // off-screen and the browser refuses to fire paste on it).
    // IMPORTANT: preventDefault must happen synchronously, BEFORE the
    // await on navigator.clipboard.readText(). If we let the event tick
    // run first, xterm's keystroke handler converts Ctrl+V into the raw
    // ^V (0x16) control byte and ships it before our async paste even
    // resolves.
    const onKey = (ev) => {
      const meta = ev.ctrlKey || ev.metaKey;
      if (!meta || ev.key.toLowerCase() !== 'v') return;
      if (ev.shiftKey || ev.altKey) return;
      if (!isOurs()) return;
      if (!navigator.clipboard?.readText) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      navigator.clipboard.readText().then((text) => {
        if (text) doPaste(text);
      }).catch(() => {});
    };
    document.addEventListener('keydown', onKey, true);

    // Shift+Enter / Ctrl+Enter → insert literal newline, don't submit.
    // Background: xterm.js encodes BOTH plain Enter and Shift+Enter and
    // Ctrl+Enter as \r (0x0D / CR). The kitty keyboard / win32 input
    // protocols (enabled in vtExtensions above) WOULD distinguish them,
    // but they're opt-in by the running app — claude code doesn't enable
    // either, so we never get the distinction "for free".
    //
    // Send the LF (0x0A) explicitly. Claude code (and most modern TUIs)
    // treat \n inside a prompt as a literal newline insert, \r as submit.
    // Alt+Enter already works (xterm sends \x1b\r → meta-enter) so we
    // leave that alone.
    const onShiftEnter = (ev) => {
      if (ev.key !== 'Enter') return;
      if (!(ev.shiftKey || ev.ctrlKey)) return;
      if (ev.metaKey || ev.altKey) return;
      if (!isOurs()) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: '\n' }));
      }
    };
    document.addEventListener('keydown', onShiftEnter, true);

    // IME fix: xterm positions .xterm-helper-textarea via `left: <col-px>`
    // following the cursor. When the cursor is near the right edge and the
    // user starts composing (e.g. Chinese pinyin), the textarea + native
    // composition popup grow with the composed string and overflow the
    // terminal host — which visually pushes the layout right. We can't cap
    // width / change wrapping (that breaks Chromium's IME event flow), but
    // we CAN re-anchor the textarea to the right edge while composing so
    // it grows leftward instead. Toggling a class on the host is enough;
    // the CSS in terminals.css does the rest.
    const onCompStart = () => {
      if (host) host.classList.add('is-composing');
      // The terminal cursor is rendered on canvas (THEME.cursor), so CSS
      // can't hide it. Theme swap alone doesn't reliably stop the blink
      // frame loop, so also issue the DECTCEM hide sequence which the
      // renderer honours immediately.
      try { term.options.theme = { ...THEME, cursor: 'transparent', cursorAccent: 'transparent' }; } catch {}
      try { term.write('\x1b[?25l'); } catch {}
    };
    const onCompEnd   = () => {
      if (host) host.classList.remove('is-composing');
      try { term.options.theme = THEME; } catch {}
      try { term.write('\x1b[?25h'); } catch {}
    };
    const helper = host?.querySelector('.xterm-helper-textarea');
    if (helper) {
      helper.addEventListener('compositionstart', onCompStart);
      helper.addEventListener('compositionend', onCompEnd);
    }

    return () => {
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keydown', onShiftEnter, true);
      if (helper) {
        helper.removeEventListener('compositionstart', onCompStart);
        helper.removeEventListener('compositionend', onCompEnd);
      }
      ro.disconnect();
      if (panelMo) panelMo.disconnect();
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      wsRef.current = null;
    };
  }, [terminalId]);

  if (!terminalId) {
    return html`<div class="terminal-empty">Select a terminal on the left, or launch a new one.</div>`;
  }
  return html`<div ref=${hostRef} class="terminal-host"></div>`;
}
