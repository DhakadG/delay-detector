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

export function logCount() {
  return entries.length;
}

/**
 * Route everything the page can go wrong with into the same timestamped log,
 * so a bug report is one "Copy" away and nothing fails silently in a console
 * the user never opens.
 */
export function installGlobalHandlers() {
  window.addEventListener('error', (e) => {
    log('bad', 'Uncaught error', {
      message: e.message,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      stack: e.error?.stack?.split('\n').slice(0, 4).join(' | '),
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log('bad', 'Unhandled promise rejection', {
      message: r?.message ?? String(r),
      stack: r?.stack?.split('\n').slice(0, 4).join(' | '),
    });
  });

  const origError = console.error.bind(console);
  console.error = (...args) => {
    log('bad', 'console.error', {args: args.map((a) => (a instanceof Error ? a.message : String(a)))});
    origError(...args);
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    log('warn', 'console.warn', {args: args.map(String)});
    origWarn(...args);
  };

  document.addEventListener('visibilitychange', () => {
    // Browsers throttle timers and can suspend audio in background tabs,
    // which would quietly wreck a measurement in progress.
    log(document.hidden ? 'warn' : 'info',
      document.hidden ? 'Tab hidden — do not run a measurement while backgrounded' : 'Tab visible again');
  });
}

export function clearLog() {
  entries = [];
  if (target) target.innerHTML = '';
}
