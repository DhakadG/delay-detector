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

## How to run

There is no `delayprobe` on your `PATH`. The build puts the exe under
`bin\Release\...`, so typing `delayprobe` in the source folder gives
`'delayprobe' is not recognized`. Use one of the two routes below, and type the
commands exactly — the `<angle brackets>` in older docs were placeholders, not
something to type.

### Route 1 — publish to `native\dist` (recommended)

```powershell
cd "C:\Users\lost_husky\Downloads\Programs\VS Code Works\delay-detector\native\DelayProbe"
dotnet publish -c Release -o ..\dist
cd ..\dist
.\delayprobe.exe devices
```

`dist\delayprobe.exe` is self-contained: no .NET runtime to install, and it can
be copied anywhere. From then on, `cd` into `native\dist` and prefix commands
with `.\` — PowerShell will not run an exe from the current directory without
it.

### Route 2 — run straight out of the build folder

```powershell
cd "C:\Users\lost_husky\Downloads\Programs\VS Code Works\delay-detector\native\DelayProbe"
dotnet build -c Release
.\bin\Release\net8.0-windows\win-x64\delayprobe.exe devices
```

### Real commands

```powershell
.\delayprobe.exe devices
.\delayprobe.exe listen --input 1 --seconds 5
.\delayprobe.exe listen --input 1 --seconds 5 --raw
.\delayprobe.exe measure --output 2 --input 1 --rounds 3
.\delayprobe.exe measure --output "Realtek" --input 1 --exclusive --rounds 5 --json
.\delayprobe.exe voicemeeter
.\delayprobe.exe logs --open
.\delayprobe.exe serve --port 8765
```

`--output` and `--input` take the **index** from `delayprobe devices`, the full
endpoint **ID**, or any **substring** of the friendly name. Exit code is 0 only
when every round produced a trustworthy result, so it can be scripted.

### Interactive mode

Running `delayprobe.exe` with **no arguments** from a real console (that is,
double-clicking it in Explorer) opens a numbered menu — devices, measurement,
Voicemeeter state, bridge server, capture diagnostic, run-log folder — and waits
for input, so the window no longer flashes open and vanishes.

With any argument, or when stdin is redirected (pipes, CI, scripts), behaviour
and exit codes are unchanged. `delayprobe --help` still prints help.

## Diagnosing a bad capture

```powershell
.\delayprobe.exe listen --input 1 --seconds 5 --raw
```

`listen` captures only — no playback, no DSP — and prints the negotiated format
(including the `WaveFormatExtensible` SubFormat GUID), the endpoint volume and
mute state, per-channel peak/RMS every 100 ms, and with `--raw` a hex dump of
the first non-silent buffer next to its float32 / int32 / int16 readings.

Two flags split "is it us, or is it the machine":

- `--processed` leaves the endpoint's audio-processing objects in the path.
  This is what NAudio does by default, and it is what used to break `measure` —
  see Status.
- `--winmm` captures the same device over WinMM instead of WASAPI.

## Run logs

Every measurement — CLI, interactive menu, or bridge — writes to:

```
%LOCALAPPDATA%\delayprobe\runs\YYYY-MM-DD\HHMMSS-<device>\
    run.json   per-repeat delays, formats, capture levels, options
    run.log    the console transcript of that run
```

`delayprobe logs` prints the folder; `delayprobe logs --open` opens it in
Explorer. Logging failures are swallowed — a full disk must not cost you a
measurement you just spent ten seconds making noise for.

### Bridge server

```powershell
.\delayprobe.exe serve --port 8765
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

Strings are read with **`VBVMR_GetParameterStringW`**, not the ANSI form. The
ANSI entry point substitutes `?` for anything outside the codepage (the emoji in
"Speakers (LotsOfHusky 👀)") and, on this machine, returned nothing at all for
`Bus[i].device.name` when `i > 0`. Where a `Label` is empty — the normal state
until the user types one — the GUI name (`A1`, `A2`, …, `B1`) is shown instead
of a blank cell.

### Client registration

The Remote API supports **at most 4 client applications at once**
(`VoicemeeterRemoteAPI.txt` §1) and provides **no function to enumerate or evict
registered clients**. There is no such entry point in the DLL, so no tool can
show you who is holding a slot; the only defence is that every client logs in
once and logs out on the way out.

