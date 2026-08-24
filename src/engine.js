// Core DSP. Pure math, no Web Audio, no DOM — so it runs unchanged in Node
// and is testable without hardware. See docs/METHOD.md for the why.

export const SPEED_OF_SOUND = 343; // m/s at 20 C

export const DEFAULTS = {
  f0: 500,           // Hz. Below ~300 Hz earbuds and laptop speakers roll off.
  f1: 8000,          // Hz. Above ~10 kHz lossy BT codecs low-pass hard.
  sweepSec: 0.04,
  repeats: 6,
  // INVARIANT: gapMinSec MUST exceed maxLagSec + sweepSec. Enforced in
  // makeStimulus() — see the comment there for what breaks otherwise.
  gapMinSec: 0.65,
  gapMaxSec: 0.75,
  maxLagSec: 0.55,   // widest plausible output-path delay
  warmup: true,      // throwaway leading sweep, see makeStimulus()
  amplitude: 0.25,   // about -12 dBFS
  minPeakQualityDb: 18,
  maxSpreadMs: 5,       // jitter about the trend; matches the ~5ms error budget in docs/RESEARCH.md
  maxDriftMsPerSec: 2,  // beyond this the device clock has not settled
  firstPeakFrac: 0.7,
};

/** Hann-tapered linear sweep f0 -> f1. The matched-filter reference. */
export function makeSweep(sampleRate, opts = DEFAULTS) {
  const o = {...DEFAULTS, ...opts};
  const n = Math.round(o.sweepSec * sampleRate);
  const out = new Float32Array(n);
  const k = (o.f1 - o.f0) / o.sweepSec;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (o.f0 * t + 0.5 * k * t * t);
    // Hann taper over the whole sweep: no click at either edge.
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    out[i] = o.amplitude * w * Math.sin(phase);
  }
  return out;
}

/**
 * Stimulus: `repeats` sweeps separated by randomised gaps. Randomised so a
 * room resonance or periodic interferer cannot phase-lock to the rhythm.
 * Returns the buffer and the sample offset at which each sweep starts.
 */
export function makeStimulus(sampleRate, opts = DEFAULTS, rand = Math.random) {
  const o = {...DEFAULTS, ...opts};

  // Every gap MUST be longer than the widest delay we search for, or sweeps
  // alias onto each other. If gap < delay, sweep N-1's arrival lands inside
  // sweep N's search window at lag (delay - gap) — EARLIER than sweep N's own
  // arrival at lag `delay`. pickArrival() then correctly takes the earliest
  // peak and gets the wrong sweep, every repeat, in perfect agreement. The
  // result is a confident answer with a near-zero spread that is simply
  // false (a 10 ms "round trip" through HDMI, an output measuring *ahead* of
  // a wired reference), and since gaps are randomised it lands somewhere new
  // on every run. Thrown rather than documented because the failure mode
  // looks exactly like success.
  //
  // An inverted range makes randomGap() produce negative gaps, which would
  // silently overlap sweeps rather than separate them.
  if (o.gapMaxSec < o.gapMinSec) {
    throw new Error(
      `makeStimulus: gapMaxSec (${o.gapMaxSec}s) must be at least gapMinSec (${o.gapMinSec}s)`);
  }
  const minGapNeeded = o.maxLagSec + o.sweepSec;
  if (o.gapMinSec <= minGapNeeded) {
    throw new Error(
      `makeStimulus: gapMinSec (${o.gapMinSec}s) must exceed maxLagSec + sweepSec ` +
      `(${minGapNeeded.toFixed(3)}s), otherwise consecutive sweeps alias onto each other`);
  }

  const sweep = makeSweep(sampleRate, o);
  const randomGap = () => Math.round(
    (o.gapMinSec + rand() * (o.gapMaxSec - o.gapMinSec)) * sampleRate);

  const offsets = [];
  const chunks = [];
  let cursor = 0;

  // A throwaway leading sweep, deliberately absent from `offsets` so it is
  // never measured. Bluetooth links and some OS mixers power the output path
  // down when idle and take a few hundred ms to spin back up, mangling
  // whichever sweep happens to go first. Burning one sweep to wake the path
  // is cheaper than losing a real repeat to it.
  if (o.warmup) {
    chunks.push(sweep);
    cursor += sweep.length;
    const g = randomGap();
    chunks.push(new Float32Array(g));
    cursor += g;
  }

  for (let i = 0; i < o.repeats; i++) {
    offsets.push(cursor);
    chunks.push(sweep);
    cursor += sweep.length;
    // The trailing gap after the final sweep doubles as the recording tail:
    // it exceeds maxLagSec by the invariant above, so the last arrival is
    // always inside the capture.
    const g = randomGap();
    chunks.push(new Float32Array(g));
    cursor += g;
  }

  const signal = new Float32Array(cursor);
  let p = 0;
  for (const c of chunks) { signal.set(c, p); p += c.length; }
  return {signal, offsets, sweep, sampleRate, durationSec: cursor / sampleRate};
}

