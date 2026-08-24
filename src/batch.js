// Batch measurement planning.
//
// Design notes, because the ordering here is the whole point:
//
// 1. A differential is only valid if its reference and its device were
//    measured through the same input chain at close to the same time. Devices
//    drift and Bluetooth links renegotiate, so a reference taken three minutes
//    and twenty measurements ago is not the same reference. The plan therefore
//    re-measures the reference at the start of every round rather than once at
//    the beginning — the extra runs buy validity, not just confidence.
//
// 2. Rounds are the outer loop, not devices. Looping devices first would mean
//    every device-A sample is taken early and every device-B sample late, so
//    any slow environmental change (a warming crystal, a room filling with
//    noise) shows up as a fake difference between A and B. Interleaving
//    spreads that systematically.
//
// 3. A device is measured against a reference only when they differ. Measuring
//    a device against itself is a useful zero-check, so it is offered
//    explicitly rather than silently produced by the cross product.
//
// The result is rounds x references x (1 reference run + N device runs).

/**
 * @param {{references: Array<{id, label}>, devices: Array<{id, label}>,
 *          rounds: number, includeSelfCheck?: boolean}} spec
 * @returns {Array<{index, round, refId, refLabel, kind, deviceId, deviceLabel}>}
 */
export function buildBatchPlan({references, devices, rounds, includeSelfCheck = false}) {
  if (!references?.length) throw new Error('buildBatchPlan: pick at least one reference');
  if (!devices?.length) throw new Error('buildBatchPlan: pick at least one device to test');
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('buildBatchPlan: rounds must be a positive integer');

  const steps = [];
  for (let round = 1; round <= rounds; round++) {
    for (const ref of references) {
      const targets = devices.filter((d) => includeSelfCheck || d.id !== ref.id);
      // A reference run with nothing to compare against is wasted time.
      if (!targets.length) continue;

      steps.push({
        index: steps.length, round, kind: 'ref',
        refId: ref.id, refLabel: ref.label,
        deviceId: ref.id, deviceLabel: ref.label,
      });
      for (const d of targets) {
        steps.push({
          index: steps.length, round, kind: 'dut',
          refId: ref.id, refLabel: ref.label,
          deviceId: d.id, deviceLabel: d.label,
        });
      }
    }
  }
  return steps;
}

/** Rough wall-clock estimate, so the UI can warn before a 20-minute run. */
export function estimateBatchSeconds(steps, perMeasurementSec = 7) {
  return Math.round(steps.length * perMeasurementSec);
}

/**
 * Collapse per-round deltas into one row per (reference, device) pair.
 * Uses median/MAD rather than mean/stddev: a single bad round should move the
 * headline number as little as possible.
 */
export function summariseBatch(results, {median, mad}) {
  const byPair = new Map();
  for (const r of results) {
    if (r.deltaMs == null) continue;
    const key = `${r.refLabel} → ${r.deviceLabel}`;
    if (!byPair.has(key)) {
      byPair.set(key, {key, refLabel: r.refLabel, deviceLabel: r.deviceLabel, deltas: [], rounds: [], drifts: []});
    }
    const row = byPair.get(key);
    row.deltas.push(r.deltaMs);
    row.rounds.push(r.round);
    if (r.driftMsPerSec != null) row.drifts.push(r.driftMsPerSec);
  }

  return [...byPair.values()].map((row) => {
    const m = median(row.deltas);
    return {
      ...row,
      n: row.deltas.length,
      medianMs: m,
      madMs: mad(row.deltas),
      minMs: Math.min(...row.deltas),
      maxMs: Math.max(...row.deltas),
      rangeMs: Math.max(...row.deltas) - Math.min(...row.deltas),
      medianDriftMsPerSec: row.drifts.length ? median(row.drifts) : null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}
