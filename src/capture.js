// Browser plumbing: open the mic raw, emit the stimulus, capture it back
// frame-aligned. All DSP lives in engine.js; live metering lives in meter.js.

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

/**
 * Chrome injects "default" and "communications" pseudo-devices alongside the
 * real device ID for whichever device the OS currently defaults to. They
 * point at the same hardware, but setSinkId() does not always route them
 * through the same internal path — targeting the real ID can force a fresh
 * dedicated output stream where "default" reuses one already open, adding a
 * real, consistent extra delay that has nothing to do with the hardware.
 * Comparing a reference measured through "Default - X" against the same
 * physical X measured by its real ID will show a phantom offset. Filtering
 * these out means every measurement in a session addresses the same device
 * the same way.
 */
const isAliasDevice = (d) => d.deviceId === 'default' || d.deviceId === 'communications';

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput' && !isAliasDevice(d)),
    outputs: all.filter((d) => d.kind === 'audiooutput' && !isAliasDevice(d)),
  };
}

export function canSwitchOutput() {
  return typeof AudioContext !== 'undefined' &&
    typeof AudioContext.prototype.setSinkId === 'function';
}

/**
 * 'granted' | 'denied' | 'prompt' | 'unsupported'.
 * Firefox doesn't implement the 'microphone' permission name and throws —
 * treat that the same as "can't tell", which means falling back to asking
 * for an explicit click rather than firing getUserMedia unprompted.
 */
export async function micPermissionState() {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const status = await navigator.permissions.query({name: 'microphone'});
    return status.state;
  } catch {
    return 'unsupported';
  }
}

/** Fires on any input/output plug/unplug, including Bluetooth connect/disconnect. */
export function watchDeviceChanges(cb) {
  navigator.mediaDevices.addEventListener('devicechange', cb);
  return () => navigator.mediaDevices.removeEventListener('devicechange', cb);
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
/**
 * Run one capture. If `stimulus` is given it is emitted by the worklet itself, so the
 * emission frame and the capture frames come from the same counter (see
 * recorder-worklet.js for why that matters). Returns the raw capture plus the exact
 * emission frame.
 */
async function record(ctx, stream, seconds, stimulus = null, onDiag = null) {
  await ensureWorklet(ctx);
  if (ctx.state !== 'running') {
    throw new Error(`AudioContext is "${ctx.state}", not running — audio cannot play or be captured`);
  }

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const chunks = [];
  const frameStamps = [];
  let firstFrame = null;
  let stats = null;
  let resolveFlush = null;
  const flushDone = new Promise((res) => { resolveFlush = res; });

  node.port.onmessage = (e) => {
    if (e.data.done) { stats = e.data; resolveFlush(); return; }
    if (firstFrame === null) firstFrame = e.data.startFrame;
    frameStamps.push({at: e.data.startFrame, len: e.data.chunk.length});
    chunks.push(e.data.chunk);
  };

  src.connect(node);
  node.connect(ctx.destination);

  // Let the graph settle before emitting, so the first sweep is not landing during
  // stream start-up. The worklet stamps the real emission frame regardless, but a
  // sweep played into a still-spinning-up output is wasted either way.
  await new Promise((r) => setTimeout(r, 200));
  if (stimulus) node.port.postMessage({stimulus}, [stimulus.buffer]);

  await new Promise((r) => setTimeout(r, seconds * 1000));

  // Ask for the partial buffer before tearing anything down; without this, up to
  // 4096 samples (~85 ms) of the tail were silently dropped.
  node.port.postMessage('flush');
  await Promise.race([flushDone, new Promise((r) => setTimeout(r, 250))]);

  node.port.onmessage = null;
  src.disconnect();
  node.disconnect();

  let total = 0;
  for (const c of chunks) total += c.length;
  const samples = new Float32Array(total);
  let p = 0;
  for (const c of chunks) { samples.set(c, p); p += c.length; }

  // Concatenating chunks assumes the worklet saw every render quantum. If the audio
  // thread ever glitched, the stamps are not contiguous and every sample after the gap
  // is misaligned — which would corrupt the delay silently. Detect rather than trust.
  let droppedFrames = 0;
  for (let i = 1; i < frameStamps.length; i++) {
    const expected = frameStamps[i - 1].at + frameStamps[i - 1].len;
    droppedFrames += Math.max(0, frameStamps[i].at - expected);
  }

  const emitFrame = stats?.emitFrame ?? null;
  if (onDiag) {
    onDiag({
      capturedSamples: total,
      capturedSec: +(total / ctx.sampleRate).toFixed(3),
      firstFrame: firstFrame ?? 0,
      emitFrame,
      alignOffset: emitFrame != null && firstFrame != null ? emitFrame - firstFrame : null,
      droppedFrames,
      emitCompleted: stats?.emitDone ?? null,
      silentBlocks: stats?.silentBlocks ?? null,
      totalBlocks: stats?.totalBlocks ?? null,
      flushAcknowledged: stats != null,
    });
  }

  return {samples, firstFrame: firstFrame ?? 0, emitFrame, droppedFrames, stats};
}

/**
 * One full measurement against whatever the AudioContext is currently routed to.
 */
export async function measureOnce(ctx, stream, opts = DEFAULTS, onDiag = null) {
  const o = {...DEFAULTS, ...opts};
  const stimulus = makeStimulus(ctx.sampleRate, o);

  // Tail generously past the stimulus: the last sweep still has to travel out, through
  // the device, and back before the capture stops. 0.2s of that is the settle wait.
  const durationSec = 0.2 + stimulus.durationSec + 0.4;
  if (onDiag) {
    onDiag('stimulus', {
      sampleRate: ctx.sampleRate,
      repeats: o.repeats, sweepMs: o.sweepSec * 1000,
      gapMs: [o.gapMinSec * 1000, o.gapMaxSec * 1000],
      maxLagMs: o.maxLagSec * 1000, warmup: o.warmup,
      stimulusSec: +stimulus.durationSec.toFixed(2),
      captureSec: +durationSec.toFixed(2),
      baseLatencyMs: +((ctx.baseLatency ?? 0) * 1000).toFixed(2),
      outputLatencyMs: +((ctx.outputLatency ?? 0) * 1000).toFixed(2),
    });
  }

  // The worklet takes ownership of the buffer, so hand it a copy — `stimulus.signal`
  // is still needed here for the correlation reference.
  const toEmit = new Float32Array(stimulus.signal);
  const cap = await record(ctx, stream, durationSec, toEmit,
    onDiag ? (d) => onDiag('capture', d) : null);

  if (cap.emitFrame == null) {
    return {
      ok: false, reason: 'the worklet never emitted the stimulus', delays: [], rejected: [],
      hint: 'The audio output may have failed to start. Try again, or reselect the device.',
      droppedFrames: cap.droppedFrames, sampleRate: ctx.sampleRate,
    };
  }

  // Exact alignment: both frames come from the audio thread's own counter.
  const offset = cap.emitFrame - cap.firstFrame;
  const aligned = offset >= 0 && offset < cap.samples.length
    ? cap.samples.subarray(offset)
    : cap.samples;

  if (onDiag && !(offset >= 0 && offset < cap.samples.length)) {
    onDiag('align', {
      problem: 'emission frame fell outside the capture; using the untrimmed recording',
      offset, capturedSamples: cap.samples.length,
    });
  }

  const result = measure(aligned, stimulus, o);
  return {
    ...result,
    capturedSamples: aligned.length,
    sampleRate: ctx.sampleRate,
    droppedFrames: cap.droppedFrames,
  };
}
