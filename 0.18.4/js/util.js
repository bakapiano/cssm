// Pure formatters · no DOM access.

export function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { hour12: false });
}

export function fmtAgo(ms) {
  if (!ms) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// label override beats claude's ai-title; both empty → "(no title)"
export function displayTitle(label, fallback) {
  return label || fallback || '(no title)';
}

export function nowClock() {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}
