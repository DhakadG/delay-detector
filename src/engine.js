// Core DSP. Pure math, no Web Audio, no DOM — so it runs unchanged in Node
// and is testable without hardware. See docs/METHOD.md for the why.

export const SPEED_OF_SOUND = 343; // m/s at 20 C

export const DEFAULTS = {
  f0: 500,           // Hz. Below ~300 Hz earbuds and laptop speakers roll off.
  f1: 8000,          // Hz. Above ~10 kHz lossy BT codecs low-pass hard.
  sweepSec: 0.04,
  repeats: 8,
  gapMinSec: 0.15,
  gapMaxSec: 0.30,
  maxLagSec: 0.6,    // widest plausible output-path delay
  amplitude: 0.25,   // about -12 dBFS
  minPeakQualityDb: 18,
  maxSpreadMs: 3,
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
  const sweep = makeSweep(sampleRate, o);
  const offsets = [];
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < o.repeats; i++) {
    offsets.push(cursor);
    chunks.push(sweep);
    cursor += sweep.length;
    const gap = Math.round(
      (o.gapMinSec + rand() * (o.gapMaxSec - o.gapMinSec)) * sampleRate);
    chunks.push(new Float32Array(gap));
    cursor += gap;
  }
  // tail long enough for the last sweep to land inside the recording
  cursor += Math.round(o.maxLagSec * sampleRate);
  const signal = new Float32Array(cursor);
  let p = 0;
  for (const c of chunks) { signal.set(c, p); p += c.length; }
  return {signal, offsets, sweep, sampleRate};
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

  const delays = [], qualities = [], rejected = [];
  for (const off of offsets) {
    const hit = pickArrival(c, off, off + maxLagSamples, sweep.length, o);
    if (!hit) { rejected.push({offset: off, reason: 'no peak'}); continue; }
    if (hit.qualityDb < o.minPeakQualityDb) {
      rejected.push({offset: off, reason: 'low peak quality', qualityDb: hit.qualityDb});
      continue;
    }
    delays.push(((hit.index - off) / sampleRate) * 1000);
    qualities.push(hit.qualityDb);
  }

  if (delays.length < 3) {
    return {
      ok: false, reason: 'too few usable repeats', delays, rejected,
      hint: 'Raise the volume, move the mic closer, or check echo cancellation is off.',
    };
  }
  const delayMs = median(delays);
  const spreadMs = mad(delays);
  const ok = spreadMs <= o.maxSpreadMs;
  return {
    ok, delayMs, spreadMs, usedRepeats: delays.length,
    qualityDb: median(qualities), delays, rejected,
    reason: ok ? null : 'inconsistent repeats — unstable link or the mic moved',
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
