// UI glue. No logic lives here that isn't about the DOM.
import {differential, playerOffsets} from './engine.js';
import {
  openMic, listDevices, canSwitchOutput, levelCheck, measureOnce, inputFingerprint,
} from './capture.js';
import {enhanceSelect} from './dropdown.js';

const isVirtual = (label) => /voicemeeter|vb-audio|virtual cable/i.test(label || '');

const $ = (id) => document.getElementById(id);
const log = (msg) => { $('log').textContent += msg + '\n'; };
const show = (id) => $(id).removeAttribute('hidden');

const state = {ctx: null, stream: null, fingerprint: null, refMs: null, switchable: canSwitchOutput()};

function setStatus(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'note ' + cls;
}

$('btn-mic').onclick = async () => {
  try {
    const {stream, settings, warnings} = await openMic();
    state.stream = stream;
    state.fingerprint = inputFingerprint(settings);
    state.ctx = new AudioContext({latencyHint: 'interactive'});
    await state.ctx.resume();

    const {inputs, outputs} = await listDevices();
    fill($('sel-input'), inputs, settings.deviceId);
    $('sel-input').hidden = false;
    warnIfVirtual([...inputs, ...outputs]);
    $('sel-input').onchange = async () => {
      const {stream: s, settings: st} = await openMic($('sel-input').value);
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = s;
      state.fingerprint = inputFingerprint(st);
      setStatus('mic-status', 'Input pinned to ' + label($('sel-input')));
    };

    if (warnings.length) {
      setStatus('mic-status',
        `Warning: the browser kept ${warnings.join(', ')} enabled. Echo cancellation will ` +
        `cancel the test signal — results here are not trustworthy.`, 'bad');
    } else {
      setStatus('mic-status',
        `Raw capture at ${state.ctx.sampleRate} Hz. Echo cancellation, noise suppression and AGC are off.`, 'ok');
    }

    if (state.switchable && outputs.length) {
      fill($('sel-ref'), outputs); $('sel-ref').hidden = false;
      fill($('sel-dut'), outputs); $('sel-dut').hidden = false;
      $('dut-help').textContent =
        'Pick a device. The page switches the output itself, so you can work through the list without touching system settings.';
    } else {
      $('dut-help').textContent =
        'This browser cannot switch the audio output from a web page. Change your system output device to the one you want to test, then press the button below. Repeat for each device.';
    }
    $('btn-mic').disabled = true;
    show('step-level'); show('step-ref'); show('step-dut');
  } catch (e) {
    setStatus('mic-status', 'Could not open the microphone: ' + e.message, 'bad');
  }
};

$('btn-level').onclick = async () => {
  setStatus('level-status', 'listening…');
  const l = await levelCheck(state.ctx, state.stream);
  $('meter').value = Math.max(-60, l.peakDb);
  if (l.peakDb > -3) setStatus('level-status', `Peak ${l.peakDb.toFixed(0)} dBFS — clipping. Turn the volume down.`, 'bad');
  else if (l.peakDb < -45) setStatus('level-status', `Peak ${l.peakDb.toFixed(0)} dBFS — very quiet. Check the mic is not muted.`, 'warn');
  else setStatus('level-status', `Peak ${l.peakDb.toFixed(0)} dBFS, RMS ${l.rmsDb.toFixed(0)} dBFS. Fine.`, 'ok');
};

$('btn-ref').onclick = () => run('ref');
$('btn-dut').onclick = () => run('dut');

async function run(which) {
  const statusId = which === 'ref' ? 'ref-status' : 'dut-status';
  const sel = which === 'ref' ? $('sel-ref') : $('sel-dut');
  const btn = which === 'ref' ? $('btn-ref') : $('btn-dut');
  btn.disabled = true;

  try {
    if (state.switchable && !sel.hidden) {
      await state.ctx.setSinkId(sel.value);
      // let the OS finish routing (Bluetooth re-negotiation is not instant)
      await new Promise((r) => setTimeout(r, 800));
    }
    setStatus(statusId, 'measuring — keep the room quiet…');
    const r = await measureOnce(state.ctx, state.stream);

    // r.delayMs is missing only when fewer than 3 repeats produced any usable
    // peak at all — that is the one case with nothing worth showing.
    if (r.delayMs == null) {
      setStatus(statusId, `Rejected: ${r.reason}. ${r.hint || ''}`, 'bad');
      log(`[${which}] rejected — ${r.reason}; ${r.rejected.length} repeats discarded`);
      return;
    }

    // r.ok false but delayMs present means the spread across repeats was
    // wider than the trust threshold — still a real number, just noisier
    // than usual (common with Bluetooth or a Voicemeeter-routed device).
    const confidence = r.ok ? 'ok' : 'warn';
    const caveat = r.ok ? '' : ` — spread wider than usual (${r.reason}), treat as approximate`;

    if (which === 'ref') {
      state.refMs = r.delayMs;
      setStatus(statusId,
        `Reference round trip ${r.delayMs.toFixed(1)} ms (spread ±${r.spreadMs.toFixed(1)} ms, ` +
        `peak ${r.qualityDb.toFixed(0)} dB)${caveat}. Now measure your devices.`, confidence);
    } else {
      if (state.refMs == null) { setStatus(statusId, 'Measure the reference first.', 'bad'); return; }
      const {deltaMs} = differential(state.refMs, r.delayMs);
      addResult(sel.hidden ? 'Current system output' : label(sel), deltaMs, r.spreadMs, r.ok);
      setStatus(statusId,
        `${playerOffsets(deltaMs).summary} (round trip ${r.delayMs.toFixed(1)} ms, ` +
        `spread ±${r.spreadMs.toFixed(1)} ms)${caveat}`, confidence);
      show('step-results');
    }
  } catch (e) {
    setStatus(statusId, 'Failed: ' + e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

function addResult(name, deltaMs, spreadMs, confident) {
  const o = playerOffsets(deltaMs);
  const tr = document.createElement('tr');
  if (!confident) tr.className = 'warn';
  tr.innerHTML =
    `<td>${escapeHtml(name)}${confident ? '' : ' <span class="note">(approx)</span>'}</td>` +
    `<td>${deltaMs >= 0 ? '+' : ''}${deltaMs.toFixed(0)} ms</td>` +
    `<td>±${spreadMs.toFixed(1)} ms</td>` +
    `<td><code>${o.vlc}</code></td>` +
    `<td><code>${o.mpv}</code></td>`;
  $('results').querySelector('tbody').appendChild(tr);
}

function fill(sel, devices, selectedId) {
  sel.innerHTML = '';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    const name = d.label || `${d.kind} ${d.deviceId.slice(0, 8)}`;
    opt.textContent = isVirtual(name) ? `${name} · virtual` : name;
    if (isVirtual(name)) opt.dataset.virtual = '1';
    if (d.deviceId === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  enhanceSelect(sel);
}

function warnIfVirtual(devices) {
  if (!devices.some((d) => isVirtual(d.label))) return;
  log('Voicemeeter (or another virtual audio cable) is installed. Its virtual devices ' +
    'are marked "· virtual" below. They sit in the audio path and add their own buffering, ' +
    'which this app cannot see through — for a real reading, measure your reference and the ' +
    'device under test on the same routing you actually use for playback (either both through ' +
    'Voicemeeter, or both bypassing it), not one of each.');
}

const label = (sel) => sel.options[sel.selectedIndex]?.textContent || '';
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
