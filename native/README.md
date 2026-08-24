# delayprobe — native WASAPI probe

A Windows measurement tool for the cases the browser cannot do accurately.

## Why this exists

The web app is limited by what Chrome will give it:

- **Dropped capture frames.** A real session lost 298 ms of input mid-capture
  because Chrome's audio thread was preempted. Every sample after a drop is
  shifted, so the delay is wrong rather than noisy — the web app can only
  detect this and discard the run.
- **Shared-mode output.** Chrome renders through the Windows mixer, which adds
  its own resampling and buffering. The differential cancels it only while it
  stays constant between runs, which is not guaranteed across a sink switch.
- **No digital tap.** The browser can only hear the result acoustically, so it
  cannot separate "delay before the DAC" from "delay after it".

This tool addresses all three: MMCSS **Pro Audio** thread priority and
`High` process priority so captures are not preempted, optional **exclusive
mode** to bypass the mixer entirely, and optional **loopback** capture of the
digital stream.

The DSP in `Dsp.cs` is a deliberate straight port of `src/engine.js`. If the
two disagreed on the maths, comparing their numbers would say nothing about
the audio path — which is the whole point of having both.

## Build

```bash
cd native/DelayProbe
dotnet publish -c Release -o ../dist
```

Produces a self-contained `native/dist/delayprobe.exe` with no runtime to
install.

## Use

```bash
delayprobe devices
delayprobe measure --output 3 --rounds 5
delayprobe measure --output "Bluetooth" --exclusive --rounds 5 --json
delayprobe serve --port 8765
```

Exit code is 0 only when every round produced a trustworthy result, so it can
be scripted.

### Interactive mode

Running `delayprobe.exe` with **no arguments** from a real console (that is,
double-clicking it in Explorer) opens a numbered menu — list devices, run a
measurement, show Voicemeeter state, start the bridge server, quit — and waits
for input, so the window no longer flashes open and vanish.

With any argument, or when stdin is redirected (pipes, CI, scripts), behaviour
and exit codes are exactly as before. `delayprobe --help` still prints help.

### Bridge server

```bash
delayprobe serve [--port 8765]
```

Runs a small HTTP server so the hosted web app can drive the native probe.

**It binds to `127.0.0.1` only, never `0.0.0.0`.** This endpoint plays audio and
rewrites Voicemeeter routing; nothing on the LAN should be able to do that. It
also avoids the administrator-level URL ACL a wildcard prefix would require.

**Mixed content — why plain HTTP works from an HTTPS page.** A page served over
`https://` is normally forbidden from fetching `http://` URLs. The exception is
that browsers treat `http://127.0.0.1` as a *potentially trustworthy* origin
(W3C Secure Contexts), so Chrome and Edge allow it with no certificate
anywhere. Fetch the **literal `127.0.0.1`**, not `localhost` — the literal is
the reliably-trusted form.

Every response, including 4xx and 5xx, carries:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

and `OPTIONS` preflight answers `204`. A missing CORS header on an error
response surfaces in the browser as an opaque network failure instead of the
status actually sent, which is why they go on everything.

| Route | Body | Returns |
|---|---|---|
| `GET /health` | — | `{ok, app, version, voicemeeter:{available, running, type}}` |
| `GET /devices` | — | `{render:[{index,id,name}], capture:[…]}` |
| `POST /measure` | `{output, input, exclusive, repeats, rounds}` | `{ok, output, input, mode, rounds:[…], medianDelayMs}` |
| `GET /voicemeeter/state` | — | `{available, running, type, buses:[…], strips:[…]}` |
| `POST /voicemeeter/route` | `{strip:int, a:[bool,…]}` | `{ok:true}` |
| `POST /voicemeeter/delay` | `{bus:int, ms:0..500}` | `{ok:true}` |
| `POST /voicemeeter/bus-device` | `{bus:int, device:str, driver:"wdm"\|"ks"\|"mme"}` | `{ok:true}` |

Unknown paths return `404 {"ok":false,"error":…}`; a handler exception returns
`500 {"ok":false,"error":…}` and the server keeps running. `/measure` goes
through the same code path as `delayprobe measure` — the DSP is not forked.

## Voicemeeter

`VoicemeeterControl.cs` wraps `VoicemeeterRemote64.dll`, whose location is read
from the Windows uninstall registry key (it is not on `PATH`, and the install
folder differs between builds), with the well-known `Program Files` paths as a
fallback. Voicemeeter is optional: with it absent or stopped, every call
reports `available:false` / `running:false` rather than throwing.

It matters here because measuring two outputs is only half the job:

- **Routing** — `Strip[i].A1`, `A2`, … Setting two of them to `1` is how one
  source is played to two physical outputs at once.
- **Delay** — `Option.delay[i]`, 0–500 ms per bus. This is the knob that holds
  the wired output back until it lines up with the Bluetooth one.
- **Bus device** — `Bus[i].device.wdm` / `.ks` / `.mme` (write-only; the result
  reads back from `Bus[i].device.name`).

All Voicemeeter indices are **zero-based**: `Bus[0]` is the bus labelled "A1"
in the GUI, `Strip[0]` is the leftmost input strip. Bus/strip counts come from
the edition (`VBVMR_GetVoicemeeterType`: 1 = Standard/2 buses, 2 = Banana/5,
3 = Potato/8).

## Status — read this before trusting a number

**The bridge, device enumeration and Voicemeeter control work. The measurement path does not
produce a usable number on this machine yet.**

Verified working:
- `delayprobe devices`, the interactive menu, and `delayprobe serve` (health, devices,
  voicemeeter state, CORS preflight, error handling).
- Voicemeeter control, exercised against a live Voicemeeter Banana: edition detection, bus
  labels and devices, `Option.delay[i]`, and strip A/B routing read+write.

Known broken:
- **`measure` captures silence.** On this machine the capture stream opens correctly
  (48 kHz, 2 ch, 32-bit float, matching the render endpoint) and delivers the right number of
  buffers, but every sample is ~-110 dBFS RMS — digital silence, not a quiet room. Windows
  hands silence rather than an error to a desktop app that lacks microphone permission, which
  is the most likely cause. Check:
  `Settings -> Privacy & security -> Microphone -> Let desktop apps access your microphone`.
  The tool now reports the captured peak level and rejects the run with an explicit reason
  instead of returning `NaN`, so this is at least diagnosable.
- **Absolute latency is not calibrated.** `WasapiOut.Play()` returns before audio actually
  leaves the endpoint, so the emission reference understates the true start by roughly the
  output buffer latency. A *differential* between two devices measured identically is
  unaffected; a single absolute figure from this tool is not yet trustworthy. The browser app
  solves the equivalent problem by emitting from inside the capture worklet so both timestamps
  come from one clock; the native path needs the analogous fix (an
  `IAudioClock`/`GetPosition`-based reference, or loopback capture as the timing reference).
- `--loopback` only opens the stream; the before/after-the-DAC split is not implemented.
- Exclusive mode, and the Standard/Potato Voicemeeter editions, are compiled but never run.

Until the capture-silence issue is resolved, use the web app at https://delay.losthusky.qzz.io
for measurements and this tool for Voicemeeter control and device enumeration.
