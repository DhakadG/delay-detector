// Live input monitoring: level bar, instantaneous waveform, and level history.
//
// Rebuilt from scratch because the previous version's ballistics were wrong in a way
// that made the display actively misleading:
//
//   * Decay was per-FRAME, not per-second (`peakHold -= 0.7` each rAF). On a 60 Hz screen
//     that is -42 dB/s; on a 144 Hz screen it is -100 dB/s. The same signal looked
//     completely different on different monitors, and on this machine (a 2.19x DPR
//     high-refresh display) the peak marker fell so fast it was effectively invisible.
//   * Peak-hold reset on a 1400 ms wall-clock timer regardless of whether a new peak had
//     occurred, so the marker jumped backwards at random.
//   * The bar was driven by RMS on a linear -60..0 dB scale, so idle room noise around
//     -45 dB still filled a quarter of the bar and looked like signal.
//
// Everything here is now time-based (dB per second, scaled by real elapsed dt), so the
// behaviour is identical at any refresh rate. Ballistics follow normal metering practice:
// instant attack so nothing is missed, slow release so the eye can follow it, and a peak
// marker that holds before falling.

const DB_FLOOR = -60;

const RELEASE_DB_PER_SEC = 26;   // bar fall rate; slow enough to read, fast enough to track
const PEAK_HOLD_MS = 1200;       // how long the peak marker sits before it starts falling
const PEAK_FALL_DB_PER_SEC = 14; // then it slides down at this rate
const CLIP_LATCH_MS = 900;       // clip indicator stays lit this long after the last clip
const HISTORY_MS = 6000;

const norm = (db) => Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
const toDb = (amp) => 20 * Math.log10(amp || 1e-9);

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
 * @param {AudioContext} ctx
 * @param {MediaStream} stream
 * @param {{waveCanvas, stripCanvas, fillEl, peakEl, labelEl, clipEl}} els
 * @returns {{mark(label:string):void, stop():void}}
 */
export function attachMeter(ctx, stream, els = {}) {
  const {waveCanvas, stripCanvas, fillEl, peakEl, labelEl, clipEl} = els;

  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  // No smoothing at all: a sweep is a ~40 ms burst, and the analyser's own smoothing
  // would blur it toward the noise floor before it ever reached the display. All the
  // smoothing we want is the release ballistics below, which we control explicitly.
  analyser.smoothingTimeConstant = 0;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const wave = canvasTracker(waveCanvas);
  const strip = canvasTracker(stripCanvas);

  const history = [];   // {t, peakDb, rmsDb}
  const marks = [];     // {t, label}

  let barDb = DB_FLOOR;
  let peakDb = DB_FLOOR;
  let peakSetAt = 0;
  let clipUntil = 0;
  let raf = null;
  let lastT = null;

  function colorFor(db, clipped) {
    if (clipped) return '#ff6b6b';
    if (db > -6) return '#f5b642';
    if (db < -45) return '#3d434e';
    return '#35e0c0';
  }

  function drawWave() {
    if (!wave.ensure()) return;
    const c = wave.ctx, w = waveCanvas.width, h = waveCanvas.height, dpr = wave.dpr;
    c.clearRect(0, 0, w, h);

    // ±full-scale guides plus the zero line, so amplitude is readable, not just pretty
    c.strokeStyle = 'rgba(255,255,255,.06)';
    c.lineWidth = 1;
    for (const frac of [0.1, 0.5, 0.9]) {
      const y = h * frac;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }

    c.beginPath();
    c.strokeStyle = '#35e0c0';
    c.lineWidth = 1.4 * dpr;
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
      c.strokeStyle = 'rgba(139,123,255,.8)';
      c.lineWidth = Math.max(1, dpr);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }

    // One column per retained sample, widened to meet its neighbour so the trace stays
    // solid whatever the framerate.
    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      const x = xFor(s.t);
      if (x < -4) continue;
      const nextT = i + 1 < history.length ? history[i + 1].t : now;
      const colW = Math.max(1, xFor(nextT) - x);
      const rmsH = norm(s.rmsDb) * mid;
      const peakH = norm(s.peakDb) * mid;
      const tick = Math.max(1, dpr);

      c.fillStyle = colorFor(s.peakDb, s.peakDb > -0.5);
      c.globalAlpha = 0.5;
      c.fillRect(x, mid - rmsH, colW, rmsH * 2);
      c.globalAlpha = 1;
      c.fillRect(x, mid - peakH, colW, tick);
      c.fillRect(x, mid + peakH - tick, colW, tick);
    }
    c.globalAlpha = 1;
  }

  const tick = (now) => {
    // Real elapsed time drives every decay, so behaviour does not change with refresh
    // rate. Clamped because a backgrounded tab can hand back a multi-second dt.
    const dt = lastT == null ? 0.016 : Math.min(0.25, (now - lastT) / 1000);
    lastT = now;

    analyser.getFloatTimeDomainData(buf);
    let peakAmp = 0, sum = 0;
    for (const v of buf) {
      const a = Math.abs(v);
      if (a > peakAmp) peakAmp = a;
      sum += v * v;
    }
    const instPeakDb = toDb(peakAmp);
    const rmsDb = toDb(Math.sqrt(sum / buf.length));

    // Digital clipping latches so a brief overload cannot be missed between frames.
    if (peakAmp >= 0.99) clipUntil = now + CLIP_LATCH_MS;
    const clipped = now < clipUntil;

    // Bar: instant attack, timed release.
    barDb = instPeakDb >= barDb ? instPeakDb : Math.max(instPeakDb, barDb - RELEASE_DB_PER_SEC * dt);

    // Peak marker: rises immediately, holds, then falls.
    if (instPeakDb >= peakDb) { peakDb = instPeakDb; peakSetAt = now; }
    else if (now - peakSetAt > PEAK_HOLD_MS) {
      peakDb = Math.max(instPeakDb, peakDb - PEAK_FALL_DB_PER_SEC * dt);
    }

    if (fillEl) {
      fillEl.style.width = (norm(barDb) * 100).toFixed(1) + '%';
      fillEl.style.background = colorFor(barDb, clipped);
    }
    if (peakEl) peakEl.style.left = (norm(peakDb) * 100).toFixed(1) + '%';
    if (clipEl) clipEl.hidden = !clipped;
    if (labelEl) {
      labelEl.textContent =
        `${rmsDb <= DB_FLOOR ? '−∞' : rmsDb.toFixed(0)} dB RMS · peak ${peakDb <= DB_FLOOR ? '−∞' : peakDb.toFixed(0)} dB`;
    }

    history.push({t: now, peakDb: instPeakDb, rmsDb});
    while (history.length && now - history[0].t > HISTORY_MS) history.shift();
    while (marks.length && now - marks[0].t > HISTORY_MS) marks.shift();

    drawWave();
    drawStrip(now);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    /** Drops a vertical marker on the history strip, e.g. when a measurement starts. */
    mark(label) { marks.push({t: performance.now(), label}); },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      src.disconnect();
      analyser.disconnect();
    },
  };
}
