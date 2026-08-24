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

/** Tracks a canvas's backing-store size against its CSS size (devicePixelRatio-aware). */
function canvasTracker(canvas) {
  let cctx = null, dpr = 1;
  return {
    ensure() {
      if (!canvas) return false;
      const d = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * d);
      const h = Math.round(canvas.clientHeight * d);
      if (w === 0 || h === 0) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; dpr = d; // resizing clears the canvas
        cctx = canvas.getContext('2d');
      }
      return true;
    },
    get ctx() { return cctx; },
    get dpr() { return dpr; },
  };
}

/**
 * Continuous input meter with two live views, independent of the recorder
 * worklet so they can run at all times without competing with a measurement.
 *
 * `waveCanvas` — the instantaneous waveform, redrawn from scratch every
 * frame. This is the one to look at for *shape*: is the signal clipping
 * flat-topped, is it just room hiss with no real content, is it there at
 * all right now. It has no memory — blink and you miss a brief burst.
 *
 * `stripCanvas` — a scrolling amplitude-history strip, the same idea as a
 * DAW input meter or Audacity's recording view: each instant becomes a thin
 * column at the right edge and the past scrolls left, so the last few
 * seconds stay visible. This is the one for *when*: did a repeat's burst
 * actually arrive, how many, how far apart. Implemented as one `drawImage`
 * of the canvas onto itself shifted left plus one new column per frame —
 * cheap, no history array to maintain.
 *
 * Together they answer the two different questions a raw waveform alone
 * can't: "what does this sound like" and "did anything happen a moment ago."
 *
 * Returns a stop() that tears down the analyser and cancels the animation loop.
 */
export function attachLiveMeter(ctx, stream, {onLevel, waveCanvas, stripCanvas} = {}) {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // Deliberately little smoothing: a repeat is a ~40ms burst, and heavy
  // smoothing would blur it into the noise floor before it's visible.
  analyser.smoothingTimeConstant = 0.3;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const wave = canvasTracker(waveCanvas);
  const strip = canvasTracker(stripCanvas);

  function drawWave() {
    if (!wave.ensure()) return;
    const c = wave.ctx, w = waveCanvas.width, h = waveCanvas.height, dpr = wave.dpr;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,.07)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();

    c.beginPath();
    c.strokeStyle = '#35e0c0';
    c.lineWidth = 1.6 * dpr;
    c.shadowColor = '#35e0c0';
    c.shadowBlur = 5 * dpr;
    const step = w / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const x = i * step, y = h / 2 - buf[i] * (h / 2) * 0.9;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    c.shadowBlur = 0;
  }

  const HISTORY_SEC = 5;
  function drawStrip(dtMs, peakDb, rmsDb) {
    if (!strip.ensure()) return;
    const c = strip.ctx, w = stripCanvas.width, h = stripCanvas.height, mid = h / 2, dpr = strip.dpr;
    const shift = Math.max(1, Math.min(w, (w / HISTORY_SEC) * (dtMs / 1000)));

    c.drawImage(stripCanvas, shift, 0, w - shift, h, 0, 0, w - shift, h);
    c.clearRect(w - shift, 0, shift, h);

    c.strokeStyle = 'rgba(255,255,255,.07)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(w - shift, mid); c.lineTo(w, mid); c.stroke();

    const frac = (db) => Math.max(0, Math.min(1, (db + 60) / 60));
    const color = peakDb > -3 ? '#ff6b6b' : peakDb < -45 ? '#3d434e' : '#35e0c0';
    const rmsH = frac(rmsDb) * mid;
    const peakH = frac(peakDb) * mid;
    const tickPx = Math.max(1, 1.5 * dpr);

    c.fillStyle = color;
    c.globalAlpha = 0.55;
    c.fillRect(w - shift, mid - rmsH, shift, rmsH * 2);
    c.globalAlpha = 1;
    c.fillRect(w - shift, mid - peakH, shift, tickPx);
    c.fillRect(w - shift, mid + peakH - tickPx, shift, tickPx);
  }

  let raf = null, lastT = null;
  const tick = (t) => {
    const dtMs = lastT == null ? 16 : Math.min(100, t - lastT);
    lastT = t;
    analyser.getFloatTimeDomainData(buf);
    let peak = 0, sum = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    const peakDb = 20 * Math.log10(peak || 1e-9);
    const rmsDb = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9);
    if (onLevel) onLevel({peakDb, rmsDb});
    drawWave();
    drawStrip(dtMs, peakDb, rmsDb);
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
