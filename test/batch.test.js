// `node test/batch.test.js`
import assert from 'node:assert/strict';
import {buildBatchPlan, estimateBatchSeconds, summariseBatch} from '../src/batch.js';
import {median, mad} from '../src/engine.js';

const A = {id: 'a', label: 'Monitor'};
const B = {id: 'b', label: 'BT Speaker'};
const C = {id: 'c', label: 'Earbuds'};

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
console.log('batch');

check('re-measures the reference once per round, not once per batch', () => {
  const plan = buildBatchPlan({references: [A], devices: [B, C], rounds: 3});
  const refRuns = plan.filter((s) => s.kind === 'ref');
  assert.equal(refRuns.length, 3, 'reference must be re-measured every round');
  assert.deepEqual(refRuns.map((s) => s.round), [1, 2, 3]);
});

check('each round measures the reference before its devices', () => {
  const plan = buildBatchPlan({references: [A], devices: [B, C], rounds: 2});
  for (let round = 1; round <= 2; round++) {
    const inRound = plan.filter((s) => s.round === round);
    assert.equal(inRound[0].kind, 'ref', `round ${round} must start with its reference`);
    assert.ok(inRound.slice(1).every((s) => s.kind === 'dut'));
  }
});

check('rounds are the outer loop so devices interleave over time', () => {
  const plan = buildBatchPlan({references: [A], devices: [B, C], rounds: 2});
  const bRounds = plan.filter((s) => s.deviceId === 'b').map((s) => s.round);
  const cRounds = plan.filter((s) => s.deviceId === 'c').map((s) => s.round);
  // Both devices appear in both rounds, rather than B twice then C twice.
  assert.deepEqual(bRounds, [1, 2]);
  assert.deepEqual(cRounds, [1, 2]);
});

check('a device is not measured against itself by default', () => {
  const plan = buildBatchPlan({references: [A, B], devices: [A, B], rounds: 1});
  assert.ok(plan.filter((s) => s.kind === 'dut').every((s) => s.deviceId !== s.refId));
});

check('self-check can be requested explicitly', () => {
  const plan = buildBatchPlan({references: [A], devices: [A], rounds: 1, includeSelfCheck: true});
  const duts = plan.filter((s) => s.kind === 'dut');
  assert.equal(duts.length, 1);
  assert.equal(duts[0].deviceId, duts[0].refId, 'self-check compares a device with itself');
});

check('covers every reference x device combination', () => {
  const plan = buildBatchPlan({references: [A, B], devices: [A, B, C], rounds: 2});
  const pairs = new Set(plan.filter((s) => s.kind === 'dut').map((s) => `${s.refId}->${s.deviceId}`));
  // A->B, A->C, B->A, B->C  (self pairs excluded)
  assert.deepEqual([...pairs].sort(), ['a->b', 'a->c', 'b->a', 'b->c']);
  // 2 refs x 2 rounds x (1 ref run + 2 duts) = 12
  assert.equal(plan.length, 12);
});

check('skips a reference with nothing to compare against', () => {
  const plan = buildBatchPlan({references: [A], devices: [A], rounds: 1});
  assert.equal(plan.length, 0, 'a lone self-pair without includeSelfCheck yields no work');
});

check('rejects invalid specs', () => {
  assert.throws(() => buildBatchPlan({references: [], devices: [A], rounds: 1}), /reference/);
  assert.throws(() => buildBatchPlan({references: [A], devices: [], rounds: 1}), /device/);
  assert.throws(() => buildBatchPlan({references: [A], devices: [B], rounds: 0}), /rounds/);
  assert.throws(() => buildBatchPlan({references: [A], devices: [B], rounds: 2.5}), /rounds/);
});

check('estimates wall clock from step count', () => {
  const plan = buildBatchPlan({references: [A], devices: [B], rounds: 3});
  assert.equal(plan.length, 6);
  assert.equal(estimateBatchSeconds(plan, 7), 42);
});

check('summarise groups by pair and is robust to one bad round', () => {
  const results = [
    {round: 1, refLabel: 'Monitor', deviceLabel: 'BT Speaker', deltaMs: 80, driftMsPerSec: -1},
    {round: 2, refLabel: 'Monitor', deviceLabel: 'BT Speaker', deltaMs: 82, driftMsPerSec: -1.4},
    {round: 3, refLabel: 'Monitor', deviceLabel: 'BT Speaker', deltaMs: 300, driftMsPerSec: -1.2},
    {round: 1, refLabel: 'Monitor', deviceLabel: 'Earbuds', deltaMs: 40},
  ];
  const rows = summariseBatch(results, {median, mad});
  assert.equal(rows.length, 2);
  const bt = rows.find((r) => r.deviceLabel === 'BT Speaker');
  assert.equal(bt.n, 3);
  assert.equal(bt.medianMs, 82, 'median must ignore the 300ms outlier round');
  assert.equal(bt.minMs, 80);
  assert.equal(bt.maxMs, 300);
  assert.equal(bt.rangeMs, 220, 'range still exposes that a round disagreed');
  assert.ok(Math.abs(bt.medianDriftMsPerSec - (-1.2)) < 1e-9);
});

check('summarise skips rows with no delta', () => {
  const rows = summariseBatch([{round: 1, refLabel: 'A', deviceLabel: 'B', deltaMs: null}], {median, mad});
  assert.equal(rows.length, 0);
});

console.log(`\n${passed} passed`);
