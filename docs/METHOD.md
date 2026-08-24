# Method: how the engine computes the number

## 1. The chain

An acoustic loopback measures a **round trip**:

```
RT = L_app_out + L_os_out + L_transport + L_dac_speaker
   + t_air
   + L_mic + L_os_in + L_app_in
```

We only want `L_transport + L_dac_speaker` (the Bluetooth/DAC part). Trying to
measure the input half absolutely is the hard, calibration-heavy path that
every desktop tool solves with a wired loopback cable.

## 2. Differential measurement — the whole trick

Measure twice, with the **same microphone and the same input settings**:

- `RT_ref` — through a reference output (built-in laptop speaker or a wired
  speaker/headphone).
- `RT_dut` — through the device under test (the Bluetooth device).

```
Δ = RT_dut − RT_ref
```

Every input-side term is identical in both and cancels exactly. The browser's
own buffering cancels. The mic's latency cancels. What survives is the extra
delay the Bluetooth path adds — **which is exactly the number to type into the
player.** This is why the app being "fast" doesn't matter; the measurement is
immune to the app's own latency by construction.

Air term: `t_air = distance / 343 m·s⁻¹` ≈ 2.91 ms/m. It cancels only if the
mic is roughly equidistant from both sources. UI asks for both distances when
they differ and corrects; default assumes equal and shows the residual as
error bars.

**Absolute mode** (secondary, lower trust): report `RT_dut` raw, plus an
estimate `RT_dut − L_input`, where `L_input` comes from either a one-time
wired-loopback calibration or `baseLatency + outputLatency`. Always labelled
as an estimate. The differential number is the product; this is a diagnostic.

## 3. Test signal

Linear sweep **500 Hz → 8000 Hz over 40 ms**, Hann-tapered at both ends,
played at about −12 dBFS.

- Below ~300 Hz: earbuds and laptop speakers roll off, no energy to correlate.
- Above ~10 kHz: lossy BT codecs low-pass aggressively; AAC especially.
- A sweep (not a click) spreads energy in time, so it survives a lossy codec
  and still compresses to a sharp matched-filter peak.
- 40 ms is long enough for a clean peak, short enough that 8 repeats finish in
  under 2 seconds.

Emitted as **8 repeats with randomised gaps** (150–300 ms). Randomised so a
periodic room resonance or interference can't lock onto the rhythm.

## 4. Detection

Direct time-domain **normalised cross-correlation** of the recording against
the reference sweep, over a bounded lag window of **0–600 ms**.

- 40 ms reference (1920 samples @ 48 kHz) × 28800 lags ≈ 55 M MAC — a few tens
  of ms in plain JS. No FFT library, no `ConvolverNode`, and it runs unchanged
  in Node so the core is testable headlessly.
- Normalised (by the local energy of the recording window) so a loud room or a
  quiet device doesn't bias the peak.
- **First-peak rule:** take the earliest lag whose correlation exceeds 0.7 ×
  the maximum, not the global maximum. Direct sound always arrives before its
  reflections; a reflection can otherwise win on amplitude.
- **Sub-sample refinement:** parabolic interpolation over the three samples
  around the chosen peak. Resolution 0.02 ms — far past what we need, but free.

## 5. Rejecting bad measurements

A number nobody can trust is worse than no number.

- **Peak quality:** ratio of peak energy to the RMS of the rest of the
  correlation must exceed **18 dB** (threshold borrowed from weblatencytest).
  Below → reject with a cause: too quiet, too noisy, wrong output device.
- **Consistency:** median absolute deviation across the 8 repeats must be
  **< 3 ms**. Above → the link is unstable; report the spread and say so.
- **Clipping / silence:** pre-flight level check on the mic before measuring.
- **Constraint verification:** `track.getSettings()` must confirm
  `echoCancellation`, `noiseSuppression`, `autoGainControl` are all off. If the
  browser refused, warn loudly — AEC will silently cancel the test signal.
- **Input device pinning:** record the input `deviceId` and `groupId` for the
  reference run and require it to be identical for every device run. Guards
  against the HFP flip (see RESEARCH.md §6.2).

## 6. Output

`Δ = +180 ms` means the Bluetooth audio arrives 180 ms **late**, so the player
must play audio **earlier**:

| player | value |
|---|---|
| VLC — Audio track synchronization | `-180 ms` |
| mpv | `--audio-delay=-0.180` |
| Plex / Kodi audio offset | `-180 ms` |
| ffmpeg re-mux | `-itsoffset -0.180` |

Sign convention is derived once, in code, with a test — not left to the user.

## 7. Error budget

| source | contribution |
|---|---|
| correlation peak resolution | ±0.02 ms |
| output/input clock drift over 2 s | ±0.2 ms |
| mic distance mismatch, 0.3 m | ±0.9 ms |
| BT link jitter (run to run) | ±1–5 ms (reported, not hidden) |
| **usable total** | **≈ ±5 ms** |

Against a 150–200 ms Bluetooth delay and a ±45 ms perceptual tolerance, this
is comfortable.
