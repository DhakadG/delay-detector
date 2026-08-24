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

/**
 * Continuous input meter + oscilloscope, independent of the recorder
 * worklet, so it can run at all times without competing with a measurement.
 * `canvas`, if given, gets a live time-domain waveform drawn onto it every
 * frame — this is the one place to actually see whether the mic is picking
 * up anything at all, which is the first thing to check when a device (in
 * particular in-ear buds, which barely leak sound into the room) produces
 * unreliable readings.
 * Returns a stop() that tears down the analyser and cancels the animation loop.
 */
export function attachLiveMeter(ctx, stream, {onLevel, canvas} = {}) {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let cctx = null, dpr = 1;
  function ensureCanvasSize() {
    const d = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * d);
    const h = Math.round(canvas.clientHeight * d);
    if (w === 0 || h === 0) return false;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; dpr = d;
      cctx = canvas.getContext('2d');
    }
    return true;
  }

  function drawScope() {
    if (!canvas || !ensureCanvasSize()) return;
    const w = canvas.width, h = canvas.height;
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = 'rgba(255,255,255,.08)';
    cctx.lineWidth = 1;
    cctx.beginPath(); cctx.moveTo(0, h / 2); cctx.lineTo(w, h / 2); cctx.stroke();

    cctx.beginPath();
    cctx.strokeStyle = '#35e0c0';
    cctx.lineWidth = 1.6 * dpr;
    cctx.shadowColor = '#35e0c0';
    cctx.shadowBlur = 6 * dpr;
    const step = w / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const x = i * step, y = h / 2 - buf[i] * (h / 2) * 0.9;
      if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
    }
    cctx.stroke();
    cctx.shadowBlur = 0;
  }

  let raf = null;
  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    if (onLevel) {
      let peak = 0, sum = 0;
      for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
      onLevel({peakDb: 20 * Math.log10(peak || 1e-9), rmsDb: 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9)});
    }
    drawScope();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    src.disconnect();
    analyser.disconnect();
  };
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