/**
 * Normalised cross-correlation of `rec` against `ref`, for lags [0, maxLag].
 * ponytail: direct O(N*M). ~180M MAC for a 2 s capture at 48 kHz, well under a
 * second in JS. Swap in an FFT overlap-save only if that ever becomes the
 * bottleneck — it currently costs less than making the recording.
 */
export function correlate(rec, ref, maxLag) {
  const m = ref.length;
  const lastLag = Math.min(maxLag, rec.length - m);
  const out = new Float32Array(Math.max(0, lastLag + 1));
  let refEnergy = 0;
  for (let k = 0; k < m; k++) refEnergy += ref[k] * ref[k];
  if (refEnergy === 0 || lastLag < 0) return out;

  // sliding window energy of rec, so normalisation is O(1) per lag
  let winEnergy = 0;
  for (let k = 0; k < m; k++) winEnergy += rec[k] * rec[k];

  for (let lag = 0; lag <= lastLag; lag++) {
    let dot = 0;
    for (let k = 0; k < m; k++) dot += rec[lag + k] * ref[k];
    const denom = Math.sqrt(winEnergy * refEnergy);
    out[lag] = denom > 0 ? dot / denom : 0;
    const add = lag + m < rec.length ? rec[lag + m] : 0;
    winEnergy += add * add - rec[lag] * rec[lag];
    if (winEnergy < 0) winEnergy = 0; // float drift guard
  }
  return out;
}

/** Parabolic interpolation around index i. Fractional offset in [-1, 1]. */
function subSample(c, i) {
  if (i <= 0 || i >= c.length - 1) return 0;
  const a = Math.abs(c[i - 1]), b = Math.abs(c[i]), d = Math.abs(c[i + 1]);
  const denom = a - 2 * b + d;
  if (denom === 0) return 0;
  const frac = (0.5 * (a - d)) / denom;
  return Math.abs(frac) <= 1 ? frac : 0;
}

/**
 * Pick the arrival within [from, to) of a correlation array.
 * First-peak rule: earliest crest above firstPeakFrac * globalMax, NOT the
 * global max. A strong reflection can out-amplitude the direct sound; it can
 * never arrive before it.
 */
