// `node test/bridge.test.js`
import assert from 'node:assert/strict';
import {createBridge, describeBridgeError, DEFAULT_BRIDGE_URL} from '../src/bridge.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
async function checkAsync(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }
console.log('bridge');

const HEALTH = {
  ok: true, app: 'delayprobe', version: '0.3.1',
  voicemeeter: {available: true, running: true, type: 'banana'},
};

/** Minimal Response stand-in: only what bridge.js actually touches. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}

/** Records calls; replies from a map of path -> response (or a function). */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    const path = url.slice(DEFAULT_BRIDGE_URL.length);
    calls.push({url, path, opts, body: opts?.body ? JSON.parse(opts.body) : undefined});
    const route = routes[path];
    if (route === undefined) throw new Error(`test fetch: no route for ${path}`);
    return typeof route === 'function' ? route(opts) : route;
  };
  impl.calls = calls;
  return impl;
}

async function connected(routes) {
  const fetchImpl = fakeFetch({'/health': jsonResponse(HEALTH), ...routes});
  const bridge = createBridge({fetchImpl});
  await bridge.connect();
  return {bridge, fetchImpl};
}

/** Asserts fn() rejects with a bridge error of `code`; returns the error. */
async function rejectsWithCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new assert.AssertionError({message: `expected a rejection with code ${code}, but it resolved`});
}

await checkAsync('connect parses health and flips isConnected()', async () => {
  const fetchImpl = fakeFetch({'/health': jsonResponse(HEALTH)});
  const bridge = createBridge({fetchImpl});
  assert.equal(bridge.isConnected(), false);
  assert.equal(bridge.getInfo(), null);

  const info = await bridge.connect();
  assert.equal(info.version, '0.3.1');
  assert.equal(info.voicemeeter.type, 'banana');
  assert.equal(bridge.isConnected(), true);
  assert.deepEqual(bridge.getInfo(), HEALTH);
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8765/health', 'must use the loopback IP, not localhost');
});

await checkAsync('disconnect clears connected state and info', async () => {
  const {bridge} = await connected({});
  bridge.disconnect();
  assert.equal(bridge.isConnected(), false);
  assert.equal(bridge.getInfo(), null);
});

await checkAsync('non-JSON health is bad-response, not success', async () => {
  const bridge = createBridge({fetchImpl: fakeFetch({'/health': jsonResponse(undefined)})});
  await rejectsWithCode(() => bridge.connect(), 'bad-response');
  assert.equal(bridge.isConnected(), false, 'a failed probe must not leave us "connected"');
});

await checkAsync('a 200 with the wrong shape is bad-response', async () => {
  // Right status, plausible JSON, but not delayprobe's health payload.
  const bridge = createBridge({fetchImpl: fakeFetch({'/health': jsonResponse({ok: true, app: 'something-else'})})});
  await rejectsWithCode(() => bridge.connect(), 'bad-response');
});

await checkAsync('health missing the voicemeeter block is bad-response', async () => {
  const bridge = createBridge({fetchImpl: fakeFetch({'/health': jsonResponse({ok: true, app: 'delayprobe', version: '1'})})});
  await rejectsWithCode(() => bridge.connect(), 'bad-response');
});

await checkAsync('a bare TypeError from fetch becomes an explanatory offline/blocked error', async () => {
  const bridge = createBridge({fetchImpl: async () => { throw new TypeError('Failed to fetch'); }});
  const err = await rejectsWithCode(() => bridge.connect(), 'offline');
  assert.ok(!/Failed to fetch/.test(err.message), 'must not surface the opaque browser message');
  assert.match(err.message, /127\.0\.0\.1:8765/);
  assert.match(err.message, /delayprobe/, 'should tell the user to start the local app');
  assert.match(err.message, /block/i, 'should also mention the browser may be blocking it');
});

