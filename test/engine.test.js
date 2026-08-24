// Headless self-check. `node test/engine.test.js`
// Proves the correlation recovers a known delay before any hardware is involved.
import assert from 'node:assert/strict';
import {
  makeStimulus, measure, differential, playerOffsets, median, mad, SPEED_OF_SOUND,
} from '../src/engine.js';

const SR = 48000;

// deterministic PRNG so gaps and noise are reproducible across runs
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Simulate a capture: signal delayed, attenuated, plus a reflection and noise. */
function simulate(stimulus, {delaySamples, gain = 1, reflection = null, noise = 0, rand}) {
  const src = stimulus.signal;
  const rec = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const j = i - delaySamples;
    if (j >= 0) rec[i] += gain * src[j];
    if (reflection) {
      const r = i - delaySamples - reflection.delaySamples;
      if (r >= 0) rec[i] += reflection.gain * src[r];
    }
    if (noise) rec[i] += noise * (rand() * 2 - 1);
  }
  return rec;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('engine');

check('recovers a known delay to within 0.5 ms', () => {
  const rand = lcg(1);
  const st = makeStimulus(SR, {}, rand);
  const trueMs = 187;
  const rec = simulate(st, {delaySamples: Math.round((trueMs / 1000) * SR), gain: 0.4, noise: 0.002, rand});
  const r = measure(rec, st);
  assert.equal(r.ok, true, `rejected: ${r.reason}`);
  assert.ok(Math.abs(r.delayMs - trueMs) < 0.5, `got ${r.delayMs}, want ${trueMs}`);
  assert.ok(r.qualityDb > 18, `quality ${r.qualityDb} dB too low`);
});

check('picks the direct arrival, not a louder reflection', () => {
  const rand = lcg(2);
  const st = makeStimulus(SR, {}, rand);
  const trueMs = 92;
  const rec = simulate(st, {
    delaySamples: Math.round((trueMs / 1000) * SR),
    gain: 0.35,
    // reflection 12 ms later and *stronger* than the direct sound
    reflection: {delaySamples: Math.round(0.012 * SR), gain: 0.42},
    noise: 0.002,
    rand,
  });
  const r = measure(rec, st);
  assert.equal(r.ok, true, `rejected: ${r.reason}`);
  assert.ok(Math.abs(r.delayMs - trueMs) < 1.0, `got ${r.delayMs}, want ${trueMs} (took the reflection?)`);
});

check('recovers a delay longer than the old inter-sweep gap (aliasing regression)', () => {
  // Regression for the bug that made a Bluetooth speaker read as 9.89ms
  // round trip with a 0.02ms spread. Any delay in this range used to be
  // reported as (delay - gap) because the previous sweep's arrival sat
  // earlier in the window than the current sweep's own.
  for (const trueMs of [180, 240, 300, 420]) {
    const rand = lcg(11);
    const st = makeStimulus(SR, {}, rand);
    const rec = simulate(st, {
      delaySamples: Math.round((trueMs / 1000) * SR), gain: 0.4, noise: 0.002, rand,
    });
    const r = measure(rec, st);
    assert.equal(r.ok, true, `${trueMs}ms rejected: ${r.reason}`);
    assert.ok(Math.abs(r.delayMs - trueMs) < 1.0,
      `got ${r.delayMs?.toFixed(2)}, want ${trueMs} — aliased onto a neighbouring sweep?`);
  }
});

check('refuses to build a stimulus whose gaps allow aliasing', () => {
  assert.throws(
    () => makeStimulus(SR, {gapMinSec: 0.15, gapMaxSec: 0.3, maxLagSec: 0.6}),
    /alias/i,
    'a gap shorter than the search window must be rejected, not silently measured');
});

check('rejects an inverted gap range', () => {
  assert.throws(
    () => makeStimulus(SR, {gapMinSec: 0.75, gapMaxSec: 0.65}),
    /gapMaxSec/,
    'an inverted range would generate negative gaps and overlap sweeps');
});

check('the warm-up sweep is emitted but never measured', () => {
  const withWarm = makeStimulus(SR, {warmup: true}, lcg(12));
  const without = makeStimulus(SR, {warmup: false}, lcg(12));
  assert.equal(withWarm.offsets.length, without.offsets.length);
  assert.ok(withWarm.signal.length > without.signal.length, 'warm-up should lengthen the signal');
  assert.ok(withWarm.offsets[0] > 0, 'first measured sweep must sit after the warm-up');
});

