// Client for "delayprobe", the local companion app the user runs on their own
// machine. Everything the browser cannot do — WASAPI exclusive mode, real
// loopback capture, Voicemeeter's API — lives there; this file is only the
// wire.
//
// Why http://127.0.0.1 and not https, and not "localhost":
//   The page is served over https. An https page normally may not fetch http://
//   URLs at all (mixed content), and a local app cannot get a real TLS cert for
//   a loopback address. The escape hatch is that browsers classify loopback as
//   a "potentially trustworthy" origin, so Chromium exempts http://127.0.0.1
//   from mixed-content blocking. The exemption is specified for the literal
//   loopback IP; "localhost" depends on name resolution and is honoured less
//   consistently (and can resolve to ::1, which the local app may not be
//   listening on). So: the IP, always.
//   Firefox and Safari have historically not implemented the exemption. There
//   is no feature test for this — the fetch just rejects with a bare TypeError,
//   exactly like "app isn't running" does. connect() therefore has to guess,
//   and say so, rather than surface "Failed to fetch".
//
// Why every request has a deadline:
//   The far end is a desktop app doing blocking audio I/O. If it wedges holding
//   a device open, an un-aborted fetch never settles and the UI's "measuring…"
//   state becomes permanent with no way back. AbortController gives us a floor
//   on recoverability. /measure gets a much longer deadline than the rest
//   because a real measurement is ~6s per round and callers ask for several.

import {log} from './log.js';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';

const DEFAULT_TIMEOUT_MS = 4000;
const MEASURE_TIMEOUT_MS = 180000;

/** Errors carry a `.code` so callers can branch without matching on prose. */
function bridgeError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra !== undefined) err.detail = extra;
  return err;
}

/**
 * A bare TypeError from fetch means "the request never produced a response",
 * which covers connection-refused, DNS, and mixed-content blocking alike — the
 * spec deliberately hides which, so as not to leak network topology to script.
 * We can only guess, and the guess that helps most is based on the browser:
 * Chromium exempts loopback, so there a TypeError almost certainly means the
 * app isn't running; elsewhere the block is the likelier cause.
 * ponytail: userAgent-free feature detection for this does not exist; if
 * Firefox ever ships the loopback exemption, delete this branch.
 */
function looksBlockedByBrowser() {
  const httpsPage = globalThis.location?.protocol === 'https:';
  const chromium = typeof globalThis.chrome === 'object' && globalThis.chrome !== null;
  return httpsPage && !chromium;
}

function normaliseFetchFailure(err) {
  if (err?.name === 'AbortError') {
    return bridgeError('timeout', 'The local app did not answer in time. It may be busy or stuck — restart delayprobe and try again.');
  }
  if (err instanceof TypeError) {
    return looksBlockedByBrowser()
      ? bridgeError('blocked', 'Your browser blocked this page from reaching the local app on 127.0.0.1. Chrome or Edge allow it; Firefox and Safari usually do not.')
      : bridgeError('offline', 'Could not reach the local app on 127.0.0.1:8765. Start delayprobe, or your browser may be blocking the local connection.');
  }
  // Anything else already has a code (our own validation errors re-thrown).
  return err;
}

/** A response body we could not make sense of is a failure, not a quiet success. */
function badResponse(what) {
  return bridgeError('bad-response', `The local app sent something unexpected (${what}). It is probably a different version than this page expects.`);
}

const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkHealth(body) {
  if (!isObj(body) || body.ok !== true || body.app !== 'delayprobe') throw badResponse('not a delayprobe health payload');
  const vm = body.voicemeeter;
  if (!isObj(vm) || !isBool(vm.available) || !isBool(vm.running) || !isStr(vm.type)) throw badResponse('bad voicemeeter block in /health');
  return body;
}

function checkDevices(body) {
  const ok = (list) => Array.isArray(list) && list.every((d) => isObj(d) && isNum(d.index) && isStr(d.id) && isStr(d.name));
  if (!isObj(body) || !ok(body.render) || !ok(body.capture)) throw badResponse('bad /devices list');
  return body;
}

function checkMeasure(body) {
  if (!isObj(body) || !isBool(body.ok) || !Array.isArray(body.rounds)) throw badResponse('bad /measure result');
  for (const r of body.rounds) {
    if (!isObj(r) || !isBool(r.ok)) throw badResponse('bad round in /measure result');
  }
  if (body.medianDelayMs != null && !isNum(body.medianDelayMs)) throw badResponse('bad medianDelayMs');
  return body;
}

