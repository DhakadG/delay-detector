// Measurement history, kept in localStorage so results survive a reload —
// there is no server, so the browser is the only place they can live.
const KEY = 'delay-detector:history:v1';
const MAX_ENTRIES = 200;

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function saveEntry(entry) {
  const history = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // storage full or disabled (private browsing) — history just won't persist
  }
  return history;
}

export function clearHistory() {
  localStorage.removeItem(KEY);
}

function csvField(s) {
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(history) {
  const header = ['timestamp', 'device', 'delta_ms', 'spread_ms', 'confidence', 'vlc', 'mpv'];
  const rows = history.map((h) => [
    h.timestamp, h.device, h.deltaMs.toFixed(1), h.spreadMs.toFixed(1),
    h.confidence || (h.confident ? 'ok' : 'warn'), h.vlc, h.mpv,
  ]);
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n');
}
