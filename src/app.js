// UI glue. No logic lives here that isn't about the DOM.
import {differential, playerOffsets, DEFAULTS, median, mad} from './engine.js';
import {
  openMic, listDevices, canSwitchOutput, measureOnce, micPermissionState,
  watchDeviceChanges,
} from './capture.js';
import {attachMeter} from './meter.js';
import {enhanceSelect} from './dropdown.js';
import {initLog, log, exportLog, clearLog, installGlobalHandlers} from './log.js';
import {loadHistory, saveEntry, clearHistory, toCsv} from './store.js';
import {BUILD, BUILT_AT} from './version.js';
import {buildBatchPlan, estimateBatchSeconds, summariseBatch} from './batch.js';
import {confirmDialog, promptNumber} from './dialog.js';
import {createBridge, describeBridgeError, DEFAULT_BRIDGE_URL} from './bridge.js';
import {solveBusDelays, busCombinations, routeFlagsFor} from './vmsync.js';

const $ = (id) => document.getElementById(id);
const isVirtual = (label) => /voicemeeter|vb-audio|virtual cable/i.test(label || '');

const state = {
  ctx: null, stream: null,
  currentInputId: null, refDeviceId: null, dutDeviceId: null,
  refMs: null, refDistanceM: null, refDevice: null, refAt: null,
  switchable: canSwitchOutput(),
  // true only once device lists come back with something to switch between —
  // Android/iOS Chrome and Safari never support setSinkId, so this stays
  // false there and the UI falls back to a typed label per measurement.
  canPickOutput: false,
  meter: null,
  warnedVirtual: false,
  outputs: [],
  bridge: createBridge({baseUrl: DEFAULT_BRIDGE_URL}),
  bridgeDevices: null, vmState: null,
  vmWatchTimer: null, vmStateHash: null,
  syncPlan: null, syncAbort: false, syncRunning: false,
  batchAbort: false, batchRunning: false,
};

function setStatus(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'status ' + cls;
}

function setCardEnabled(cardId, enabled) {
  $(cardId).dataset.disabled = enabled ? 'false' : 'true';
}

function setStep(name, cls) {
  const li = $('stepper').querySelector(`[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove('current', 'done');
  if (cls) li.classList.add(cls);
}

function setMicPill(state_, cls) {
  const el = $('pill-mic');
  el.textContent = 'mic · ' + state_;
  el.className = 'pill ' + cls;
}

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

const label = (sel) => sel.options[sel.selectedIndex]?.textContent || '';
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function fill(sel, devices, selectedId) {
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${d.kind} ${d.deviceId.slice(0, 8)}`;
    if (isVirtual(opt.textContent)) opt.dataset.virtual = '1';
    if (d.deviceId === (selectedId ?? prev)) opt.selected = true;
    sel.appendChild(opt);
  }
  enhanceSelect(sel);
}

function warnIfVirtual(devices) {
  if (state.warnedVirtual || !devices.some((d) => isVirtual(d.label))) return;
  state.warnedVirtual = true;
  log('warn', 'Virtual audio device detected (Voicemeeter or similar) — marked "· virtual" in the pickers', {
    devices: devices.filter((d) => isVirtual(d.label)).map((d) => d.label),
  });
  toast('Virtual audio device detected — see the session log');
}

// ------------------------------------------------------------------ mic ---

async function initMic(deviceId) {
  $('btn-mic').disabled = true;
  try {
    const {stream, settings, warnings} = await openMic(deviceId);

    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    if (state.meter) state.meter.stop();
    state.stream = stream;
    state.currentInputId = settings.deviceId || null;

    if (!state.ctx) state.ctx = new AudioContext({latencyHint: 'interactive'});
    await state.ctx.resume();
    if (state.ctx.state !== 'running') {
      // Some mobile browsers won't resume from inside an async chain even
      // when it started with a real tap — they want resume() called
      // directly from a click handler with nothing awaited first. Offer
      // that as an explicit fallback rather than silently staying muted.
      log('warn', 'AudioContext did not resume automatically', {state: state.ctx.state});
      $('btn-resume-audio').hidden = false;
      $('btn-resume-audio').onclick = async () => {
        await state.ctx.resume();
        if (state.ctx.state === 'running') {
          $('btn-resume-audio').hidden = true;
          log('ok', 'Audio resumed');
        }
      };
    }

    log(warnings.length ? 'warn' : 'ok', 'Microphone opened', {
      sampleRate: state.ctx.sampleRate,
      deviceId: settings.deviceId,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    });

    state.meter = attachMeter(state.ctx, state.stream, {
      waveCanvas: $('scope-wave'), stripCanvas: $('scope-strip'),
      fillEl: $('meter-fill'), peakEl: $('meter-peak'),
      labelEl: $('meter-label'), clipEl: $('meter-clip'),
    });
    $('meter-wrap').hidden = false;

    if (warnings.length) {
      setStatus('mic-status',
        `Warning: the browser kept ${warnings.join(', ')} enabled. Echo cancellation will ` +
        `cancel the test signal — results here are not trustworthy.`, 'bad');
      setMicPill('DSP not disabled', 'warn');
    } else {
      setStatus('mic-status',
        `Raw capture at ${state.ctx.sampleRate} Hz. Echo cancellation, noise suppression and AGC are off.`, 'ok');
      setMicPill('ready', 'ok');
    }

    $('btn-mic').textContent = 'Enabled';
    $('btn-mic').disabled = true;
    setCardEnabled('card-ref', true);
    setStep('mic', 'done');
    setStep('ref', 'current');

    await refreshDeviceLists();
  } catch (e) {
    log('bad', 'Could not open microphone', {error: e.message});
    setStatus('mic-status', 'Could not open the microphone: ' + e.message, 'bad');
    setMicPill('blocked', 'bad');
    $('btn-mic').disabled = false;
  }
}

async function refreshDeviceLists() {
  const {inputs, outputs} = await listDevices();
  log('info', `Device list refreshed — ${inputs.length} input(s), ${outputs.length} output(s)`, {
    inputs: inputs.map((d) => d.label || '(unlabeled — grant mic permission to see names)'),
    outputs: outputs.map((d) => d.label || '(unlabeled)'),
  });

  fill($('sel-input'), inputs, state.currentInputId);
  $('field-input').hidden = false;

  // setSinkId is unimplemented on Android Chrome, iOS Safari and iOS
  // Chrome entirely — there is no page-level way to switch or even see the
  // output device there. Falling back to a typed label (instead of just
  // hiding the picker) is what actually fixes "I don't see any device
  // options": there's still something to interact with, it just asks you to
  // say what you switched to yourself.
  state.outputs = outputs;
  state.canPickOutput = state.switchable && outputs.length > 0;
  if (state.canPickOutput) {
    fill($('sel-ref'), outputs, state.refDeviceId);
    fill($('sel-dut'), outputs, state.dutDeviceId);
  }
  $('field-ref-select').hidden = !state.canPickOutput;
  $('field-dut-select').hidden = !state.canPickOutput;
  $('field-ref-label').hidden = state.canPickOutput;
  $('field-dut-label').hidden = state.canPickOutput;

  $('dut-help').textContent = state.canPickOutput
    ? 'Pick a device. The page switches the output itself, so you can work through the list without touching system settings.'
    : 'Your browser can\'t list or switch audio outputs from the page — normal on Android and iOS. Change the output yourself (Bluetooth settings or the volume flyout), type a name for it below, then press Measure. Repeat per device.';

  renderPickers();
  warnIfVirtual([...inputs, ...outputs]);
}

