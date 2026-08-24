// UI glue. No logic lives here that isn't about the DOM.
import {differential, playerOffsets, DEFAULTS, median, mad} from './engine.js';
import {
  openMic, listDevices, canSwitchOutput, measureOnce, micPermissionState,
  watchDeviceChanges, attachLiveMeter,
} from './capture.js';
import {enhanceSelect} from './dropdown.js';
import {initLog, log, exportLog, clearLog, installGlobalHandlers} from './log.js';
import {loadHistory, saveEntry, clearHistory, toCsv} from './store.js';
import {BUILD, BUILT_AT} from './version.js';
import {buildBatchPlan, estimateBatchSeconds, summariseBatch} from './batch.js';
import {confirmDialog} from './dialog.js';

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
  peakHold: -60, peakHoldT: 0,
  outputs: [],
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

// ---------------------------------------------------------------- meter ---

function updateMeter({peakDb, rmsDb}) {
  const now = performance.now();
  if (peakDb > state.peakHold || now - state.peakHoldT > 1400) {
    state.peakHold = peakDb; state.peakHoldT = now;
  } else {
    state.peakHold = Math.max(peakDb, state.peakHold - 0.7);
  }
  const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meter-fill').style.width = pct(rmsDb) + '%';
  $('meter-peak').style.left = pct(state.peakHold) + '%';
  const cls = peakDb > -3 ? 'bad' : peakDb < -45 ? 'warn' : 'ok';
  const lbl = $('meter-label');
  lbl.textContent = `${rmsDb.toFixed(0)} dB · peak ${peakDb.toFixed(0)} dB`;
  lbl.className = 'meter-label mono ' + cls;
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

    state.meter = attachLiveMeter(state.ctx, state.stream, {
      onLevel: updateMeter, waveCanvas: $('scope-wave'), stripCanvas: $('scope-strip'),
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
async function performMeasurement({deviceId, label, tag}) {
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

  if (state.ctx.state !== 'running') {
    log('warn', 'AudioContext not running at measurement start — resuming', {state: state.ctx.state});
    await state.ctx.resume();
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
    log('bad', 'Audio thread dropped frames during capture — discarding this run', {
      device: label, droppedFrames: r.droppedFrames, droppedMs, tookMs,
    });
    return {error: `the audio thread dropped ${droppedMs} ms of capture`};
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
}

boot();