check('trims a repeat that lands far from the pack', () => {
  const rand = lcg(4);
  const st = makeStimulus(SR, {}, rand);
  const trueMs = 60, trueSamples = Math.round((trueMs / 1000) * SR);
  const badSamples = Math.round((400 / 1000) * SR); // e.g. a repeat that caught a strong late reflection
  const rec = new Float32Array(st.signal.length);
  st.offsets.forEach((off, i) => {
    const delaySamples = i === 0 ? badSamples : trueSamples; // first repeat is the outlier
    for (let k = 0; k < st.sweep.length; k++) {
      const j = off + delaySamples + k;
      if (j < rec.length) rec[j] += 0.4 * st.sweep[k];
    }
  });
  for (let i = 0; i < rec.length; i++) rec[i] += 0.002 * (rand() * 2 - 1);

  const r = measure(rec, st);
  assert.equal(r.ok, true, `rejected: ${r.reason}`);
  assert.ok(Math.abs(r.delayMs - trueMs) < 1.0, `got ${r.delayMs}, want ~${trueMs} (outlier not trimmed?)`);
  assert.ok(r.trimmedOutliers >= 1, 'expected the 400ms outlier repeat to be trimmed');
});

check('separates clock drift from jitter', () => {
  // Modelled on a real Bluetooth capture whose per-repeat delays fell
  // monotonically 262 -> 244 ms across the run. Averaging that ramp gives a
  // number describing no instant in particular, and its raw spread reports
  // the drift rather than the measurement noise.
  const rand = lcg(21);
  const st = makeStimulus(SR, {}, rand);
  const startMs = 262, driftMsPerSec = -5.2;
  const rec = new Float32Array(st.signal.length);
  st.offsets.forEach((off) => {
    const tSec = off / SR;
    const delayMs = startMs + driftMsPerSec * tSec;
    const d = Math.round((delayMs / 1000) * SR);
    for (let k = 0; k < st.sweep.length; k++) {
      const j = off + d + k;
      if (j < rec.length) rec[j] += 0.4 * st.sweep[k];
    }
  });
  for (let i = 0; i < rec.length; i++) rec[i] += 0.002 * (rand() * 2 - 1);

  const r = measure(rec, st);
  assert.ok(r.drifting, 'a 5.2 ms/s ramp must be flagged as drift');
  assert.ok(Math.abs(r.driftMsPerSec - driftMsPerSec) < 0.6,
    `drift ${r.driftMsPerSec?.toFixed(2)} ms/s, want ~${driftMsPerSec}`);
  // Jitter is scatter about the trend, so it must stay small even though the
  // raw spread is large.
  assert.ok(r.jitterMs < 2, `jitter ${r.jitterMs?.toFixed(2)} ms should be small`);
  assert.ok(r.spreadMs > r.jitterMs, 'raw spread should exceed detrended jitter here');
  // settledMs tracks where the trend ended, not the middle of the ramp.
  const lastT = st.offsets[st.offsets.length - 1] / SR;
  assert.ok(Math.abs(r.settledMs - (startMs + driftMsPerSec * lastT)) < 1.5,
    `settled ${r.settledMs?.toFixed(2)} should match the end of the ramp`);
});

check('a steady device reports no drift', () => {
  const rand = lcg(22);
  const st = makeStimulus(SR, {}, rand);
  const rec = simulate(st, {delaySamples: Math.round(0.08 * SR), gain: 0.4, noise: 0.002, rand});
  const r = measure(rec, st);
  assert.equal(r.drifting, false, `steady signal flagged as drifting (${r.driftMsPerSec} ms/s)`);
  assert.equal(r.ok, true);
});

check('rejects a capture that is mostly noise', () => {
  const rand = lcg(3);
  const st = makeStimulus(SR, {}, rand);
  const rec = simulate(st, {delaySamples: 4800, gain: 0.001, noise: 0.3, rand});
  const r = measure(rec, st);
  assert.equal(r.ok, false, 'should not have trusted a noise-dominated capture');
});

check('differential cancels the shared input path', () => {
  // same mic latency (30 ms) in both; only the output path differs
  const MIC = 30;
  const {deltaMs} = differential(MIC + 5, MIC + 170);
  assert.equal(deltaMs, 165);
});

check('differential corrects unequal mic distance', () => {
  const {deltaMs, airCorrectionMs} = differential(50, 200, {refDistanceM: 0.3, dutDistanceM: 1.3});
  const expectedAir = (1 / SPEED_OF_SOUND) * 1000; // ~2.92 ms
  assert.ok(Math.abs(airCorrectionMs - expectedAir) < 0.01);
  assert.ok(Math.abs(deltaMs - (150 - expectedAir)) < 0.01);
});

check('player offset sign advances late audio', () => {
  const late = playerOffsets(180);
  assert.equal(late.vlc, '-180 ms');
  assert.equal(late.mpv, '--audio-delay=-0.180');
  assert.match(late.summary, /late/);

  const early = playerOffsets(-40);
  assert.equal(early.vlc, '40 ms');
  assert.equal(early.mpv, '--audio-delay=0.040');
  assert.match(early.summary, /early/);
});

check('median and mad ignore outliers', () => {
  assert.equal(median([1, 2, 3, 4, 100]), 3);
  assert.equal(mad([10, 10, 10, 10, 500]), 0);
});

console.log(`\n${passed} passed`);
