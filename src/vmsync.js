// Working out what to put in Voicemeeter's per-bus delay so several outputs
// emit at the same instant.
//
// The physical situation: one source (a strip) feeds two or three buses at
// once — say Bluetooth speakers, an HDMI monitor and the laptop's own
// speakers. Each bus has its own latency, and Bluetooth's is far the largest,
// so the wired outputs are heard first and the room sounds smeared.
//
// Voicemeeter cannot make a slow device faster. The only lever is
// `Option.delay[i]`, which *adds* delay to a bus. So everything has to be
// dragged back to whichever bus is already slowest: that one gets no extra
// delay and every other bus gets the difference. After that all buses emit
// together, and the whole group is late by the slowest device's latency —
// which is then the single figure to give the media player.

/** Voicemeeter's Option.delay range. Beyond this the API silently clamps. */
export const MAX_BUS_DELAY_MS = 500;

/**
 * @param {Array<{busIndex:number, label?:string, latencyMs:number}>} measured
 * @returns {{
 *   anchorIndex:number, anchorLatencyMs:number, spreadMs:number,
 *   plan:Array<{busIndex:number,label?:string,latencyMs:number,delayMs:number,clamped:boolean}>,
 *   residualMs:number, warnings:string[]
 * }}
 */
export function solveBusDelays(measured) {
  const rows = (measured || []).filter((m) => Number.isFinite(m?.latencyMs));
  if (rows.length < 2) {
    throw new Error('solveBusDelays: need at least two measured buses to align');
  }

  // The slowest bus is the anchor: it is the one we cannot speed up.
  let anchor = rows[0];
  for (const r of rows) if (r.latencyMs > anchor.latencyMs) anchor = r;

  const warnings = [];
  const plan = rows.map((r) => {
    const want = anchor.latencyMs - r.latencyMs;
    const delayMs = Math.max(0, Math.min(MAX_BUS_DELAY_MS, Math.round(want)));
    const clamped = Math.round(want) !== delayMs;
    if (clamped) {
      warnings.push(
        `${r.label || `bus ${r.busIndex}`} needs ${Math.round(want)} ms but Voicemeeter caps ` +
        `Option.delay at ${MAX_BUS_DELAY_MS} ms; it will still lead by ` +
        `${Math.round(want) - delayMs} ms.`);
    }
    return {busIndex: r.busIndex, label: r.label, latencyMs: r.latencyMs, delayMs, clamped};
  });

  // What the group's alignment will actually be once the plan is applied —
  // rounding to whole ms plus any clamping, not an assumed zero.
  const aligned = plan.map((p) => {
    const src = rows.find((r) => r.busIndex === p.busIndex);
    return src.latencyMs + p.delayMs;
  });
  const residualMs = Math.max(...aligned) - Math.min(...aligned);

  const latencies = rows.map((r) => r.latencyMs);
  return {
    anchorIndex: anchor.busIndex,
    anchorLatencyMs: anchor.latencyMs,
    spreadMs: Math.max(...latencies) - Math.min(...latencies),
    plan,
    residualMs,
    warnings,
  };
}

/**
 * Every non-empty combination of the selected buses, singles first then wider
 * groups. Singles are what the solver needs (a latency per bus, measured
 * alone so nothing else is sounding); the multi-bus entries are the
 * verification pass — with the delays applied, a group that is genuinely
 * aligned collapses to one arrival instead of several.
 */
export function busCombinations(busIndices) {
  const ids = [...new Set(busIndices || [])].sort((a, b) => a - b);
  if (!ids.length) return [];
  const out = [];
  for (let mask = 1; mask < (1 << ids.length); mask++) {
    const combo = ids.filter((_, i) => mask & (1 << i));
    out.push(combo);
  }
  return out.sort((a, b) => a.length - b.length || a[0] - b[0]);
}

/**
 * Turns a bus combination into the A-flag vector the routing endpoint wants.
 * Length must match the strip's own A vector: Banana reports five buses but
 * only three of them are A-buses, and asking it to set A4 fails the whole call.
 */
export function routeFlagsFor(combo, aBusCount) {
  return Array.from({length: aBusCount}, (_, i) => combo.includes(i));
}

/**
 * The offset for the media player once the buses are aligned. The group now
 * emits together, all of it late by the anchor's latency, so the player has to
 * advance the audio by that much — minus the reference path the measurement
 * was taken against, which cancels the microphone and capture chain.
 */
export function playerOffsetForGroup(anchorLatencyMs, referenceLatencyMs) {
  return anchorLatencyMs - referenceLatencyMs;
}
