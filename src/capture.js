// Browser plumbing: open the mic raw, play the stimulus, capture it back
// frame-aligned. All DSP lives in engine.js.

import {makeStimulus, measure, DEFAULTS} from './engine.js';

/**
 * Open the microphone with every browser DSP disabled.
 * Echo cancellation is the single biggest failure mode here: left on, it will
 * happily cancel our own test signal and the measurement silently returns junk.
 */
export async function openMic(deviceId) {
  const constraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? {deviceId: {exact: deviceId}} : {}),
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const warnings = [];
  for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    // undefined means "not reported"; only true is an actual problem
    if (settings[k] === true) warnings.push(k);
  }
  return {stream, track, settings, warnings};
}

/** Identity of the input chain, so we can prove it did not change mid-session. */
export function inputFingerprint(settings) {
  return `${settings.deviceId || '?'}|${settings.groupId || '?'}|${settings.sampleRate || '?'}`;
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export function canSwitchOutput() {
  return typeof AudioContext !== 'undefined' &&
    typeof AudioContext.prototype.setSinkId === 'function';
}

/** Peak and RMS of a short capture, for the pre-flight level check. */
export async function levelCheck(ctx, stream, seconds = 0.5) {
  const rec = await record(ctx, stream, seconds);
  let peak = 0, sum = 0;
  for (const v of rec.samples) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  const rms = Math.sqrt(sum / (rec.samples.length || 1));
  return {peak, rms, peakDb: 20 * Math.log10(peak || 1e-9), rmsDb: 20 * Math.log10(rms || 1e-9)};
}

let workletReady = null;
async function ensureWorklet(ctx) {
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
  }
  return workletReady;
}

/**
 * Record for `seconds`, optionally starting playback of `stimulusBuffer` at a
 * known frame. Returns the capture plus the frame at which playback began, so
 * the caller can trim to exact alignment.
 */
async function record(ctx, stream, seconds, stimulusBuffer = null, leadSec = 0.2) {
  await ensureWorklet(ctx);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder', {numberOfOutputs: 0});

  const chunks = [];
  let firstFrame = null;
  node.port.onmessage = (e) => {
    if (firstFrame === null) firstFrame = e.data.startFrame;
    chunks.push(e.data.chunk);
  };
  src.connect(node);

  let playFrame = null;
  let player = null;
  if (stimulusBuffer) {
    const startTime = ctx.currentTime + leadSec;
    player = ctx.createBufferSource();
    player.buffer = stimulusBuffer;
    player.connect(ctx.destination);
    player.start(startTime);
    playFrame = Math.round(startTime * ctx.sampleRate);
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));
  try { player && player.stop(); } catch { /* already ended */ }
  src.disconnect();
  node.port.onmessage = null;
  node.disconnect();

  let total = 0;
  for (const c of chunks) total += c.length;
  const samples = new Float32Array(total);
  let p = 0;
  for (const c of chunks) { samples.set(c, p); p += c.length; }
  return {samples, firstFrame: firstFrame ?? 0, playFrame};
}

/**
 * One full measurement against whatever the AudioContext is currently
 * routed to. Returns the engine result plus the raw capture for debugging.
 */
export async function measureOnce(ctx, stream, opts = DEFAULTS) {
  const o = {...DEFAULTS, ...opts};
  const stimulus = makeStimulus(ctx.sampleRate, o);

  const buffer = ctx.createBuffer(1, stimulus.signal.length, ctx.sampleRate);
  buffer.copyToChannel(stimulus.signal, 0);

  const leadSec = 0.2;
  const durationSec = leadSec + stimulus.signal.length / ctx.sampleRate + 0.3;
  const cap = await record(ctx, stream, durationSec, buffer, leadSec);

  // Align capture sample 0 with stimulus sample 0.
  const offset = cap.playFrame - cap.firstFrame;
  const aligned = offset >= 0 && offset < cap.samples.length
    ? cap.samples.subarray(offset)
    : cap.samples;

  const result = measure(aligned, stimulus, o);
  return {...result, capturedSamples: aligned.length, sampleRate: ctx.sampleRate};
}
