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

/** Keeps a canvas's backing store matched to its CSS size (devicePixelRatio-aware). */
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
        canvas.width = w; canvas.height = h; dpr = d;
        cctx = canvas.getContext('2d');
      }
      if (!cctx) cctx = canvas.getContext('2d');
      return true;
    },
    get ctx() { return cctx; },
    get dpr() { return dpr; },
  };
}

/**
 * Live input monitor: two views over one analyser.
 *
 *   waveCanvas  — the instantaneous waveform. Answers "what is arriving right
 *                 now": clipping, polarity, tone vs. hiss. Has no memory.
 *   stripCanvas — a scrolling amplitude history. Answers "did anything happen
 *                 a moment ago": during a measurement you should see one
 *                 distinct blob per sweep march leftwards across it.
 *
 * The strip keeps an explicit array of timestamped samples and repaints the
 * whole thing every frame, mapping each sample to an x by its real age. An
 * earlier version instead blitted the canvas onto itself shifted left by a
 * fractional pixel count each frame; that resamples already-resampled pixels
 * ~60 times a second, so the trace smeared, dimmed and drifted — cumulative
 * error with nothing to correct it, because the canvas was its own only
 * record of the past. Keeping the data and redrawing from it costs a few
 * hundred rects per frame and is exact at any framerate or DPR.
 */