// -------------------------------------------------------------- measure ---

/**
 * Shared measurement core: route to a device, capture, apply every validity
 * gate, log the detail. Returns {result} or {error} — callers never have to
 * decide for themselves whether a capture was trustworthy, so the single-run
 * path and the batch runner cannot drift apart on that judgement.
 */
async function performMeasurement({deviceId, label, tag, attempt = 1}) {
  if (state.canPickOutput && deviceId) {
    log('info', 'Switching output sink', {to: label, deviceId});
    const t = performance.now();
    await state.ctx.setSinkId(deviceId);
    // Bluetooth renegotiation is not instant; the stimulus warm-up sweep
    // covers the rest of the spin-up.
    await new Promise((r) => setTimeout(r, 900));
    log('info', 'Sink switched', {
      tookMs: Math.round(performance.now() - t),
      outputLatencyMs: +((state.ctx.outputLatency ?? 0) * 1000).toFixed(2),
    });
  }

  // A context that was suspended (backgrounded tab, or never started) does not
  // become steady the instant resume() returns: the render thread is still
  // spinning up, and capturing through that produced the "first run always
  // rejected, second run fine" pattern — 2944 dropped frames with firstFrame
  // at 512, i.e. the graph had barely started. Wait for it to actually be
  // running, then give it time to settle before trusting a capture.
  if (state.ctx.state !== 'running') {
    log('warn', 'AudioContext not running — resuming and letting it settle', {state: state.ctx.state});
    await state.ctx.resume();
    for (let i = 0; i < 20 && state.ctx.state !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (state.ctx.state !== 'running') {
      return {error: `the audio context is "${state.ctx.state}" and would not start`};
    }
    await new Promise((r) => setTimeout(r, 600));
    log('ok', 'AudioContext running', {outputLatencyMs: +((state.ctx.outputLatency ?? 0) * 1000).toFixed(2)});
  }

  state.meter?.mark(tag);
  const t0 = performance.now();
  const r = await measureOnce(state.ctx, state.stream, undefined,
    (stage, detail) => log(stage === 'align' ? 'warn' : 'info', `Measurement ${stage}`, detail));
  const tookMs = Math.round(performance.now() - t0);

  // Every sample after a dropped quantum is shifted by an unknown amount, so
  // the derived delay is wrong rather than merely noisy.
  if (r.droppedFrames) {
    const droppedMs = +(r.droppedFrames / state.ctx.sampleRate * 1000).toFixed(1);
    // A dropped quantum shifts every later sample, so the delay would be wrong
    // rather than merely noisy — the run has to go. But the usual cause is a
    // transient (the graph just started, or the tab was briefly busy), and it
    // almost never repeats, so retry once before bothering the user.
    log(attempt === 1 ? 'warn' : 'bad',
      `Audio thread dropped frames during capture — ${attempt === 1 ? 'retrying once' : 'discarding this run'}`, {
        device: label, droppedFrames: r.droppedFrames, droppedMs, tookMs, attempt,
      });
    if (attempt === 1) {
      await new Promise((res) => setTimeout(res, 400));
      return performMeasurement({deviceId, label, tag, attempt: 2});
    }
    return {error: `the audio thread dropped ${droppedMs} ms of capture, twice in a row`};
  }

  if (r.delayMs == null) {
    log('bad', 'Measurement rejected', {device: label, reason: r.reason, rejectedDetail: r.rejected, tookMs});
    return {error: r.reason, hint: r.hint};
  }

  log(r.ok ? 'ok' : 'warn', 'Measurement complete', {
    device: label, delayMs: +r.delayMs.toFixed(2), settledMs: +r.settledMs.toFixed(2),
    jitterMs: +r.jitterMs.toFixed(2), spreadMs: +r.spreadMs.toFixed(2),
    driftMsPerSec: +r.driftMsPerSec.toFixed(2), driftTotalMs: +r.driftTotalMs.toFixed(2),
    qualityDb: +r.qualityDb.toFixed(1), usedRepeats: r.usedRepeats,
    trimmedOutliers: r.trimmedOutliers, discarded: r.rejected.length, tookMs,
  });
  log('info', 'Per-repeat delays (ms)', {delays: r.delays.map((d) => +d.toFixed(2))});
  if (r.rejected.length) log('warn', 'Repeats rejected before averaging', {rejected: r.rejected});
  if (r.trimmedOutliers) {
    log('warn', `Discarded ${r.trimmedOutliers} repeat(s) far from the trend — reflection or noise burst, not the direct arrival`);
  }
  if (r.drifting) {
    log('warn',
      `${label} drifted ${r.driftTotalMs >= 0 ? '+' : ''}${r.driftTotalMs.toFixed(1)} ms during the run ` +
      `(${r.driftMsPerSec.toFixed(2)} ms/s) — its clock has not settled, so a single number is provisional`);
  }
  return {result: r, tookMs};
}

/** ok | warn | bad, from jitter about the trend rather than raw spread. */
function severityOf(r) {
  if (r.ok) return 'ok';
  if (r.jitterMs > DEFAULTS.maxSpreadMs * 3) return 'bad';
  return 'warn';
}

function caveatFor(r, severity) {
  if (severity === 'ok') return '';
  if (r.drifting && r.jitterMs <= DEFAULTS.maxSpreadMs) {
    return ` — but its latency drifted ${r.driftTotalMs >= 0 ? '+' : ''}${r.driftTotalMs.toFixed(0)} ms during the run, ` +
           `so this is a snapshot of a moving value rather than a fixed figure.`;
  }
  if (severity === 'bad') {
    return ` — too inconsistent to trust (jitter ±${r.jitterMs.toFixed(0)} ms). Move the mic closer, ` +
           `raise the volume, or reduce room noise, then measure again.`;
  }
  return ` — noisier than usual (${r.reason}), treat as approximate`;
}

async function run(which) {
  const statusId = which === 'ref' ? 'ref-status' : 'dut-status';
  const sel = which === 'ref' ? $('sel-ref') : $('sel-dut');
  const labelInput = which === 'ref' ? $('in-ref-label') : $('in-dut-label');
  const btn = which === 'ref' ? $('btn-ref') : $('btn-dut');
  const usingSel = state.canPickOutput;
  const deviceLabel = usingSel ? label(sel) : (labelInput.value.trim() || 'Current system output');
  btn.disabled = true;

  try {
    const trackSettings = state.stream?.getAudioTracks?.()[0]?.getSettings?.() ?? {};
    log('info', `--- ${which.toUpperCase()} run begin ---`, {
      device: deviceLabel, inputDeviceId: trackSettings.deviceId,
      contextState: state.ctx.state, sampleRate: state.ctx.sampleRate,
    });

    // The differential is only meaningful if both runs share an input chain.
    if (which === 'dut' && state.refInputId && trackSettings.deviceId &&
        trackSettings.deviceId !== state.refInputId) {
      log('bad', 'Input device changed since the reference run — refusing to measure', {
        referenceInput: state.refInputId, nowInput: trackSettings.deviceId,
      });
      toast('Microphone changed since the reference — re-measure the reference');
      setStatus(statusId,
        'The microphone changed since the reference was taken, so the two runs are no longer comparable. ' +
        'Measure the reference again.', 'bad');
      return;
    }

    setStatus(statusId, 'Measuring — keep the room quiet…');
    const {result: r, error, hint} = await performMeasurement({
      deviceId: usingSel ? sel.value : null, label: deviceLabel, tag: which,
    });
    if (!r) { setStatus(statusId, `Rejected: ${error}. ${hint || ''}`, 'bad'); return; }

    const severity = severityOf(r);
    const caveat = caveatFor(r, severity);

    if (which === 'ref') {
      if (state.refMs != null) {
        log('warn', 'Replacing the previous reference', {
          previous: {device: state.refDevice, delayMs: +state.refMs.toFixed(2)},
          now: {device: deviceLabel, delayMs: +r.delayMs.toFixed(2)},
        });
      }
      state.refMs = r.delayMs;
      state.refDevice = deviceLabel;
      state.refAt = new Date().toISOString();
      state.refInputId = trackSettings.deviceId ?? null;
      state.refDeviceId = usingSel ? sel.value : null;
      state.refDistanceM = parseFloat($('in-ref-distance').value) || null;
      updateRefBadge();
      setStatus(statusId,
        `Reference round trip ${r.delayMs.toFixed(1)} ms (jitter ±${r.jitterMs.toFixed(1)} ms, ` +
        `peak ${r.qualityDb.toFixed(0)} dB)${caveat} Now measure your devices.`, severity);
      setCardEnabled('card-dut', true);
      setCardEnabled('card-batch', true);
      setStep('ref', 'done');
      setStep('dut', 'current');
    } else {
      if (state.refMs == null) { setStatus(statusId, 'Measure the reference first.', 'bad'); return; }
      const dutDistanceM = parseFloat($('in-dut-distance').value) || null;
      const {deltaMs, airCorrectionMs} = differential(state.refMs, r.delayMs, {
        refDistanceM: state.refDistanceM, dutDistanceM,
      });
      if (airCorrectionMs) log('info', 'Applied air-propagation correction', {airCorrectionMs: +airCorrectionMs.toFixed(2)});

      const o = playerOffsets(deltaMs);
      log('ok', 'Differential computed', {
        device: deviceLabel, referenceDevice: state.refDevice,
        referenceMs: +state.refMs.toFixed(2), deviceMs: +r.delayMs.toFixed(2),
        deltaMs: +deltaMs.toFixed(2), vlc: o.vlc, mpv: o.mpv,
      });
      saveEntry({
        timestamp: new Date().toISOString(), device: deviceLabel,
        deltaMs, spreadMs: r.jitterMs, confident: r.ok, confidence: severity,
        driftMsPerSec: r.driftMsPerSec,
        reference: state.refDevice, referenceMs: state.refMs, deviceMs: r.delayMs,
        vlc: o.vlc, mpv: o.mpv, plex: o.plex, kodi: o.kodi, ffmpeg: o.ffmpeg,
      });
      renderHistory();
      setStatus(statusId,
        `${o.summary} (round trip ${r.delayMs.toFixed(1)} ms, jitter ±${r.jitterMs.toFixed(1)} ms)${caveat}`, severity);
      setStep('dut', 'done');
      setStep('results', 'done');
    }
  } catch (e) {
    log('bad', `Measurement failed (${which})`, {error: e.message});
    setStatus(statusId, 'Failed: ' + e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- bridge ---

function setBridgeStatus(text, cls = '') {
  const el = $('bridge-status');
  el.textContent = text;
  el.className = 'note ' + cls;
}

/**
 * Voicemeeter routing and delay, driven from here so the whole workflow lives in one
 * place: switch which physical outputs a source feeds (A1/A2/A3...), measure the
 * difference between them, then write that difference into the faster bus's output
 * delay so they line up. Previously this meant alt-tabbing to Voicemeeter between
 * every step.
 *
 * Voicemeeter's model: a *strip* is a source, a *bus* (A1..An) is a physical output.
 * A strip feeds any combination of buses, so ticking two A-flags is exactly how you
 * play to two devices at once — which is the case worth measuring, since that is when
 * their delay difference becomes audible.
 */
function renderVoicemeeter(st) {
  const wrap = $('vm-wrap');
  state.vmState = st;
  if (!st?.running) {
    wrap.hidden = true;
    $('vm-empty').hidden = false;
    $('vm-empty').textContent = st?.available
      ? 'Voicemeeter is installed but not running.'
      : 'Voicemeeter was not found on this machine.';
    return;
  }
  $('vm-empty').hidden = true;
  wrap.hidden = false;

  const busCount = st.buses?.length || 0;
  // Only some buses are A-buses. Banana reports five (A1-A3, B1, B2) but a strip's
  // A vector has three entries, and asking the API to set Strip[i].A4 fails the
  // ENTIRE call — which is why every routing button silently did nothing.
  const aBusCount = st.strips?.[0]?.a?.length ?? Math.min(busCount, 3);
  const renderNames = (state.bridgeDevices?.render || []).map((d) => d.name);

  // --- buses: device assignment + output delay ---
  const busBody = $('vm-buses');
  busBody.innerHTML = '';
  for (const bus of st.buses || []) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'mono';
    name.textContent = `A${bus.index + 1}`;
    tr.appendChild(name);

    const lbl = document.createElement('td');
    lbl.textContent = bus.label || '—';
    tr.appendChild(lbl);

    // device picker, populated from the machine's real render devices
    const devTd = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'vm-select';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = bus.device ? bus.device : '— not assigned —';
    sel.appendChild(none);
    for (const n of renderNames) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      if (n === bus.device) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = async () => {
      if (!sel.value) return;
      try {
        await state.bridge.setBusDevice(bus.index, sel.value, 'wdm');
        log('ok', 'Voicemeeter bus device assigned', {bus: bus.index, device: sel.value});
        toast(`A${bus.index + 1} → ${sel.value}`);
        await refreshVoicemeeter();
      } catch (e) {
        log('bad', 'Could not assign Voicemeeter bus device', {code: e.code, error: e.message});
        toast(describeBridgeError(e));
      }
    };
    devTd.appendChild(sel);
    tr.appendChild(devTd);

    const delay = document.createElement('td');
    delay.className = 'mono';
    delay.textContent = `${Number(bus.delayMs ?? 0).toFixed(0)} ms`;
    if ((bus.delayMs ?? 0) > 0) delay.classList.add('warn');
    tr.appendChild(delay);

    const act = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'ghost-btn small';
    btn.textContent = 'Set delay';
    btn.onclick = async () => {
      const ms = await promptNumber({
        title: `Output delay for A${bus.index + 1}`,
        body: 'Delays everything leaving this bus. To line a fast output up with a slower one, ' +
              'delay the fast bus by the difference you measured.',
        value: String(Math.round(bus.delayMs ?? 0)),
        min: 0, max: 500, unit: 'ms', confirmText: 'Apply',
      });
      if (ms == null) return;
      try {
        await state.bridge.setDelay(bus.index, ms);
        log('ok', 'Voicemeeter bus delay set', {bus: bus.index, ms});
        toast(`A${bus.index + 1} delay ${ms} ms`);
        await refreshVoicemeeter();
      } catch (e) {
        log('bad', 'Could not set Voicemeeter delay', {code: e.code, error: e.message});
        toast(describeBridgeError(e));
      }
    };
    act.appendChild(btn);
    tr.appendChild(act);
    busBody.appendChild(tr);
  }

  // A bus is audible only if some strip is actually sending to it; the bus table
  // alone cannot show that, which left no way to tell what was playing.
  const liveBuses = new Set();
  for (const strip of st.strips || []) {
    (strip.a || []).forEach((on, i) => { if (on) liveBuses.add(i); });
  }
  state.liveBuses = liveBuses;
  renderSyncPickers();

  // --- strips: which buses each source feeds ---
  const stripBody = $('vm-strips');
  stripBody.innerHTML = '';
  for (const strip of st.strips || []) {
    const tr = document.createElement('tr');
    const nm = document.createElement('td');
    nm.textContent = strip.label || `Strip ${strip.index + 1}`;
    tr.appendChild(nm);

    const routeTd = document.createElement('td');
    routeTd.className = 'vm-routes';
    for (let i = 0; i < aBusCount; i++) {
      const on = !!strip.a?.[i];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vm-route' + (on ? ' on' : '');
      b.textContent = `A${i + 1}`;
      b.title = `${on ? 'Stop sending' : 'Send'} strip ${strip.index + 1} to A${i + 1}`;
      b.onclick = async () => {
        // Send the whole A vector, since the endpoint sets them together.
        const flags = Array.from({length: aBusCount}, (_, k) => !!strip.a?.[k]);
        flags[i] = !on;
        try {
          await state.bridge.setRoute(strip.index, flags);
          log('ok', 'Voicemeeter routing changed', {strip: strip.index, a: flags});
          await refreshVoicemeeter();
        } catch (e) {
          log('bad', 'Could not change Voicemeeter routing', {code: e.code, error: e.message});
          toast(describeBridgeError(e));
        }
      };
      routeTd.appendChild(b);
    }
    tr.appendChild(routeTd);
    stripBody.appendChild(tr);
  }
}

/** Always re-reads from the app; the previous version could leave a stale table on screen. */
async function refreshVoicemeeter() {
  if (!state.bridge.isConnected()) return;
  try {
    if (!state.bridgeDevices) state.bridgeDevices = await state.bridge.devices();
    renderVoicemeeter(await state.bridge.voicemeeterState());
  } catch (e) {
    log('warn', 'Could not read Voicemeeter state', {code: e.code, error: e.message});
    setBridgeStatus(describeBridgeError(e), 'warn');
  }
}

async function connectBridge() {
  setBridgeStatus('connecting…');
  try {
    const info = await state.bridge.connect();
    const vm = info.voicemeeter;
    const vmText = vm.running ? `Voicemeeter ${vm.type}`
      : vm.available ? 'Voicemeeter installed, not running'
        : 'no Voicemeeter';
    setBridgeStatus(`connected · v${info.version} · ${vmText}`, 'ok');
    log('ok', 'Local app connected', {version: info.version, voicemeeter: vm});
    $('btn-vm-refresh').hidden = false;
    $('vm-watch-wrap').hidden = false;
    // Remember that a bridge was reachable here, so the next visit can connect
    // silently instead of making the user press Connect every time.
    try { localStorage.setItem('delay-detector:bridge', '1'); } catch { /* private mode */ }
    if ($('vm-watch').checked) startVoicemeeterWatch();
    state.bridgeDevices = await state.bridge.devices();
    log('info', 'Local app device list', {
      render: state.bridgeDevices.render.map((d) => d.name),
      capture: state.bridgeDevices.capture.map((d) => d.name),
    });
    await refreshVoicemeeter();
  } catch (e) {
    stopVoicemeeterWatch();
    setBridgeStatus(describeBridgeError(e), 'warn');
    log('warn', 'Local app not connected', {code: e.code, error: e.message});
    throw e;
  }
}

/**
 * Connects without the user asking, but only quietly: a failure here is normal
 * (the companion app is optional and usually not running) so it must not shout.
 * Only auto-tries when a previous session actually reached a bridge, so first-time
 * visitors are not billed a failed request on every load.
 */
async function autoConnectBridge() {
  let seen = false;
  try { seen = localStorage.getItem('delay-detector:bridge') === '1'; } catch { /* ignore */ }
  if (!seen) { setBridgeStatus('not connected'); return; }
  try {
    await connectBridge();
  } catch {
    setBridgeStatus('local app not running', 'warn');
  }
}

// ----------------------------------------------------------------- batch ---

function pickerValues(containerId) {
  return [...$(containerId).querySelectorAll('input:checked')]
    .map((el) => ({id: el.value, label: el.dataset.label}));
}

function renderPickers() {
  for (const [id, defaultAll] of [['batch-refs', false], ['batch-duts', true]]) {
    const box = $(id);
    const previously = new Set([...box.querySelectorAll('input:checked')].map((el) => el.value));
    box.innerHTML = '';
    for (const d of state.outputs) {
      const name = d.label || d.deviceId.slice(0, 8);
      const wrap = document.createElement('label');
      wrap.className = 'pick' + (isVirtual(name) ? ' virtual' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = d.deviceId;
      cb.dataset.label = name;
      cb.checked = previously.size ? previously.has(d.deviceId) : defaultAll;
      cb.onchange = updateBatchEstimate;
      const span = document.createElement('span');
      span.textContent = name;
      wrap.append(cb, span);
      box.appendChild(wrap);
    }
  }
  updateBatchEstimate();
}

function updateBatchEstimate() {
  try {
    const plan = buildBatchPlan({
      references: pickerValues('batch-refs'),
      devices: pickerValues('batch-duts'),
      rounds: +$('batch-rounds').value,
      includeSelfCheck: $('batch-self').checked,
    });
    const secs = estimateBatchSeconds(plan);
    $('batch-estimate').textContent =
      `${plan.length} measurements · about ${Math.floor(secs / 60)}m ${secs % 60}s`;
  } catch {
    $('batch-estimate').textContent = 'pick at least one reference and one device';
  }
}

function renderBatchSummary(results) {
  const rows = summariseBatch(results, {median, mad});
  const body = $('batch-results-body');
  body.innerHTML = '';
  $('batch-results-wrap').hidden = rows.length === 0;
  for (const row of rows) {
    const o = playerOffsets(row.medianMs);
    const tr = document.createElement('tr');
    // Disagreement across rounds matters more than any single round's number.
    if (row.rangeMs > 20) tr.className = 'warn';
    tr.innerHTML =
      `<td>${escapeHtml(row.key)}</td>` +
      `<td class="mono">${row.medianMs >= 0 ? '+' : ''}${row.medianMs.toFixed(0)} ms</td>` +
      `<td class="mono">${row.minMs.toFixed(0)} … ${row.maxMs.toFixed(0)} ms</td>` +
      `<td class="mono">${row.n}</td>` +
      `<td class="mono">${row.medianDriftMsPerSec == null ? '—' : row.medianDriftMsPerSec.toFixed(1) + ' ms/s'}</td>` +
      `<td><code class="mono">${o.vlc}</code></td>`;
    body.appendChild(tr);
  }
}

async function runBatch() {
  let plan;
  try {
    plan = buildBatchPlan({
      references: pickerValues('batch-refs'),
      devices: pickerValues('batch-duts'),
      rounds: +$('batch-rounds').value,
      includeSelfCheck: $('batch-self').checked,
    });
  } catch (e) {
    setStatus('batch-status', e.message, 'bad');
    return;
  }
  if (!plan.length) {
    setStatus('batch-status', 'Nothing to do — the selected device is also the only reference.', 'warn');
    return;
  }

  const secs = estimateBatchSeconds(plan);
  if (secs > 150) {
    const go = await confirmDialog({
      title: 'Start batch run?',
      body: `${plan.length} measurements, roughly ${Math.floor(secs / 60)}m ${secs % 60}s. ` +
            `Keep the room quiet and leave this tab in the foreground — background tabs get throttled, which ruins captures.`,
      confirmText: 'Start',
    });
    if (!go) return;
  }

  state.batchRunning = true;
  state.batchAbort = false;
  $('btn-batch-start').disabled = true;
  $('btn-batch-stop').hidden = false;
  $('batch-progress').hidden = false;
  $('btn-ref').disabled = true;
  $('btn-dut').disabled = true;
  log('info', '=== BATCH BEGIN ===', {steps: plan.length, estimateSec: secs});

  const results = [];
  let refMs = null, refLabelNow = null, failures = 0;

  try {
    for (const step of plan) {
      if (state.batchAbort) { log('warn', 'Batch stopped by user', {completed: step.index}); break; }

      $('batch-progress').firstElementChild.style.width = `${(step.index / plan.length) * 100}%`;
      setStatus('batch-status',
        `Round ${step.round} · ${step.index + 1}/${plan.length} · ` +
        `${step.kind === 'ref' ? 'reference' : 'testing'} ${step.deviceLabel}`);

      const {result: r, error} = await performMeasurement({
        deviceId: state.canPickOutput ? step.deviceId : null,
        label: step.deviceLabel, tag: step.kind,
      });

      if (step.kind === 'ref') {
        // A failed reference invalidates its whole round rather than letting
        // the previous round's reference silently stand in for it.
        refMs = r ? r.delayMs : null;
        refLabelNow = step.refLabel;
        if (!r) {
          failures++;
          log('bad', 'Reference failed — skipping the devices in this round', {round: step.round, error});
        }
        continue;
      }

      if (!r) { failures++; continue; }
      if (refMs == null) {
        log('warn', 'Skipping device: no valid reference this round', {device: step.deviceLabel});
        continue;
      }

      const {deltaMs} = differential(refMs, r.delayMs);
      const o = playerOffsets(deltaMs);
      results.push({
        round: step.round, refLabel: refLabelNow, deviceLabel: step.deviceLabel,
        deltaMs, driftMsPerSec: r.driftMsPerSec, jitterMs: r.jitterMs,
      });
      saveEntry({
        timestamp: new Date().toISOString(), device: step.deviceLabel,
        deltaMs, spreadMs: r.jitterMs, confident: r.ok, confidence: severityOf(r),
        driftMsPerSec: r.driftMsPerSec, batchRound: step.round,
        reference: refLabelNow, referenceMs: refMs, deviceMs: r.delayMs,
        vlc: o.vlc, mpv: o.mpv, plex: o.plex, kodi: o.kodi, ffmpeg: o.ffmpeg,
      });
      renderBatchSummary(results);
      renderHistory();
    }
  } catch (e) {
    log('bad', 'Batch aborted by an error', {error: e.message});
    setStatus('batch-status', 'Batch failed: ' + e.message, 'bad');
  } finally {
    state.batchRunning = false;
    $('btn-batch-start').disabled = false;
    $('btn-batch-stop').hidden = true;
    $('batch-progress').firstElementChild.style.width = '100%';
    $('btn-ref').disabled = false;
    $('btn-dut').disabled = false;
    updateRefBadge();
  }

  const summary = summariseBatch(results, {median, mad});
  log('ok', '=== BATCH COMPLETE ===', {
    measurements: results.length, failures,
    pairs: summary.map((r) => ({
      pair: r.key, medianMs: +r.medianMs.toFixed(1), rangeMs: +r.rangeMs.toFixed(1), n: r.n,
    })),
  });
  setStatus('batch-status',
    `Done — ${results.length} measurement${results.length === 1 ? '' : 's'} across ` +
    `${summary.length} pair${summary.length === 1 ? '' : 's'}` +
    (failures ? `, ${failures} rejected` : '') + '.',
    failures ? 'warn' : 'ok');
  renderBatchSummary(results);
}

/** Shows which reference every delta is currently being measured against. */
function updateRefBadge() {
  const el = $('ref-active');
  if (!el) return;
  if (state.refMs == null) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Active reference: ${state.refDevice} · ${state.refMs.toFixed(1)} ms`;
}

// ------------------------------------------------------- voicemeeter sync ---

/**
 * Cheap change-detector for the Voicemeeter state. Polling is the only option:
 * the Remote API exposes IsParametersDirty for its own clients but the bridge is
 * request/response, so the page cannot be pushed to. Hashing what we render means
 * the tables are only rebuilt when something actually differs, so a poll does not
 * fight the user's cursor or reset a half-typed field.
 */
function vmHash(st) {
  if (!st) return '';
  return JSON.stringify({
    b: (st.buses || []).map((b) => [b.label, b.device, b.delayMs]),
    s: (st.strips || []).map((x) => [x.label, x.a, x.b]),
    t: st.type, r: st.running,
  });
}

function startVoicemeeterWatch() {
  stopVoicemeeterWatch();
  state.vmWatchTimer = setInterval(async () => {
    if (!state.bridge.isConnected() || state.syncRunning || state.batchRunning) return;
    if (document.hidden) return;   // a hidden tab is throttled; polling it is pointless
    try {
      const st = await state.bridge.voicemeeterState();
      const h = vmHash(st);
      if (h !== state.vmStateHash) {
        state.vmStateHash = h;
        renderVoicemeeter(st);
        log('info', 'Voicemeeter changed externally — UI updated');
      }
    } catch {
      // The app going away is normal; connectBridge() reports it properly.
    }
  }, 2000);
}

function stopVoicemeeterWatch() {
  if (state.vmWatchTimer) clearInterval(state.vmWatchTimer);
  state.vmWatchTimer = null;
}

/** Buses that have a device assigned — the only ones worth measuring. */
function syncableBuses() {
  return (state.vmState?.buses || [])
    .filter((b) => b.device && b.index < (state.vmState?.strips?.[0]?.a?.length ?? 3));
}

function renderSyncPickers() {
  const box = $('sync-buses');
  if (!box) return;
  const buses = syncableBuses();
  const previously = new Set([...box.querySelectorAll('input:checked')].map((el) => +el.value));
  box.innerHTML = '';
  for (const b of buses) {
    const wrap = document.createElement('label');
    wrap.className = 'pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(b.index);
    cb.checked = previously.size ? previously.has(b.index) : true;
    const span = document.createElement('span');
    span.textContent = `${b.label} · ${b.device}`;
    wrap.append(cb, span);
    box.appendChild(wrap);
  }

  const src = $('sync-source');
  if (src) {
    const prev = src.value;
    src.innerHTML = '';
    for (const strip of state.vmState?.strips || []) {
      const opt = document.createElement('option');
      opt.value = String(strip.index);
      opt.textContent = strip.label || `Strip ${strip.index + 1}`;
      // Default to whichever strip is already routed somewhere: that is the one
      // the user's audio is actually coming out of.
      if (prev ? prev === opt.value : (strip.a || []).some(Boolean)) opt.selected = true;
      src.appendChild(opt);
    }
    enhanceSelect(src);
  }
}

const selectedSyncBuses = () =>
  [...$('sync-buses').querySelectorAll('input:checked')].map((el) => +el.value);

/**
 * Routes the chosen strip to exactly `combo` and measures what the mic hears.
 * Everything else is muted for the duration, which is what makes a single-bus
 * latency measurable at all when several outputs normally play together.
 */
async function measureBusCombo(stripIndex, combo, aBusCount, tag) {
  await state.bridge.setRoute(stripIndex, routeFlagsFor(combo, aBusCount));
  // Voicemeeter applies routing on its own audio thread; give it a moment before
  // the sweep starts, or the first repeat lands during the switch.
  await new Promise((r) => setTimeout(r, 400));
  return performMeasurement({deviceId: state.vmSinkDeviceId || null, label: tag, tag: 'sync'});
}

/** The browser sink that feeds Voicemeeter, so the sweep enters the right strip. */
function findVoicemeeterSink() {
  const m = state.outputs.find((d) => /voicemeeter input/i.test(d.label || ''));
  return m ? m.deviceId : null;
}

async function runSyncSolve() {
  const buses = selectedSyncBuses();
  const aBusCount = state.vmState?.strips?.[0]?.a?.length ?? 3;
  const stripIndex = +$('sync-source').value;

  if (buses.length < 2) {
    setStatus('sync-status', 'Pick at least two buses — aligning one output to itself is a no-op.', 'warn');
    return;
  }
  if (state.refMs == null) {
    setStatus('sync-status', 'Measure the reference first (step 2) so the mic path can be cancelled.', 'bad');
    return;
  }

  state.vmSinkDeviceId = findVoicemeeterSink();
  if (!state.vmSinkDeviceId) {
    setStatus('sync-status',
      'No "Voicemeeter Input" output found in the browser, so the sweep cannot be sent into Voicemeeter.', 'bad');
    return;
  }

  const before = (state.vmState?.strips || []).find((x) => x.index === stripIndex);
  const restore = Array.from({length: aBusCount}, (_, i) => !!before?.a?.[i]);

  state.syncRunning = true;
  state.syncAbort = false;
  $('btn-sync-solve').disabled = true;
  $('btn-sync-combos').disabled = true;
  $('btn-sync-stop').hidden = false;
  $('sync-progress').hidden = false;
  log('info', '=== SYNC SOLVE BEGIN ===', {buses, stripIndex, aBusCount});

  const measured = [];
  try {
    for (let i = 0; i < buses.length; i++) {
      if (state.syncAbort) break;
      const bus = state.vmState.buses.find((b) => b.index === buses[i]);
      $('sync-progress').firstElementChild.style.width = `${(i / buses.length) * 100}%`;
      setStatus('sync-status', `Measuring ${bus.label} alone (${i + 1}/${buses.length})…`);

      const {result: r, error} = await measureBusCombo(stripIndex, [buses[i]], aBusCount, bus.label);
      if (!r) {
        log('bad', 'Bus measurement failed', {bus: bus.label, error});
        setStatus('sync-status', `${bus.label} failed: ${error}`, 'bad');
        continue;
      }
      // Subtract the reference so the microphone and capture chain cancel; what
      // is left is the bus's own output latency, which is what we align on.
      measured.push({
        busIndex: bus.index, label: bus.label, device: bus.device,
        latencyMs: r.delayMs - state.refMs, jitterMs: r.jitterMs, driftMsPerSec: r.driftMsPerSec,
      });
      log('ok', 'Bus measured', {
        bus: bus.label, roundTripMs: +r.delayMs.toFixed(2),
        latencyVsReferenceMs: +(r.delayMs - state.refMs).toFixed(2),
      });
    }

    if (measured.length < 2) {
      setStatus('sync-status', 'Not enough buses measured successfully to align them.', 'bad');
      return;
    }

    const solved = solveBusDelays(measured);
    state.syncPlan = solved;
    renderSyncPlan(solved, measured);
    for (const w of solved.warnings) log('warn', w);
    log('ok', '=== SYNC SOLVE COMPLETE ===', {
      anchor: solved.anchorIndex, spreadMs: +solved.spreadMs.toFixed(1),
      residualMs: +solved.residualMs.toFixed(2),
      plan: solved.plan.map((p) => ({bus: p.label, delayMs: p.delayMs})),
    });
    setStatus('sync-status',
      `Outputs differ by ${solved.spreadMs.toFixed(0)} ms. Apply the delays below to bring them together.`,
      solved.warnings.length ? 'warn' : 'ok');
    $('btn-sync-apply').hidden = false;
  } catch (e) {
    log('bad', 'Sync solve failed', {error: e.message});
    setStatus('sync-status', 'Failed: ' + e.message, 'bad');
  } finally {
    // Put the routing back the way it was — a half-finished run must not leave
    // the user's audio going somewhere they did not choose.
    try { await state.bridge.setRoute(stripIndex, restore); } catch { /* reported below */ }
    await refreshVoicemeeter();
    state.syncRunning = false;
    $('btn-sync-solve').disabled = false;
    $('btn-sync-combos').disabled = false;
    $('btn-sync-stop').hidden = true;
    $('sync-progress').firstElementChild.style.width = '100%';
  }
}

function renderSyncPlan(solved, measured) {
  const body = $('sync-body');
  body.innerHTML = '';
  for (const p of solved.plan) {
    const m = measured.find((x) => x.busIndex === p.busIndex);
    const tr = document.createElement('tr');
    if (p.clamped) tr.className = 'warn';
    const isAnchor = p.busIndex === solved.anchorIndex;
    tr.innerHTML =
      `<td>${escapeHtml(p.label || 'bus ' + p.busIndex)}${isAnchor ? ' <span class="badge">slowest</span>' : ''}</td>` +
      `<td>${escapeHtml(m?.device || '')}</td>` +
      `<td class="mono">${p.latencyMs.toFixed(1)} ms</td>` +
      `<td class="mono">${p.delayMs} ms</td>` +
      `<td class="mono">${(p.latencyMs + p.delayMs).toFixed(1)} ms</td>`;
    body.appendChild(tr);
  }
  $('sync-wrap').hidden = false;
}

async function applySyncPlan() {
  if (!state.syncPlan) return;
  $('btn-sync-apply').disabled = true;
  let failed = 0;
  for (const p of state.syncPlan.plan) {
    try {
      await state.bridge.setDelay(p.busIndex, p.delayMs);
      log('ok', 'Bus delay set', {bus: p.label, delayMs: p.delayMs});
    } catch (e) {
      failed++;
      log('bad', 'Could not set bus delay', {bus: p.label, code: e.code, error: e.message});
    }
  }
  await refreshVoicemeeter();
  $('btn-sync-apply').disabled = false;

  const offset = state.syncPlan.anchorLatencyMs;
  setStatus('sync-status',
    failed
      ? `${failed} delay(s) could not be set — see the log.`
      : `Applied. All outputs now emit together, about ${offset.toFixed(0)} ms behind the source — ` +
        `set your player's audio offset to ${-Math.round(offset)} ms.`,
    failed ? 'bad' : 'ok');
  if (!failed) toast(`Aligned. Player offset: ${-Math.round(offset)} ms`);
}

/**
 * Measures every combination of the selected buses. Singles give each bus's own
 * latency; the multi-bus runs are the check that the applied delays worked — an
 * aligned pair collapses to one arrival, a misaligned one does not.
 */
async function runCombinations() {
  const buses = selectedSyncBuses();
  const aBusCount = state.vmState?.strips?.[0]?.a?.length ?? 3;
  const stripIndex = +$('sync-source').value;
  if (!buses.length) { setStatus('sync-status', 'Pick at least one bus.', 'warn'); return; }
  if (state.refMs == null) {
    setStatus('sync-status', 'Measure the reference first (step 2).', 'bad');
    return;
  }
  state.vmSinkDeviceId = findVoicemeeterSink();
  if (!state.vmSinkDeviceId) {
    setStatus('sync-status', 'No "Voicemeeter Input" browser output found.', 'bad');
    return;
  }

  const combos = busCombinations(buses);
  const before = (state.vmState?.strips || []).find((x) => x.index === stripIndex);
  const restore = Array.from({length: aBusCount}, (_, i) => !!before?.a?.[i]);
  const nameOf = (i) => state.vmState.buses.find((b) => b.index === i)?.label || `A${i + 1}`;

  const go = await confirmDialog({
    title: 'Run every combination?',
    body: `${combos.length} measurements, roughly ${Math.round(combos.length * 7 / 60)} min. ` +
          `Your Voicemeeter routing will be changed during the run and restored afterwards.`,
    confirmText: 'Run',
  });
  if (!go) return;

  state.syncRunning = true;
  state.syncAbort = false;
  $('btn-sync-combos').disabled = true;
  $('btn-sync-solve').disabled = true;
  $('btn-sync-stop').hidden = false;
  $('sync-progress').hidden = false;
  $('combo-body').innerHTML = '';
  $('combo-wrap').hidden = false;
  log('info', '=== COMBINATION RUN BEGIN ===', {combos: combos.map((c) => c.map(nameOf).join('+'))});

  try {
    for (let i = 0; i < combos.length; i++) {
      if (state.syncAbort) { log('warn', 'Combination run stopped by user'); break; }
      const combo = combos[i];
      const name = combo.map(nameOf).join(' + ');
      $('sync-progress').firstElementChild.style.width = `${(i / combos.length) * 100}%`;
      setStatus('sync-status', `${i + 1}/${combos.length} · ${name}`);

      const {result: r, error} = await measureBusCombo(stripIndex, combo, aBusCount, name);
      const tr = document.createElement('tr');
      if (!r) {
        tr.className = 'bad';
        tr.innerHTML = `<td>${escapeHtml(name)}</td><td colspan="4">${escapeHtml(error || 'failed')}</td>`;
      } else {
        const latency = r.delayMs - state.refMs;
        // With several buses live the correlator reports the FIRST arrival, so
        // this is the leading device. Aligned groups show the same figure as
        // their slowest member; a lead means they are still staggered.
        if (r.drifting) tr.className = 'warn';
        tr.innerHTML =
          `<td>${escapeHtml(name)}${combo.length > 1 ? ' <span class="badge">group</span>' : ''}</td>` +
          `<td class="mono">${latency.toFixed(1)} ms</td>` +
          `<td class="mono">±${r.jitterMs.toFixed(2)} ms</td>` +
          `<td class="mono">${r.driftMsPerSec.toFixed(2)} ms/s</td>` +
          `<td>${combo.length > 1 ? 'earliest of the group' : ''}</td>`;
        log('ok', 'Combination measured', {
          combo: name, latencyMs: +latency.toFixed(2),
          jitterMs: +r.jitterMs.toFixed(2), driftMsPerSec: +r.driftMsPerSec.toFixed(2),
        });
      }
      $('combo-body').appendChild(tr);
    }
  } catch (e) {
    log('bad', 'Combination run failed', {error: e.message});
    setStatus('sync-status', 'Failed: ' + e.message, 'bad');
  } finally {
    try { await state.bridge.setRoute(stripIndex, restore); } catch { /* logged by refresh */ }
    await refreshVoicemeeter();
    state.syncRunning = false;
    $('btn-sync-combos').disabled = false;
    $('btn-sync-solve').disabled = false;
    $('btn-sync-stop').hidden = true;
    $('sync-progress').firstElementChild.style.width = '100%';
    log('ok', '=== COMBINATION RUN COMPLETE ===');
    setStatus('sync-status', 'Combination run finished. Routing restored.', 'ok');
  }
}

// --------------------------------------------------------------- results --

function copyBtnHtml(text) {
  return `<button class="copy-btn" data-copy="${escapeHtml(text)}" title="Copy" aria-label="Copy">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
    `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>`;
}

function renderHistory() {
  const history = loadHistory();
  const tbody = $('results-body');
  tbody.innerHTML = '';
  $('results-empty').hidden = history.length > 0;

  for (const h of history) {
    // older saved entries predate the 'confidence' tier — fall back to the boolean
    const sev = h.confidence || (h.confident ? 'ok' : 'warn');
    const tr = document.createElement('tr');
    if (sev !== 'ok') tr.className = sev;
    tr.innerHTML =
      `<td>${escapeHtml(h.device)}${sev === 'ok' ? '' : ` <span class="badge ${sev}">${sev === 'bad' ? 'unreliable' : 'approx'}</span>`}</td>` +
      `<td class="mono">${h.deltaMs >= 0 ? '+' : ''}${h.deltaMs.toFixed(0)} ms</td>` +
      `<td class="mono">±${h.spreadMs.toFixed(1)} ms</td>` +
      `<td><code class="mono">${h.vlc}</code>${copyBtnHtml(h.vlc)}</td>` +
      `<td><code class="mono">${h.mpv}</code>${copyBtnHtml(h.mpv)}</td>` +
      `<td class="mono" title="${escapeHtml(h.timestamp)}">${timeAgo(h.timestamp)}</td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast('Copied: ' + btn.dataset.copy);
      } catch {
        toast('Copy failed — select and copy manually');
      }
    };
  });
}

