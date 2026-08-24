# Research: audio output latency measurement

Date: 2026-08-24. Scope: what exists, how industry measures this, what the gap is.

## 1. The problem, stated precisely

User-visible symptom: Bluetooth audio lags video, lips out of sync. Fix is a
per-device constant offset typed into the player (VLC "Audio track
synchronization", mpv `--audio-delay`, Plex "Audio offset").

What we must produce is **not** absolute latency. It is the *signed offset*
that makes a given output device line up with video. That distinction removes
most of the hard calibration work — see METHOD.md.

## 2. How much delay, and how accurate must we be?

Typical Bluetooth codec round-trip (chipset/firmware dependent, these are
ballparks not guarantees):

| codec | typical latency |
|---|---|
| LC3 / LE Audio | ~20–50 ms |
| aptX Low Latency | ~40 ms |
| aptX Adaptive | ~50–80 ms |
| aptX Classic | ~70 ms |
| SBC | ~150–200 ms |
| AAC | ~150–200 ms (much worse on some Android stacks) |
| LDAC | ~200 ms |

Perceptual tolerance (this sets our accuracy target):

| standard | tolerance (audio lead / audio lag) |
|---|---|
| ITU-R BT.1359-1 — detectability | +45 ms / −125 ms |
| ITU-R BT.1359-1 — acceptability, end to end | +90 ms / −185 ms |
| EBU R37 | +40 ms / −60 ms |
| ATSC IS-191 (encoder input) | +15 ms / −45 ms |
| Film convention | ±22 ms |

**Conclusion: ±5 ms accuracy is comfortably sufficient; ±1 ms is a stretch
goal and is free with sample-level cross-correlation (0.02 ms/sample @ 48 kHz).**
Anything claiming better precision than the run-to-run variance of the
Bluetooth link itself is false precision — BT latency is not perfectly
constant, so we must report a spread, not a single number.

## 3. Prior art

### Open source, directly relevant

- **[gilpanal/weblatencytest](https://github.com/gilpanal/weblatencytest)** (MIT, 2024, from Hi-Audio).
  Closest prior art. Browser-based: plays an MLS sequence via Web Audio,
  records via getUserMedia, cross-correlates. Validates the result with a
  **peak-energy vs rest-of-signal-energy ratio, threshold +18 dB** — a good
  idea we should copy outright.
  *Limits:* measures round-trip only, no device enumeration/switching, no
  differential isolation of the output path, no A/V offset output, no
  multi-device workflow.
- **[xjr00t/xjaudiolatencytester](https://github.com/xjr00t/xjaudiolatencytester)**.
  Windows desktop. Linear chirp 200→8000 Hz over 100 ms, normalized
  cross-correlation, coarse pass then fine pass around the peak, ~1-sample
  precision. Confirms chirp + normalized xcorr as the standard approach.
- **[AVLatency/Latency-Measurement](https://github.com/AVLatency/Latency-Measurement)** (MIT).
  The most rigorous consumer-grade tool. Measures HDMI/eARC/Bluetooth sink
  latency using a **wired hardware loopback** (headphone-out → line-in), not
  a microphone. Windows only. Gold standard for accuracy, zero portability.
- **[chemag/audiolat](https://github.com/chemag/audiolat)**. Android
  ear-to-mouth latency app. Same physics, native, single platform.
- **[google/audio-sync-kit](https://github.com/google/audio-sync-kit)**.
  Offline analysis of an already-recorded A/V file. Different problem
  (verification, not calibration).
- **[alopatindev/sync-audio-tracks](https://github.com/alopatindev/sync-audio-tracks)**,
  **[freemocap/skelly_synchronize](https://github.com/freemocap/skelly_synchronize)**.
  Post-hoc alignment of two recordings by cross-correlation. Confirms the
  algorithm, not the use case.

### Closed / web "latency testers"

[mictest.dev](https://mictest.dev/audio-latency-test),
[onlineaudiotest.com](https://onlineaudiotest.com/latency-test/),
[wutools](https://wutools.com/hardware/diagnostics/audio-latency-tester),
[diagno](https://diagno.patrache.studio/en/connectivity/bluetooth-latency/).
Most of these report `AudioContext.outputLatency` or a click-to-tap reaction
time. Neither is an acoustically verified measurement, and neither includes
the Bluetooth codec delay — which is the entire thing the user cares about.
One of them says so in its own disclaimer. **This is the credibility gap.**

## 4. The gap we fill

Nothing found does all of:

1. Acoustically verified (real microphone, real air), not an API estimate.
2. **Differential** — isolates the *output* path so the answer is directly
   usable, without needing to know the microphone's latency.
3. Per-device, with a multi-device sweep in one session.
4. Cross-platform with zero install (browser).
5. Emits a signed, copy-paste offset for VLC / mpv / Plex / Kodi, with the
   sign convention already worked out.

## 5. Hard platform constraints (found, not assumed)

| capability | Chromium desktop | Firefox desktop | Safari macOS | Chrome Android | Safari iOS |
|---|---|---|---|---|---|
| `enumerateDevices` outputs | yes | partial | no | no | no |
| `AudioContext.setSinkId` | yes | partial/flagged | **no** | **no** | **no** |
| `getUserMedia` raw mic (AEC/NS/AGC off) | yes | yes | yes | yes | unreliable |
| `AudioContext.baseLatency` | yes (since 2021) | yes | yes | yes | yes |
| `AudioContext.outputLatency` | yes (since 2025) | yes | yes | yes | yes |

**Consequence:** fully autonomous "cycle through all my devices" is
**Chromium-desktop-only**. Everywhere else the flow is: user switches the
system output device, app measures, repeat. That is one OS click per device
and still solves the problem. Building four native apps to avoid one click is
not worth it — revisit only if users actually ask.

`setSinkId` additionally requires HTTPS + a user gesture + mic permission
already granted.

## 6. Failure modes discovered (must be designed against)

1. **Browser echo cancellation will delete our test signal.** AEC is on by
   default in `getUserMedia`. Must request
   `echoCancellation:false, noiseSuppression:false, autoGainControl:false`
   and verify via `track.getSettings()` that the browser honoured it.
2. **HFP mode flip.** On Windows and Android, connecting BT earbuds often
   switches the *default input* to the headset's mic, putting the link into
   hands-free profile — different codec, different latency, 8/16 kHz mic.
   The app must pin the input device explicitly and detect if it changed
   between runs, otherwise every number is garbage.
3. **Room reflections.** A strong reflection can sum above the direct
   arrival. Pick the *first* correlation peak above a fraction of the max,
   not the global max.
4. **Air propagation.** 2.91 ms per metre at 20 °C. Matters only if the
   reference speaker and the device under test are at very different
   distances from the mic.
5. **BT link jitter / dropouts.** Single-shot measurement is not trustworthy.
   Repeat and take the median plus a spread.
6. **Output/input clock domains differ.** ±100 ppm drift over a 2 s capture
   is ~0.2 ms. Below our error budget; ignore, but note the ceiling.
