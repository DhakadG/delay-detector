# Delay Detector

Measure how far behind your Bluetooth headphones, earbuds, or speakers actually
are — then get the exact number to paste into VLC, mpv, Plex, or Kodi so lips
line up again.

Runs entirely in the browser. Nothing to install, nothing uploaded.

## Why not just use the number the browser reports?

Because it is the wrong number. `AudioContext.outputLatency` covers the browser
and the OS mixer — it does **not** include the Bluetooth codec delay, which is
the 150–200 ms that is actually ruining your lip sync. Most "audio latency
test" websites report exactly that useless figure. This one plays a real sound
and listens to it come back.

## How it works

1. Plays a 40 ms frequency sweep, eight times, with randomised gaps.
2. Records it back through your microphone.
3. Cross-correlates the recording against the sweep to find the round-trip
   delay to sub-millisecond precision.
4. Does it twice — once through your built-in speaker, once through the device
   under test — and subtracts.

Step 4 is the important one. A round trip includes the microphone's latency,
the OS input path, and the browser's own buffering, none of which you can
easily measure. But they are **identical in both runs**, so subtracting cancels
them exactly. What is left is purely the extra delay your Bluetooth device
adds, which is exactly the number the player needs.

A useful consequence: this app's own latency does not affect the result. It
cancels by construction.

Full method and error budget: [docs/METHOD.md](docs/METHOD.md).
Prior art, standards, and platform constraints: [docs/RESEARCH.md](docs/RESEARCH.md).

## Accuracy

About ±5 ms in practice, dominated by run-to-run jitter in the Bluetooth link
itself rather than by the algorithm. For reference, ITU-R BT.1359-1 puts the
threshold of *noticing* a sync error at 45 ms. So this is comfortably good
enough, and the app reports its own spread rather than pretending otherwise.

Measurements that fail a quality check are rejected with a reason instead of
returning a plausible-looking wrong number.

## Two things that will silently ruin a measurement

**Echo cancellation.** Browsers enable it by default, and it will cheerfully
cancel the test signal. The app disables it and then verifies the browser
actually complied — if it did not, you get a warning instead of a number.

**Bluetooth headset mics.** On Windows and Android, connecting earbuds often
switches your *input* to the headset's microphone, which drops the link into
hands-free mode with completely different latency. Keep the input pinned to
your built-in mic. The app pins it for you.

## Switching between devices

| | automatic device switching |
|---|---|
| Chrome / Edge / Brave, desktop | yes — the page cycles outputs itself |
| Firefox desktop | partial |
| Safari, macOS and iOS | no |
| Chrome, Android | no |

Where automatic switching is unavailable (`setSinkId` is not implemented), the
flow is: change your system output device, press Measure, repeat. One click per
device.

## Using the result

The app gives you a signed value per player. If it says your earbuds arrive
180 ms late:

| player | setting | value |
|---|---|---|
| VLC | Audio track synchronization | `-180 ms` |
| mpv | | `--audio-delay=-0.180` |
| Plex / Kodi | Audio offset | `-180 ms` |
| ffmpeg | | `-itsoffset -0.180` |

## Running locally

Needs to be served over HTTP (ES modules and `getUserMedia` will not work from
`file://`):

```bash
npx serve .
```

Run the DSP self-check — no hardware or browser needed:

```bash
node test/engine.test.js
```

## Status

Early. The measurement core is tested against synthetic signals; real-world
validation across devices is ongoing. Reports of what it got right or wrong on
your hardware are the most useful contribution right now.

## License

MIT