function checkVmState(body) {
  if (!isObj(body) || !isBool(body.available) || !isBool(body.running)) throw badResponse('bad /voicemeeter/state');
  if (!Array.isArray(body.buses) || !Array.isArray(body.strips)) throw badResponse('bad /voicemeeter/state lists');
  return body;
}

function checkAck(body) {
  if (!isObj(body) || body.ok !== true) throw badResponse('a write did not acknowledge');
  return body;
}

export function createBridge({baseUrl = DEFAULT_BRIDGE_URL, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const root = String(baseUrl).replace(/\/+$/, '');
  let connected = false;
  let info = null;

  async function request(path, {method = 'GET', body, deadlineMs = timeoutMs, validate} = {}) {
    if (typeof doFetch !== 'function') throw bridgeError('offline', 'This browser has no fetch, so the local app cannot be reached.');

    // globalThis-qualified only because AbortController isn't in eslint.config.mjs's globals.
    const ac = new globalThis.AbortController();
    const timer = setTimeout(() => ac.abort(), deadlineMs);
    let res;
    try {
      res = await doFetch(root + path, {
        method,
        signal: ac.signal,
        headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw normaliseFetchFailure(err);
    } finally {
      clearTimeout(timer);
    }

    // Parse first: the app reports its own failures as JSON with a 4xx/5xx, and
    // that message is far more useful than the status code.
    let parsed;
    let parseFailed = false;
    try {
      parsed = await res.json();
    } catch {
      parseFailed = true;
    }

    if (!res.ok) {
      if (!parseFailed && isObj(parsed) && isStr(parsed.error)) {
        throw bridgeError('app-error', parsed.error);
      }
      throw bridgeError('http', `The local app returned HTTP ${res.status} for ${path}.`);
    }
    if (parseFailed) throw badResponse('not JSON');
    return validate ? validate(parsed) : parsed;
  }

  /** Guard for everything except connect(): calling in the wrong order is a bug, not a network problem. */
  function requireConnected(what) {
    if (!connected) throw bridgeError('offline', `Not connected to the local app — connect first before ${what}.`);
  }

  return {
    async connect() {
      try {
        info = await request('/health', {validate: checkHealth});
      } catch (err) {
        connected = false;
        info = null;
        // Message only: response bodies stay out of the log at this level.
        log('warn', 'Local app connect failed', {code: err.code, message: err.message});
        throw err;
      }
      connected = true;
      log('ok', 'Local app connected', {version: info.version, voicemeeter: info.voicemeeter.type});
      return info;
    },

    isConnected: () => connected,
    getInfo: () => info,

    disconnect() {
      if (connected) log('info', 'Local app disconnected');
      connected = false;
      info = null;
    },

    devices() {
      requireConnected('listing devices');
      return request('/devices', {validate: checkDevices});
    },

    /** @param {{output: string, input?: string|null, exclusive?: boolean, repeats?: number, rounds?: number}} opts */
    measure({output, input = null, exclusive = false, repeats = 5, rounds = 1}) {
      requireConnected('measuring');
      if (!isStr(output) || !output) throw bridgeError('app-error', 'measure() needs an output device.');
      return request('/measure', {
        method: 'POST',
        deadlineMs: MEASURE_TIMEOUT_MS,
        body: {output, input, exclusive, repeats, rounds},
        validate: checkMeasure,
      });
    },

    voicemeeterState() {
      requireConnected('reading Voicemeeter state');
      return request('/voicemeeter/state', {validate: checkVmState});
    },

    setRoute(strip, aFlags) {
      requireConnected('setting a route');
      return request('/voicemeeter/route', {method: 'POST', body: {strip, a: aFlags}, validate: checkAck});
    },

    setDelay(bus, ms) {
      requireConnected('setting a bus delay');
      return request('/voicemeeter/delay', {method: 'POST', body: {bus, ms}, validate: checkAck});
    },

    setBusDevice(bus, device, driver = 'wdm') {
      requireConnected('setting a bus device');
      return request('/voicemeeter/bus-device', {method: 'POST', body: {bus, device, driver}, validate: checkAck});
    },
  };
}

/** One sentence for a status line. Falls back to the error's own message. */
export function describeBridgeError(err) {
  switch (err?.code) {
    case 'timeout': return 'The local app stopped responding.';
    case 'offline': return 'Local app not found — start delayprobe on this PC.';
    case 'blocked': return 'This browser blocks the local connection — use Chrome or Edge.';
    case 'http': return 'The local app rejected the request.';
    case 'bad-response': return 'The local app replied in a format this page does not understand — update it.';
    case 'app-error': return `Local app error: ${err.message}`;
    default: return err?.message || 'Unknown problem talking to the local app.';
  }
}
