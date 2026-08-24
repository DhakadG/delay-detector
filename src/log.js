// Timestamped, leveled session log. Kept in memory so it can be exported or
// copied whole — the DOM is just the current rendering of it.
let entries = [];
let target = null;

export function initLog(el) {
  target = el;
}

function stamp() {
  const d = new Date();
  const hms = d.toTimeString().slice(0, 8);
  return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmt({t, level, msg, data}) {
  const line = `[${t}] ${level.toUpperCase().padEnd(4)} ${msg}`;
  return data === undefined ? line : `${line} ${safeJson(data)}`;
}

function safeJson(d) {
  try { return JSON.stringify(d); } catch { return String(d); }
}

/** level: 'info' | 'ok' | 'warn' | 'bad'. data: any small JSON-serialisable value, for detail without cluttering the message. */
export function log(level, msg, data) {
  const entry = {t: stamp(), level, msg, data};
  entries.push(entry);
  if (!target) return;
  const row = document.createElement('div');
  row.className = 'log-line log-' + level;
  row.textContent = fmt(entry);
  target.appendChild(row);
  target.scrollTop = target.scrollHeight;
}

export function exportLog() {
  return entries.map(fmt).join('\n');
}

export function clearLog() {
  entries = [];
  if (target) target.innerHTML = '';
}