export function pickArrival(c, from, to, refLen, opts = DEFAULTS) {
  const o = {...DEFAULTS, ...opts};
  const hi = Math.min(to, c.length);
  if (from >= hi) return null;

  let max = 0;
  for (let i = from; i < hi; i++) if (Math.abs(c[i]) > max) max = Math.abs(c[i]);
  if (max === 0) return null;

  const thresh = o.firstPeakFrac * max;
  let peak = -1;
  for (let i = from; i < hi; i++) {
    if (Math.abs(c[i]) >= thresh) {
      // walk to the local crest so parabolic interpolation is meaningful
      let j = i;
      while (j + 1 < hi && Math.abs(c[j + 1]) > Math.abs(c[j])) j++;
      peak = j;
      break;
    }
  }
  if (peak < 0) return null;

  // quality = peak vs RMS of everything else in the window, excluding the
  // mainlobe (one reference length either side of the peak)
  let sum = 0, n = 0;
  for (let i = from; i < hi; i++) {
    if (Math.abs(i - peak) <= refLen) continue;
    sum += c[i] * c[i]; n++;
  }
  const noiseRms = n > 0 ? Math.sqrt(sum / n) : 0;
  const qualityDb = noiseRms > 0
    ? 20 * Math.log10(Math.abs(c[peak]) / noiseRms)
    : Infinity;

  return {index: peak + subSample(c, peak), qualityDb};
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation — robust spread, unlike stddev with outliers. */
export function mad(xs) {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Ordinary least-squares fit of ys against xs. */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return {slope: 0, intercept: ys[0] ?? 0};
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const det = n * sxx - sx * sx;
  if (det === 0) return {slope: 0, intercept: sy / n};
  const slope = (n * sxy - sx * sy) / det;
  return {slope, intercept: (sy - slope * sx) / n};
}

/**
 * One measurement run. `rec` is the microphone capture, aligned so sample 0
 * corresponds to sample 0 of the stimulus that was played.
 * Returns round-trip delay in ms, its spread, and whether to trust it.
 */
export function measure(rec, stimulus, opts = DEFAULTS) {
  const o = {...DEFAULTS, ...opts};
  const {sweep, offsets, sampleRate} = stimulus;
  const maxLagSamples = Math.round(o.maxLagSec * sampleRate);
  const c = correlate(rec, sweep, offsets[offsets.length - 1] + maxLagSamples);

  const hits = [], rejected = [];
  for (const off of offsets) {
    const hit = pickArrival(c, off, off + maxLagSamples, sweep.length, o);
    if (!hit) { rejected.push({offset: off, reason: 'no peak'}); continue; }
    if (hit.qualityDb < o.minPeakQualityDb) {
      rejected.push({offset: off, reason: 'low peak quality', qualityDb: hit.qualityDb});
      continue;
    }
    hits.push({
      tSec: off / sampleRate,                              // when this sweep was emitted
      delayMs: ((hit.index - off) / sampleRate) * 1000,
      qualityDb: hit.qualityDb,
    });
  }

  if (hits.length < 3) {
    return {
      ok: false, reason: 'too few usable repeats', delays: hits.map((h) => h.delayMs), rejected,
      hint: 'Raise the volume, move the mic closer, or check echo cancellation is off.',
    };
  }

  // Coarse pass: drop gross outliers (a reflection or noise burst that still
  // cleared the quality bar) relative to the raw median, before any fitting,
  // so one wild value cannot drag the trend line with it.
  const rawMedian = median(hits.map((h) => h.delayMs));
  const coarseBound = Math.max(8, o.maxSpreadMs * 3);
  let kept = hits.filter((h) => Math.abs(h.delayMs - rawMedian) <= coarseBound);
  if (kept.length < 3) kept = hits;

  // Latency is not necessarily constant across a measurement. A Bluetooth
  // sink runs on its own crystal and resamples to match; for seconds after a
  // stream starts its buffer is still converging, so the delay ramps
  // monotonically. Averaging that ramp yields a number that describes no
  // instant in particular, and its spread reports the drift rather than the
  // measurement noise. Fit the trend explicitly instead: the slope is the
  // drift, and the scatter *about* the line is the real jitter.
  let fit = linearFit(kept.map((h) => h.tSec), kept.map((h) => h.delayMs));
  const residual = (h) => h.delayMs - (fit.intercept + fit.slope * h.tSec);

  // Fine pass: trim against the fitted line, so a genuinely drifting series
  // is not mistaken for a series full of outliers.
  const resMad = mad(kept.map(residual));
  const fineBound = Math.max(3, resMad * 3);
  const kept2 = kept.filter((h) => Math.abs(residual(h)) <= fineBound);
  if (kept2.length >= 3) { kept = kept2; fit = linearFit(kept.map((h) => h.tSec), kept.map((h) => h.delayMs)); }

  const delays = kept.map((h) => h.delayMs);
  const trimmedOutliers = hits.length - kept.length;

  const driftMsPerSec = fit.slope;
  const spanSec = kept[kept.length - 1].tSec - kept[0].tSec;
  const driftTotalMs = driftMsPerSec * spanSec;
  const drifting = Math.abs(driftMsPerSec) > o.maxDriftMsPerSec;

  // Jitter is the scatter about the trend — the honest measurement noise.
  const jitterMs = mad(kept.map(residual));
  // Raw spread, kept for continuity, but it conflates drift with noise.
  const spreadMs = mad(delays);
  // With a drifting device the most useful single value is where the trend
  // has reached by the end, not the mean of where it has been.
  const settledMs = fit.intercept + fit.slope * kept[kept.length - 1].tSec;

  const ok = jitterMs <= o.maxSpreadMs && !drifting;
  const reason = jitterMs > o.maxSpreadMs
    ? 'inconsistent repeats — unstable link, reflections, or the mic moved'
    : drifting
      ? `latency drifted ${driftTotalMs >= 0 ? '+' : ''}${driftTotalMs.toFixed(1)} ms across the run — the device clock has not settled`
      : null;

  return {
    ok, delayMs: median(delays), settledMs, spreadMs, jitterMs,
    driftMsPerSec, driftTotalMs, drifting,
    usedRepeats: delays.length, trimmedOutliers,
    qualityDb: median(kept.map((h) => h.qualityDb)),
    delays, rejected, reason,
  };
}

/**
 * The product. Differential: everything on the input side cancels, so what is
 * left is the extra delay the device under test adds over the reference.
 * Distances in metres are optional; they correct unequal mic placement.
 */
export function differential(refMs, dutMs, {refDistanceM = null, dutDistanceM = null} = {}) {
  let airCorrectionMs = 0;
  if (refDistanceM != null && dutDistanceM != null) {
    airCorrectionMs = ((dutDistanceM - refDistanceM) / SPEED_OF_SOUND) * 1000;
  }
  return {deltaMs: dutMs - refMs - airCorrectionMs, airCorrectionMs};
}

/**
 * Sign convention, decided once and tested.
 * deltaMs > 0 means the device's audio arrives LATE, so the player must play
 * audio EARLIER — a negative offset in every player below.
 */
export function playerOffsets(deltaMs) {
  const ms = Math.round(deltaMs);
  const sec = (-ms / 1000).toFixed(3);
  return {
    summary: ms >= 0
      ? `Audio arrives ${ms} ms late. Advance it by ${ms} ms.`
      : `Audio arrives ${-ms} ms early. Delay it by ${-ms} ms.`,
    vlc: `${-ms} ms`,
    mpv: `--audio-delay=${sec}`,
    plex: `${-ms} ms`,
    kodi: `${(-ms / 1000).toFixed(3)} s`,
    ffmpeg: `-itsoffset ${sec}`,
  };
}
