// `node test/vmsync.test.js`
import assert from 'node:assert/strict';
import {
  solveBusDelays, busCombinations, routeFlagsFor, playerOffsetForGroup, MAX_BUS_DELAY_MS,
} from '../src/vmsync.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
console.log('vmsync');

check('delays the fast buses back to the slowest one', () => {
  // Modelled on the real rig: Bluetooth A1 far behind HDMI A2 and Realtek A3.
  const r = solveBusDelays([
    {busIndex: 0, label: 'A1', latencyMs: 246},
    {busIndex: 1, label: 'A2', latencyMs: 68},
    {busIndex: 2, label: 'A3', latencyMs: 175},
  ]);
  assert.equal(r.anchorIndex, 0, 'the slowest bus must anchor — it cannot be sped up');
  assert.equal(r.anchorLatencyMs, 246);
  assert.equal(r.spreadMs, 178);
  const byBus = Object.fromEntries(r.plan.map((p) => [p.busIndex, p.delayMs]));
  assert.equal(byBus[0], 0,   'the anchor takes no extra delay');
  assert.equal(byBus[1], 178);
  assert.equal(byBus[2], 71);
  assert.equal(r.residualMs, 0, 'everything should land together');
  assert.deepEqual(r.warnings, []);
});

check('reports the residual rather than assuming zero', () => {
  // Fractional latencies cannot be cancelled exactly by whole-ms delays.
  const r = solveBusDelays([
    {busIndex: 0, latencyMs: 100.4},
    {busIndex: 1, latencyMs: 50.9},
  ]);
  assert.equal(r.plan.find((p) => p.busIndex === 1).delayMs, 50); // round(49.5) = 50 -> 100.9
  assert.ok(r.residualMs > 0 && r.residualMs < 1,
    `residual ${r.residualMs} should be sub-millisecond, not silently zero`);
});

check('clamps at the Voicemeeter limit and says so', () => {
  const r = solveBusDelays([
    {busIndex: 0, label: 'A1', latencyMs: 700},
    {busIndex: 1, label: 'A2', latencyMs: 60},
  ]);
  const a2 = r.plan.find((p) => p.busIndex === 1);
  assert.equal(a2.delayMs, MAX_BUS_DELAY_MS);
  assert.equal(a2.clamped, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /A2/);
  assert.match(r.warnings[0], /140 ms/, 'must state how far out it will still be');
  assert.equal(r.residualMs, 140, 'residual must expose the un-fixable part');
});

check('already-aligned buses need no delay', () => {
  const r = solveBusDelays([
    {busIndex: 0, latencyMs: 80},
    {busIndex: 1, latencyMs: 80},
  ]);
  assert.deepEqual(r.plan.map((p) => p.delayMs), [0, 0]);
  assert.equal(r.spreadMs, 0);
});

check('refuses to solve with fewer than two buses', () => {
  assert.throws(() => solveBusDelays([{busIndex: 0, latencyMs: 80}]), /two/);
  assert.throws(() => solveBusDelays([]), /two/);
  // A bus whose measurement failed must not be silently treated as 0 ms.
  assert.throws(() => solveBusDelays([
    {busIndex: 0, latencyMs: 80}, {busIndex: 1, latencyMs: NaN},
  ]), /two/);
});

check('enumerates every non-empty combination, singles first', () => {
  assert.deepEqual(busCombinations([0, 1, 2]), [
    [0], [1], [2],
    [0, 1], [0, 2], [1, 2],
    [0, 1, 2],
  ]);
  assert.deepEqual(busCombinations([0, 1]), [[0], [1], [0, 1]]);
  assert.deepEqual(busCombinations([]), []);
  assert.deepEqual(busCombinations([2, 0, 2]), [[0], [2], [0, 2]], 'dedupes and sorts');
});

check('route flags are sized to the A-buses, not to every bus', () => {
  // Banana reports 5 buses but only 3 are A-buses. Sending 5 flags makes the
  // API try to set Strip[i].A4, which does not exist, and the whole call fails
  // — which is why no routing button appeared to do anything.
  assert.deepEqual(routeFlagsFor([0, 2], 3), [true, false, true]);
  assert.deepEqual(routeFlagsFor([1], 3), [false, true, false]);
  assert.equal(routeFlagsFor([0], 3).length, 3);
});

check('player offset is the anchor measured against the reference', () => {
  assert.equal(playerOffsetForGroup(246, 68), 178);
});

console.log(`\n${passed} passed`);
