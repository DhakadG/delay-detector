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
```

Exit code is 0 only when every round produced a trustworthy result, so it can
be scripted.

## Status

The measurement path (device enumeration, sweep generation, WASAPI capture,
correlation, drift analysis) is implemented and the binary builds and runs.
It has **not** yet been validated against known-good hardware latencies, and
`--loopback` currently only opens the stream — the before/after-the-DAC split
is not implemented yet. Treat its absolute numbers as unverified until they
have been checked against the web app on the same devices.
