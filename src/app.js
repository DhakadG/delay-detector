// UI glue. No logic lives here that isn't about the DOM.
import {differential, playerOffsets} from './engine.js';
import {
  openMic, listDevices, canSwitchOutput, measureOnce, micPermissionState,
  watchDeviceChanges, attachLiveMeter,
} from './capture.js';
import {enhanceSelect} from './dropdown.js';
import {initLog, log, exportLog, clearLog} from './log.js';
import {loadHistory, saveEntry, clearHistory, toCsv} from './store.js';

const $ = (id) => document.getElementById(id);
const isVirtual = (label) => /voicemeeter|vb-audio|virtual cable/i.test(label || '');

const state = {
  ctx: null, stream: null,
  currentInputId: null, refDeviceId: null, dutDeviceId: null,
  refMs: null, refDistanceM: null,
  switchable: canSwitchOutput(),
  meterStop: null,
  warnedVirtual: false,
  peakHold: -60, peakHoldT: 0,
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
    if (state.meterStop) state.meterStop();
    state.stream = stream;
    state.currentInputId = settings.deviceId || null;

    if (!state.ctx) state.ctx = new AudioContext({latencyHint: 'interactive'});
    await state.ctx.resume();

    log(warnings.length ? 'warn' : 'ok', 'Microphone opened', {
      sampleRate: state.ctx.sampleRate,
      deviceId: settings.deviceId,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    });

    state.meterStop = attachLiveMeter(state.ctx, state.stream, updateMeter);
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

  if (state.switchable && outputs.length) {
    fill($('sel-ref'), outputs, state.refDeviceId);
    fill($('sel-dut'), outputs, state.dutDeviceId);
    $('field-ref').hidden = false;
    $('field-dut').hidden = false;
    $('dut-help').textContent =
      'Pick a device. The page switches the output itself, so you can work through the list without touching system settings.';
  } else {
    $('dut-help').textContent =
      'This browser cannot switch the audio output from a web page. Change your system output device to the one you want to test, then press the button below. Repeat for each device.';
  }
  warnIfVirtual([...inputs, ...outputs]);
}

// -------------------------------------------------------------- measure ---

async function run(which) {
  const statusId = which === 'ref' ? 'ref-status' : 'dut-status';
  const sel = which === 'ref' ? $('sel-ref') : $('sel-dut');
  const btn = which === 'ref' ? $('btn-ref') : $('btn-dut');
  const usingSel = state.switchable && !sel.hidden;
  const deviceLabel = usingSel ? label(sel) : 'Current system output';
  btn.disabled = true;

  try {
    if (usingSel) {
      log('info', 'Switching output sink', {to: deviceLabel});
      await state.ctx.setSinkId(sel.value);
      await new Promise((r) => setTimeout(r, 800)); // Bluetooth re-negotiation isn't instant
    }
    setStatus(statusId, 'Measuring — keep the room quiet…');
    log('info', `Measurement started (${which})`, {device: deviceLabel});
    const t0 = performance.now();
    const r = await measureOnce(state.ctx, state.stream);
    const tookMs = Math.round(performance.now() - t0);

    if (r.delayMs == null) {
      log('bad', `Measurement rejected (${which})`, {reason: r.reason, discarded: r.rejected.length, tookMs});
      setStatus(statusId, `Rejected: ${r.reason}. ${r.hint || ''}`, 'bad');
      return;
    }

    log(r.ok ? 'ok' : 'warn', `Measurement complete (${which})`, {
      device: deviceLabel, delayMs: +r.delayMs.toFixed(2), spreadMs: +r.spreadMs.toFixed(2),
      qualityDb: +r.qualityDb.toFixed(1), usedRepeats: r.usedRepeats, discarded: r.rejected.length, tookMs,
    });

    const confidence = r.ok ? 'ok' : 'warn';
    const caveat = r.ok ? '' : ` — spread wider than usual (${r.reason}), treat as approximate`;

    if (which === 'ref') {
      state.refMs = r.delayMs;
      state.refDeviceId = usingSel ? sel.value : null;
      state.refDistanceM = parseFloat($('in-ref-distance').value) || null;
      setStatus(statusId,
        `Reference round trip ${r.delayMs.toFixed(1)} ms (spread ±${r.spreadMs.toFixed(1)} ms, ` +
        `peak ${r.qualityDb.toFixed(0)} dB)${caveat}. Now measure your devices.`, confidence);
      setCardEnabled('card-dut', true);
      setStep('ref', 'done');
      setStep('dut', 'current');
    } else {
      if (state.refMs == null) { setStatus(statusId, 'Measure the reference first.', 'bad'); return; }
      const dutDistanceM = parseFloat($('in-dut-distance').value) || null;
      const {deltaMs, airCorrectionMs} = differential(state.refMs, r.delayMs, {
        refDistanceM: state.refDistanceM, dutDistanceM,
      });
      if (airCorrectionMs) log('info', 'Applied air-propagation correction for unequal mic distance', {airCorrectionMs: +airCorrectionMs.toFixed(2)});

      const o = playerOffsets(deltaMs);
      saveEntry({
        timestamp: new Date().toISOString(),
        device: deviceLabel, deltaMs, spreadMs: r.spreadMs, confident: r.ok,
        vlc: o.vlc, mpv: o.mpv, plex: o.plex, kodi: o.kodi, ffmpeg: o.ffmpeg,
      });
      renderHistory();
      setStatus(statusId,
        `${o.summary} (round trip ${r.delayMs.toFixed(1)} ms, spread ±${r.spreadMs.toFixed(1)} ms)${caveat}`, confidence);
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
    const tr = document.createElement('tr');
    if (!h.confident) tr.className = 'warn';
    tr.innerHTML =
      `<td>${escapeHtml(h.device)}${h.confident ? '' : ' <span class="badge warn">approx</span>'}</td>` +
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

  $('btn-clear-history').onclick = () => {
    if (!confirm('Clear all saved measurement history? This cannot be undone.')) return;
    clearHistory();
    renderHistory();
    log('warn', 'Measurement history cleared');
  };
}

async function boot() {
  initLog($('log'));
  log('info', 'App loaded', {
    userAgent: navigator.userAgent,
    outputSwitchingSupported: state.switchable,
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