export function attachLiveMeter(ctx, stream, {onLevel, waveCanvas, stripCanvas} = {}) {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // Deliberately little smoothing: a sweep is a ~40ms burst and heavy
  // smoothing would blur it into the noise floor before it became visible.
  analyser.smoothingTimeConstant = 0.3;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const wave = canvasTracker(waveCanvas);
  const strip = canvasTracker(stripCanvas);

  const HISTORY_MS = 6000;
  const history = [];        // {t, peakDb, rmsDb}, oldest first
  const marks = [];          // {t, label} measurement boundaries

  const DB_FLOOR = -60;
  const norm = (db) => Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
  const colorFor = (peakDb) => (peakDb > -3 ? '#ff6b6b' : peakDb < -45 ? '#3d434e' : '#35e0c0');

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
    const step = w / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const x = i * step, y = h / 2 - buf[i] * (h / 2) * 0.9;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  function drawStrip(now) {
    if (!strip.ensure()) return;
    const c = strip.ctx, w = stripCanvas.width, h = stripCanvas.height;
    const mid = h / 2, dpr = strip.dpr;
    c.clearRect(0, 0, w, h);

    // centre line + one gridline per second
    c.strokeStyle = 'rgba(255,255,255,.06)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
    for (let s = 1; s * 1000 < HISTORY_MS; s++) {
      const x = w - (s * 1000 / HISTORY_MS) * w;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }

    const xFor = (t) => w - ((now - t) / HISTORY_MS) * w;

    for (const m of marks) {
      const x = xFor(m.t);
      if (x < 0) continue;
      c.strokeStyle = 'rgba(139,123,255,.75)';
      c.lineWidth = Math.max(1, dpr);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }

    // One filled column per retained sample, width set by the gap to its
    // neighbour so the trace stays solid at any framerate.
    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      const x = xFor(s.t);
      if (x < -4) continue;
      const nextT = i + 1 < history.length ? history[i + 1].t : now;
      const colW = Math.max(1, xFor(nextT) - x);
      const rmsH = norm(s.rmsDb) * mid;
      const peakH = norm(s.peakDb) * mid;

      c.fillStyle = colorFor(s.peakDb);
      c.globalAlpha = 0.5;
      c.fillRect(x, mid - rmsH, colW, rmsH * 2);
      c.globalAlpha = 1;
      const tick = Math.max(1, dpr);
      c.fillRect(x, mid - peakH, colW, tick);
      c.fillRect(x, mid + peakH - tick, colW, tick);
    }
    c.globalAlpha = 1;
  }

  let raf = null;
  const tick = () => {
    const now = performance.now();
    analyser.getFloatTimeDomainData(buf);
    let peak = 0, sum = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    const peakDb = 20 * Math.log10(peak || 1e-9);
    const rmsDb = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9);

    history.push({t: now, peakDb, rmsDb});
    while (history.length && now - history[0].t > HISTORY_MS) history.shift();
    while (marks.length && now - marks[0].t > HISTORY_MS) marks.shift();

    if (onLevel) onLevel({peakDb, rmsDb});
    drawWave();
    drawStrip(now);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    /** Drops a vertical marker on the strip, e.g. when a measurement starts. */
    mark(label) { marks.push({t: performance.now(), label}); },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      src.disconnect();
      analyser.disconnect();
    },
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
async function record(ctx, stream, seconds, stimulusBuffer = null, leadSec = 0.2, onDiag = null) {
  await ensureWorklet(ctx);
  if (ctx.state !== 'running') {
    throw new Error(`AudioContext is "${ctx.state}", not running — audio cannot play or be captured`);
  }

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder', {numberOfOutputs: 0});

  const chunks = [];
  const frameStamps = [];
  let firstFrame = null;
  let workletStats = null;
  let flushed = null;
  const flushDone = new Promise((res) => { flushed = res; });

  node.port.onmessage = (e) => {
    if (e.data.done) { workletStats = e.data; flushed(); return; }
    if (firstFrame === null) firstFrame = e.data.startFrame;
    frameStamps.push({at: e.data.startFrame, len: e.data.chunk.length});
    chunks.push(e.data.chunk);
  };
  src.connect(node);

  let playFrame = null;
  let player = null;
  let endedEarly = false;
  if (stimulusBuffer) {
    const startTime = ctx.currentTime + leadSec;
    player = ctx.createBufferSource();
    player.buffer = stimulusBuffer;
    player.onended = () => { endedEarly = true; };
    player.connect(ctx.destination);
    player.start(startTime);
    // Frame the playback is scheduled to begin at, in the same clock the
    // worklet stamps with, so the capture can be trimmed to exact alignment.
    playFrame = Math.round(startTime * ctx.sampleRate);
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));

  // Ask the worklet for its partial buffer before tearing anything down.
  node.port.postMessage('flush');
  await Promise.race([flushDone, new Promise((r) => setTimeout(r, 250))]);

  try { player && player.stop(); } catch { /* already ended */ }
  node.port.onmessage = null;
  src.disconnect();
  node.disconnect();

  let total = 0;
  for (const c of chunks) total += c.length;
  const samples = new Float32Array(total);
  let p = 0;
  for (const c of chunks) { samples.set(c, p); p += c.length; }

  // Assembling chunks back-to-back assumes the worklet saw every render
  // quantum. If the audio thread ever glitched, the frame stamps will not be
  // contiguous and every sample after the gap is misaligned — which would
  // corrupt the delay silently. Detect it rather than trust it.
  let droppedFrames = 0;
  for (let i = 1; i < frameStamps.length; i++) {
    const expected = frameStamps[i - 1].at + frameStamps[i - 1].len;
    droppedFrames += Math.max(0, frameStamps[i].at - expected);
  }

  if (onDiag) {
    onDiag({
      capturedSamples: total,
      capturedSec: +(total / ctx.sampleRate).toFixed(3),
      firstFrame: firstFrame ?? 0,
      playFrame,
      droppedFrames,
      playbackCompleted: endedEarly,
      silentBlocks: workletStats?.silentBlocks ?? null,
      totalBlocks: workletStats?.totalBlocks ?? null,
      flushAcknowledged: workletStats != null,
    });
  }

  return {samples, firstFrame: firstFrame ?? 0, playFrame, droppedFrames, workletStats};
}

/**
 * One full measurement against whatever the AudioContext is currently
 * routed to. Returns the engine result plus the raw capture for debugging.
 */
export async function measureOnce(ctx, stream, opts = DEFAULTS, onDiag = null) {
  const o = {...DEFAULTS, ...opts};
  const stimulus = makeStimulus(ctx.sampleRate, o);

  const buffer = ctx.createBuffer(1, stimulus.signal.length, ctx.sampleRate);
  buffer.copyToChannel(stimulus.signal, 0);

  const leadSec = 0.2;
  // Tail generously past the stimulus: the last sweep still has to travel out,
  // through the device, and back before the capture stops.
  const durationSec = leadSec + stimulus.durationSec + 0.3;
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

  const cap = await record(ctx, stream, durationSec, buffer, leadSec,
    onDiag ? (d) => onDiag('capture', d) : null);

  // Align capture sample 0 with stimulus sample 0.
  const offset = cap.playFrame - cap.firstFrame;
  const aligned = offset >= 0 && offset < cap.samples.length
    ? cap.samples.subarray(offset)
    : cap.samples;

  if (onDiag && !(offset >= 0 && offset < cap.samples.length)) {
    onDiag('align', {
      problem: 'playback start fell outside the capture; using the untrimmed recording',
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
