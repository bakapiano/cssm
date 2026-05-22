// xterm.js wrapper. Mounts a terminal into a ref'd div, opens a WebSocket
// to /ws/terminal/<id>, forwards keystrokes/resize as JSON frames, renders
// output frames into xterm. Disposes everything on unmount or id change.

import { html } from '../html.js';
import { useEffect, useRef } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
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
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
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

    // give focus to terminal so user can type immediately
    term.focus();

    return () => {
      ro.disconnect();
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