// ----------------------------------------------------------------- boot ---

function wireHandlers() {
  $('btn-mic').onclick = () => initMic();
  $('sel-input').onchange = () => {
    log('info', 'Input device changed by user', {to: label($('sel-input'))});
    initMic($('sel-input').value);
  };

  $('btn-refresh').onclick = async () => {
    const btn = $('btn-refresh');
    btn.classList.add('spinning');
    log('info', 'Manual device list refresh requested');
    try {
      await refreshDeviceLists();
      toast('Device list refreshed');
    } finally {
      btn.classList.remove('spinning');
    }
  };

  const roundsSel = $('batch-rounds');
  for (const n of [3, 5, 7, 10]) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `${n} rounds`;
    if (n === 3) opt.selected = true;
    roundsSel.appendChild(opt);
  }
  roundsSel.onchange = updateBatchEstimate;
  $('batch-self').onchange = updateBatchEstimate;
  $('btn-batch-start').onclick = runBatch;
  $('btn-batch-stop').onclick = () => {
    state.batchAbort = true;
    setStatus('batch-status', 'Stopping after the current measurement…', 'warn');
  };

  $('btn-bridge-connect').onclick = () => connectBridge().catch(() => { /* status already shown */ });
  $('vm-watch').onchange = (e) => {
    if (e.target.checked) { startVoicemeeterWatch(); log('info', 'Following Voicemeeter changes'); }
    else { stopVoicemeeterWatch(); log('info', 'Stopped following Voicemeeter changes'); }
  };
  $('btn-sync-solve').onclick = runSyncSolve;
  $('btn-sync-apply').onclick = applySyncPlan;
  $('btn-sync-combos').onclick = runCombinations;
  $('btn-sync-stop').onclick = () => {
    state.syncAbort = true;
    setStatus('sync-status', 'Stopping after the current measurement…', 'warn');
  };
  $('btn-vm-refresh').onclick = async () => {
    // Re-read the device list too: buses can be reassigned in Voicemeeter itself.
    state.bridgeDevices = null;
    await refreshVoicemeeter();
    toast('Voicemeeter refreshed');
  };

  $('btn-ref').onclick = () => run('ref');
  $('btn-dut').onclick = () => run('dut');

  $('btn-ref-adv').onclick = () => { $('adv-ref').hidden = !$('adv-ref').hidden; };
  $('btn-dut-adv').onclick = () => { $('adv-dut').hidden = !$('adv-dut').hidden; };

  $('btn-log-toggle').onclick = () => { $('log-panel').hidden = false; };
  $('btn-log-close').onclick = () => { $('log-panel').hidden = true; };
  $('btn-log-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(exportLog()); toast('Log copied'); }
    catch { toast('Copy failed'); }
  };
  $('btn-log-clear').onclick = () => { clearLog(); log('info', 'Log cleared'); };

  $('btn-export').onclick = () => {
    const csv = toCsv(loadHistory());
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `delay-detector-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log('info', 'Exported results as CSV');
  };

  $('btn-copy-history').onclick = async () => {
    const history = loadHistory();
    if (!history.length) { toast('No measurements to copy'); return; }
    const text = toCsv(history);
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${history.length} measurement(s)`);
      log('info', `Copied ${history.length} measurement(s) to the clipboard`);
    } catch (e) {
      log('warn', 'Clipboard copy failed', {error: e.message});
      toast('Copy failed — use Export CSV instead');
    }
  };

  $('btn-clear-history').onclick = async () => {
    const n = loadHistory().length;
    if (!n) { toast('History is already empty'); return; }
    const yes = await confirmDialog({
      title: 'Clear measurement history?',
      body: `${n} saved measurement${n === 1 ? '' : 's'} will be deleted from this browser. This cannot be undone.`,
      confirmText: 'Delete all', danger: true,
    });
    if (!yes) return;
    clearHistory();
    renderHistory();
    log('warn', `Measurement history cleared (${n} entries)`);
    toast('History cleared');
  };
}