await checkAsync('a TypeError on an https page in a non-Chromium browser is blocked', async () => {
  // looksBlockedByBrowser() reads globalThis.location/chrome; simulate Firefox.
  globalThis.location = {protocol: 'https:'};
  try {
    const bridge = createBridge({fetchImpl: async () => { throw new TypeError('NetworkError'); }});
    const err = await rejectsWithCode(() => bridge.connect(), 'blocked');
    assert.match(err.message, /Chrome|Edge/);
  } finally {
    delete globalThis.location;
  }
});

await checkAsync('an AbortError becomes a timeout', async () => {
  const bridge = createBridge({fetchImpl: async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }});
  const err = await rejectsWithCode(() => bridge.connect(), 'timeout');
  assert.match(err.message, /in time/);
});

await checkAsync('a hung fetch is actually aborted by the deadline', async () => {
  let sawAbort = false;
  const bridge = createBridge({
    timeoutMs: 20,
    fetchImpl: (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        sawAbort = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  await rejectsWithCode(() => bridge.connect(), 'timeout');
  assert.equal(sawAbort, true, 'the AbortController signal must actually fire');
});

await checkAsync('HTTP 500 with {ok:false,error} is app-error carrying the message', async () => {
  const {bridge} = await connected({
    '/devices': jsonResponse({ok: false, error: 'boom'}, 500),
  });
  const err = await rejectsWithCode(() => bridge.devices(), 'app-error');
  assert.match(err.message, /boom/);
});

await checkAsync('HTTP 404 without a JSON body is http', async () => {
  const {bridge} = await connected({
    '/devices': jsonResponse(undefined, 404),
  });
  const err = await rejectsWithCode(() => bridge.devices(), 'http');
  assert.match(err.message, /404/);
});

await checkAsync('devices() validates the lists', async () => {
  const {bridge} = await connected({
    '/devices': jsonResponse({render: [{index: 0, id: 'r0', name: 'Speakers'}], capture: []}),
  });
  const d = await bridge.devices();
  assert.equal(d.render[0].name, 'Speakers');

  const bad = await connected({'/devices': jsonResponse({render: [{index: 'zero', id: 'r0', name: 'x'}], capture: []})});
  await rejectsWithCode(() => bad.bridge.devices(), 'bad-response');
});

await checkAsync('measure() posts the contract body and returns the parsed result', async () => {
  const result = {
    ok: true, output: 'Speakers', input: 'Loopback', mode: 'exclusive',
    rounds: [{ok: true, delayMs: 82.4, settledMs: 900, jitterMs: 1.2, driftMsPerSec: -0.01,
      qualityDb: 34, usedRepeats: 5, delays: [82, 83], reason: null}],
    medianDelayMs: 82.4,
  };
  const {bridge, fetchImpl} = await connected({'/measure': jsonResponse(result)});
  const got = await bridge.measure({output: 'Speakers', input: 'Loopback', exclusive: true, repeats: 7, rounds: 3});

  const call = fetchImpl.calls.at(-1);
  assert.equal(call.path, '/measure');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, {output: 'Speakers', input: 'Loopback', exclusive: true, repeats: 7, rounds: 3});
  assert.equal(got.medianDelayMs, 82.4);
  assert.equal(got.rounds[0].delayMs, 82.4);
});

await checkAsync('measure() defaults input/exclusive/repeats/rounds', async () => {
  const {bridge, fetchImpl} = await connected({
    '/measure': jsonResponse({ok: true, rounds: [], medianDelayMs: null}),
  });
  await bridge.measure({output: 'Speakers'});
  assert.deepEqual(fetchImpl.calls.at(-1).body, {output: 'Speakers', input: null, exclusive: false, repeats: 5, rounds: 1});
});

await checkAsync('measure() rejects a result whose rounds are malformed', async () => {
  const {bridge} = await connected({'/measure': jsonResponse({ok: true, rounds: [{delayMs: 5}]})});
  await rejectsWithCode(() => bridge.measure({output: 'Speakers'}), 'bad-response');
});

await checkAsync('voicemeeter writes post the documented bodies and require an ack', async () => {
  const {bridge, fetchImpl} = await connected({
    '/voicemeeter/state': jsonResponse({available: true, running: true, type: 'potato',
      buses: [{index: 0, label: 'A1', device: 'Speakers', delayMs: 0}],
      strips: [{index: 0, label: 'Strip 1', a: [true, false], b: [false]}]}),
    '/voicemeeter/route': jsonResponse({ok: true}),
    '/voicemeeter/delay': jsonResponse({ok: true}),
    '/voicemeeter/bus-device': jsonResponse({ok: true}),
  });

  const state = await bridge.voicemeeterState();
  assert.equal(state.buses[0].label, 'A1');

  await bridge.setRoute(0, [true, false]);
  assert.deepEqual(fetchImpl.calls.at(-1).body, {strip: 0, a: [true, false]});

  await bridge.setDelay(1, 42.5);
  assert.deepEqual(fetchImpl.calls.at(-1).body, {bus: 1, ms: 42.5});

  await bridge.setBusDevice(1, 'Speakers', 'ks');
  assert.deepEqual(fetchImpl.calls.at(-1).body, {bus: 1, device: 'Speakers', driver: 'ks'});

  await bridge.setBusDevice(1, 'Speakers');
  assert.equal(fetchImpl.calls.at(-1).body.driver, 'wdm', 'wdm is the default driver');
});

await checkAsync('a write that does not acknowledge is bad-response', async () => {
  const {bridge} = await connected({'/voicemeeter/delay': jsonResponse({applied: true})});
  await rejectsWithCode(() => bridge.setDelay(0, 10), 'bad-response');
});

await checkAsync('calling a method before connect() throws a clear offline error, without fetching', async () => {
  const fetchImpl = fakeFetch({});
  const bridge = createBridge({fetchImpl});
  for (const call of [
    () => bridge.devices(),
    () => bridge.measure({output: 'Speakers'}),
    () => bridge.voicemeeterState(),
    () => bridge.setRoute(0, [true]),
    () => bridge.setDelay(0, 1),
    () => bridge.setBusDevice(0, 'x', 'wdm'),
  ]) {
    const err = await rejectsWithCode(call, 'offline');
    assert.match(err.message, /connect first/);
  }
  assert.equal(fetchImpl.calls.length, 0, 'must not hit the network before connecting');
});

await checkAsync('measure() rejects a missing output device', async () => {
  const {bridge} = await connected({});
  await rejectsWithCode(() => bridge.measure({output: ''}), 'app-error');
});

check('describeBridgeError gives a distinct sentence per code', () => {
  const codes = ['timeout', 'offline', 'blocked', 'http', 'bad-response'];
  const lines = codes.map((code) => describeBridgeError(Object.assign(new Error('x'), {code})));
  assert.equal(new Set(lines).size, codes.length, 'each code needs its own wording');
  assert.ok(lines.every((l) => l.length > 10 && l.endsWith('.')));
  assert.match(describeBridgeError(Object.assign(new Error('device busy'), {code: 'app-error'})), /device busy/);
  assert.equal(describeBridgeError(new Error('something else')), 'something else');
  assert.ok(describeBridgeError(undefined).length > 0);
});

check('the default URL is the loopback IP, not localhost', () => {
  assert.equal(DEFAULT_BRIDGE_URL, 'http://127.0.0.1:8765');
});

await checkAsync('a trailing slash in baseUrl does not produce a doubled path', async () => {
  const calls = [];
  const bridge = createBridge({
    baseUrl: 'http://127.0.0.1:8765/',
    fetchImpl: async (url) => { calls.push(url); return jsonResponse(HEALTH); },
  });
  await bridge.connect();
  assert.equal(calls[0], 'http://127.0.0.1:8765/health');
});

console.log(`\n${passed} passed`);