`delayprobe` logs in lazily, exactly once per process (guarded in
`VoicemeeterControl.Connect`), and calls `VBVMR_Logout` from
`AppDomain.ProcessExit` and `Console.CancelKeyPress` — covering a normal exit,
quitting the interactive menu, Ctrl+C, and bridge shutdown. If you have stray
clients from other applications, the fix is to close them or restart
Voicemeeter; this tool cannot evict them.

All Voicemeeter indices are **zero-based**: `Bus[0]` is the bus labelled "A1"
in the GUI, `Strip[0]` is the leftmost input strip. Bus/strip counts come from
the edition (`VBVMR_GetVoicemeeterType`: 1 = Standard/2 buses, 2 = Banana/5,
3 = Potato/8).

## Status — read this before trusting a number

### Verified by running, on this machine, against live hardware

**Capture is fixed.** `measure` was recording silence because the Realtek
"Microphone Array" endpoint runs a noise-suppression APO in the shared-mode
signal path that emits **exact digital zeros** for anything it does not classify
as speech — including every measurement sweep. Opening the capture client with
`AUDCLNT_STREAMOPTIONS_RAW` bypasses the endpoint's APO chain. Same mic, same
minute, `delayprobe listen`:

| stream | peak | RMS |
|---|---|---|
| `--processed` (what NAudio does by default) | **-240 dBFS** (all-zero buffers) | -240 dBFS |
| RAW (now the default) | **-3.3 dBFS** | **-33.3 dBFS** |

The RAW RMS matches what Chrome reports for the same microphone, because
`getUserMedia` with the processing constraints off asks for the same raw stream.
`--winmm` reads ~-90 dBFS, i.e. WinMM goes through the same APO chain and is
*not* a workaround — the fault was never in the WASAPI setup, the byte decoding,
or device permissions.

NAudio 2.2.1 exposes no hook for this, so `RawMode` reaches the underlying
`IAudioClient2` through two private fields of the pinned NAudio version. If a
future NAudio breaks that, RAW is reported as DENIED and capture continues
processed rather than failing.

Also verified by running:

- `delayprobe measure` end to end: 2/2 good rounds, jitter ±0.0001 ms,
  correlation peak ~25 dB, capture peak -11 dBFS.
- `delayprobe listen` with `--raw`, `--processed`, `--winmm` and `--legacy`.
- `delayprobe devices`, `delayprobe voicemeeter`, `delayprobe logs`.
- Run logging: `run.json` + `run.log` written per measurement.
- `delayprobe serve`: `/health` and `/voicemeeter/state` against the live
  Banana instance.
- Voicemeeter Banana, live: edition detection, bus device names for **all**
  physical buses (A1/A2/A3), label fallbacks, `Option.delay[i]`, and strip A/B
  routing — **read only. Nothing was written to the live instance.**

### Compiled but not exercised

- Exclusive-mode render, `--loopback`, and the Voicemeeter Standard/Potato
  editions.
- Voicemeeter *write* paths (`SetStripRouting`, `SetBusDelay`, `SetBusDevice`).
- The interactive menu's new layout: its helpers are exercised by the CLI
  commands that share them, but the menu itself was not driven by hand.

### Still broken / known limits

- **Absolute latency is not calibrated.** `WasapiOut.Play()` returns before
  audio actually leaves the endpoint, so the emission reference understates the
  true start by roughly the output buffer latency. A *differential* between two
  devices measured identically is unaffected; a single absolute figure from this
  tool is not yet trustworthy. The fix is an `IAudioClock`/`GetPosition`-based
  reference, or using loopback capture as the timing reference.
- **Voicemeeter can make the physical outputs unopenable.** With Banana holding
  A1/A2/A3, `measure --output 0|1|3` fails with `0x8889000A`
  (`AUDCLNT_E_DEVICE_IN_USE`) — Voicemeeter has them in exclusive mode. Measure
  through `Voicemeeter Input (VB-Audio Voicemeeter VAIO)` instead, or set those
  buses to MME in Voicemeeter.
- **RAW capture bypasses the endpoint's gain stage too**, so a mic that peaked
  at -23 dBFS processed can read above 0 dBFS raw. The stream is 32-bit float,
  which does not clip above 1.0, and the matched filter is amplitude-insensitive
  — but do not read the raw peak as a calibrated level.
- `--loopback` only opens the stream; the before/after-the-DAC split is not
  implemented.