async function boot() {
  initLog($('log'));
  installGlobalHandlers();
  const buildEl = $('build-stamp');
  if (buildEl) { buildEl.textContent = BUILD; buildEl.title = `built ${BUILT_AT}`; }
  log('info', 'App loaded', {
    build: BUILD,
    builtAt: BUILT_AT,
    userAgent: navigator.userAgent,
    outputSwitchingSupported: state.switchable,
    engineDefaults: {
      repeats: DEFAULTS.repeats,
      sweepMs: DEFAULTS.sweepSec * 1000,
      gapMs: [DEFAULTS.gapMinSec * 1000, DEFAULTS.gapMaxSec * 1000],
      maxLagMs: DEFAULTS.maxLagSec * 1000,
      maxSpreadMs: DEFAULTS.maxSpreadMs,
    },
    screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}x`,
    secureContext: window.isSecureContext,
  });
  wireHandlers();
  renderHistory();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => log('info', 'Service worker registered — app shell will work offline'))
      .catch((e) => log('warn', 'Service worker registration failed', {error: e.message}));
  }

  const perm = await micPermissionState();
  log('info', `Microphone permission state: ${perm}`);
  if (perm === 'granted') {
    setStatus('mic-status', 'Microphone already authorised — starting…');
    await initMic();
  } else {
    setMicPill('needs permission', 'warn');
  }

  watchDeviceChanges(async () => {
    log('info', 'Browser reported an audio device change (plug/unplug or default changed)');
    if (state.stream) {
      await refreshDeviceLists();
      toast('Audio devices changed — list updated');
    }
  });

  autoConnectBridge();
}

boot();
