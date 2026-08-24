using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace DelayProbe;

/// <summary>
/// Native WASAPI probe. Exists because the browser path is not fully under our
/// control: a real capture was discarded after Chrome's audio thread dropped
/// 298 ms of input mid-measurement, and Chrome's shared-mode output adds its
/// own (variable) buffering that the differential can only cancel if it stays
/// constant between runs.
///
/// What this buys over the web version:
///   - WASAPI event-driven capture at MMCSS "Pro Audio" priority, so the
///     capture thread is scheduled ahead of ordinary work and glitches far
///     less under load.
///   - Exclusive-mode render (opt-in), which bypasses the Windows mixer
///     entirely: no per-stream resampling, no APO effects, much smaller and
///     far more deterministic output buffering.
///   - Loopback capture, which taps the digital stream the device is actually
///     being fed. Comparing loopback timing against microphone timing splits
///     the total into "delay before the DAC" and "delay after it" — the
///     acoustic part is the bit a Bluetooth link actually adds.
/// </summary>
public static class Program
{
    [DllImport("avrt.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr AvSetMmThreadCharacteristics(string taskName, ref uint taskIndex);

    [DllImport("avrt.dll", SetLastError = true)]
    private static extern bool AvSetMmThreadPriority(IntPtr handle, int priority);

    /// Joins the MMCSS "Pro Audio" task so Windows schedules this thread with
    /// audio-grade priority instead of treating it as a normal worker.
    private static IntPtr JoinProAudio()
    {
        uint idx = 0;
        var h = AvSetMmThreadCharacteristics("Pro Audio", ref idx);
        if (h != IntPtr.Zero) AvSetMmThreadPriority(h, 2 /* AVRT_PRIORITY_CRITICAL */);
        return h;
    }

    public static int Main(string[] args)
    {
        // Voicemeeter allows at most 4 remote clients and offers no way to
        // enumerate or evict them, so a client that exits without logging out
        // burns a slot until the service notices. Cover all three exits:
        // normal return, Ctrl+C, and anything that unwinds to process exit.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => VoicemeeterControl.Logout();
        Console.CancelKeyPress += (_, e) => { e.Cancel = false; VoicemeeterControl.Logout(); };

        // Double-clicking the exe from Explorer used to print help and exit,
        // so the console window flashed and vanished before it could be read.
        // With no arguments AND a real console attached, drop into a menu that
        // waits for input instead. Redirected stdin (scripts, pipes) still gets
        // the old help-and-exit path, so nothing scripted changes.
        if (args.Length == 0 && !Console.IsInputRedirected)
            return Interactive.Run();

        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.WriteLine("""
                delayprobe — acoustic output-latency measurement over WASAPI

                  delayprobe devices
                      List render and capture devices with their IDs.

                  delayprobe measure --output <id|index> [options]
                      Play a sweep train through <output>, capture it on the
                      microphone, and report the round-trip delay.

                  Options
                    --input <id|index>   capture device (default: system default)
                    --exclusive          exclusive-mode render, bypasses the mixer
                    --loopback           also capture the digital stream for a
                                         before/after-the-DAC split
                    --repeats <n>        sweeps per measurement (default 6)
                    --rounds <n>         repeat the whole measurement n times
                    --json               emit JSON only, for scripting

                  delayprobe listen --input 1 --seconds 5 [--raw] [--processed] [--winmm]
                      Capture-only diagnostic: negotiated format, per-channel
                      levels every 100 ms, and with --raw a hex dump of the first
                      non-silent buffer. --processed leaves the endpoint's audio
                      effects in the path (they can delete the sweep outright);
                      --winmm cross-checks the same device over WinMM.

                  delayprobe voicemeeter
                      Print Voicemeeter buses, strips and routing.

                  delayprobe logs [--open]
                      Print (and optionally open) the per-run log folder.

                  delayprobe serve --port 8765
                      Run the local HTTP bridge on 127.0.0.1 so the web app can
                      drive this probe. See native/README.md.

                Run with no arguments for an interactive menu.

                Exit code is 0 only if every round produced a trustworthy result.
                """);
            return 0;
        }

        try
        {
            return args[0] switch
            {
                "devices" => ListDevices(),
                "measure" => Measure(args),
                "listen" => Diagnostics.Listen(args),
                "voicemeeter" or "vm" => Ui.ShowVoicemeeter(),
                "logs" => RunLog.ShowFolder(args.Contains("--open")),
                "param" => Param(args),
                "serve" => BridgeServer.Run(int.TryParse(Arg(args, "--port"), out var p) ? p : 8765),
                _ => Fail($"unknown command '{args[0]}' — try --help"),
            };
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    /// <summary>
    /// Read or write any Voicemeeter parameter by name. Exists for diagnosis:
    /// the structured endpoints only cover buses and strips, but engine-level
    /// settings like Option.sr live outside that and still have to be
    /// inspectable before anything is changed.
    ///   delayprobe param Option.sr
    ///   delayprobe param Option.sr 48000
    ///   delayprobe param Bus[0].device.sr --string
    /// </summary>
    private static int Param(string[] args)
    {
        if (args.Length < 2) return Fail("usage: delayprobe param <name> [value] [--string]");
        if (!VoicemeeterControl.Connect()) return Fail("Voicemeeter is not available");
        string name = args[1];
        bool asString = args.Contains("--string");
        string? value = args.Length > 2 && !args[2].StartsWith("--") ? args[2] : null;

        if (value is null)
        {
            if (asString) { Console.WriteLine($"{name} = \"{VoicemeeterControl.GetString(name)}\""); return 0; }
            if (VoicemeeterControl.TryGetFloat(name, out var f)) { Console.WriteLine($"{name} = {f}"); return 0; }
            // Not every parameter is a float; fall back rather than reporting nothing.
            var sv = VoicemeeterControl.GetString(name);
            if (!string.IsNullOrEmpty(sv)) { Console.WriteLine($"{name} = \"{sv}\""); return 0; }
            return Fail($"could not read {name}");
        }

        bool ok = asString || !float.TryParse(value, out var nv)
            ? VoicemeeterControl.SetString(name, value)
            : VoicemeeterControl.SetFloat(name, nv);
        if (!ok) return Fail($"could not set {name}");
        Console.WriteLine($"{name} <- {value}");
        return 0;
    }

    private static int Fail(string msg)
    {
        Console.Error.WriteLine("error: " + msg);
        return 1;
    }

    internal static int ListDevices()
    {
        using var en = new MMDeviceEnumerator();
        Ui.DeviceTables(en, withIds: true);
        return 0;
    }

    private static MMDevice Resolve(MMDeviceEnumerator en, DataFlow flow, string? spec)
    {
        var list = en.EnumerateAudioEndPoints(flow, DeviceState.Active).ToList();
        if (string.IsNullOrWhiteSpace(spec)) return en.GetDefaultAudioEndpoint(flow, Role.Multimedia);
        if (int.TryParse(spec, out int idx))
        {
            if (idx < 0 || idx >= list.Count) throw new ArgumentException($"no {flow} device at index {idx}");
            return list[idx];
        }
        return list.FirstOrDefault(d => d.ID == spec)
            ?? list.FirstOrDefault(d => d.FriendlyName.Contains(spec, StringComparison.OrdinalIgnoreCase))
            ?? throw new ArgumentException($"no {flow} device matching '{spec}'");
    }

    internal static string? Arg(string[] a, string name)
    {
        int i = Array.IndexOf(a, name);
        return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
    }

    internal static int Measure(string[] args)
    {
        bool json = args.Contains("--json");
        bool exclusive = args.Contains("--exclusive");
        bool loopback = args.Contains("--loopback");
        int rounds = int.TryParse(Arg(args, "--rounds"), out var r) ? r : 1;
        int repeats = int.TryParse(Arg(args, "--repeats"), out var rp) ? rp : 6;

        using var en = new MMDeviceEnumerator();
        var outDev = Resolve(en, DataFlow.Render, Arg(args, "--output"));
        var inDev = Resolve(en, DataFlow.Capture, Arg(args, "--input"));

        if (!json)
        {
            Console.WriteLine($"output : {outDev.FriendlyName}");
            Console.WriteLine($"input  : {inDev.FriendlyName}");
            Console.WriteLine($"mode   : {(exclusive ? "exclusive" : "shared")}{(loopback ? " + loopback" : "")}");
            Console.WriteLine();
        }

        var results = RunRounds(outDev, inDev, exclusive, repeats, rounds, json ? null : (round, res) =>
            Ui.Line(res.Ok ? ConsoleColor.DarkGray : ConsoleColor.Red,
                    $"  round {round} of {rounds}: {(res.Ok ? $"{res.DelayMs:F2} ms" : res.Reason)}"), !json);

        var good = results.Where(x => x.Ok).ToList();
        if (json)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                output = outDev.FriendlyName,
                input = inDev.FriendlyName,
                mode = exclusive ? "exclusive" : "shared",
                rounds = results.Select(x => new
                {
                    ok = x.Ok, delayMs = x.DelayMs, settledMs = x.SettledMs,
                    jitterMs = x.JitterMs, driftMsPerSec = x.DriftMsPerSec,
                    qualityDb = x.QualityDb, usedRepeats = x.UsedRepeats,
                    delays = x.Delays, reason = x.Reason,
                }),
                medianDelayMs = good.Count > 0 ? Dsp.Median(good.Select(x => x.DelayMs).ToArray()) : (double?)null,
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
        else Ui.ResultsTable(results);

        return good.Count == results.Count ? 0 : 1;
    }

    /// <summary>
    /// The one measurement loop. The CLI and the HTTP bridge both go through
    /// here — forking it would let the two paths' numbers drift apart, which
    /// is exactly the failure mode this tool is supposed to detect.
    /// </summary>
    internal static List<Dsp.Result> RunRounds(MMDevice outDev, MMDevice inDev, bool exclusive,
                                               int repeats, int rounds, Action<int, Dsp.Result>? onRound, bool verbose = false)
    {
        // Ordinary foreground priority is not enough: a single missed capture
        // buffer shifts every later sample and silently corrupts the delay.
        Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High;

        var opts = new Dsp.Options(Repeats: repeats);
        var results = new List<Dsp.Result>();
        var rand = new Random(12345);

        // Logging wraps the loop rather than each front end, so the CLI, the menu
        // and the bridge all leave the same record without three call sites to keep
        // in step. It never throws, so a failure to log cannot lose a measurement.
        using var log = RunLog.Start(outDev.FriendlyName);
        log.Note($"output={outDev.FriendlyName}");
        log.Note($"input={inDev.FriendlyName}");
        log.Note($"mode={(exclusive ? "exclusive" : "shared")} repeats={repeats} rounds={rounds}");

        for (int round = 1; round <= rounds; round++)
        {
            var res = RunOne(outDev, inDev, opts, exclusive, rand, verbose);
            results.Add(res);
            onRound?.Invoke(round, res);
        }

        var okRounds = results.Where(x => x.Ok).ToList();
        log.Finish(new
        {
            timestamp = DateTimeOffset.Now,
            version = Ui.Version,
            output = outDev.FriendlyName,
            outputId = outDev.ID,
            input = inDev.FriendlyName,
            inputId = inDev.ID,
            options = new { mode = exclusive ? "exclusive" : "shared", repeats, rounds },
            captureFormat = LastCaptureFormat,
            captureLevelDb = LastCaptureLevel,
            rawStream = LastRawStream,
            rounds = results.Select(x => new
            {
                ok = x.Ok, delayMs = x.DelayMs, settledMs = x.SettledMs, jitterMs = x.JitterMs,
                driftMsPerSec = x.DriftMsPerSec, qualityDb = x.QualityDb,
                usedRepeats = x.UsedRepeats, delays = x.Delays, reason = x.Reason,
            }),
            medianDelayMs = okRounds.Count > 0
                ? Dsp.Median(okRounds.Select(x => x.DelayMs).ToArray()) : (double?)null,
        });
        return results;
    }

    // Last-run capture facts, recorded for the run log. Measurements are strictly
    // sequential (the loop above is the only caller), so a field is enough and a
    // parallel plumbing of return values is not.
    internal static string LastCaptureFormat = "";
    internal static string LastRawStream = "";
    internal static double[] LastCaptureLevel = Array.Empty<double>();

    /// Exposed so the bridge resolves devices by the exact same rules the CLI uses.
    internal static MMDevice ResolveDevice(MMDeviceEnumerator en, DataFlow flow, string? spec)
        => Resolve(en, flow, spec);

    /// <summary>Peak and RMS of a capture, so a failure can be attributed instead of guessed at.</summary>
    internal static (double PeakDb, double RmsDb) LevelOf(float[] x)
    {
        if (x.Length == 0) return (double.NegativeInfinity, double.NegativeInfinity);
        double peak = 0, sum = 0;
        foreach (var v in x) { var a = Math.Abs(v); if (a > peak) peak = a; sum += (double)v * v; }
        return (20 * Math.Log10(peak <= 0 ? 1e-9 : peak),
                20 * Math.Log10(Math.Sqrt(sum / x.Length) is var r && r <= 0 ? 1e-9 : r));
    }

    /// <summary>
    /// Converts one WASAPI capture block to mono floats, taking channel 0 only so the
    /// frame timing stays exact. Decoding itself lives in <see cref="Audio.Sample"/> —
    /// having a second copy here is how one path ends up reading int32 as float while
    /// the diagnostic reads it correctly and the two disagree about what the mic heard.
    /// </summary>
    private static void AppendMono(List<float> dst, byte[] buf, int bytes, WaveFormat fmt)
    {
        int block = fmt.BlockAlign;
        int frames = bytes / block;
        for (int f = 0; f < frames; f++) dst.Add(Audio.Sample(buf, f * block, 0, fmt));
    }

    private static Dsp.Result RunOne(MMDevice outDev, MMDevice inDev, Dsp.Options o, bool exclusive,
                                     Random rand, bool verbose)
    {
        var mode = exclusive ? AudioClientShareMode.Exclusive : AudioClientShareMode.Shared;

        using var capture = new WasapiCapture(inDev) { ShareMode = AudioClientShareMode.Shared };

        // Without RAW the endpoint's own noise-suppression APOs sit in the path and
        // delete the sweep outright — the Realtek "Microphone Array" here returns exact
        // digital zeros for anything it does not classify as speech. See RawMode.
        bool rawOk = RawMode.TryEnable(capture, out string rawDetail);

        var capFmt = capture.WaveFormat;
        int sampleRate = capFmt.SampleRate;
        LastCaptureFormat = $"{capFmt.SampleRate} Hz, {capFmt.Channels} ch, " +
                            $"{capFmt.BitsPerSample}-bit {capFmt.Encoding}";
        LastRawStream = rawOk ? "raw" : "processed: " + rawDetail;

        // The matched filter correlates the CAPTURED signal against a reference generated at
        // the capture rate. If the render endpoint runs at a different rate the emitted sweep
        // is resampled on the way out, arriving time-stretched relative to that reference and
        // correlating poorly. Warn rather than silently produce a bad number.
        int renderRate = outDev.AudioClient.MixFormat.SampleRate;
        int renderCh = Math.Max(1, outDev.AudioClient.MixFormat.Channels);
        if (verbose)
        {
            Console.WriteLine($"  capture: {sampleRate} Hz, {capFmt.Channels} ch, " +
                              $"{capFmt.BitsPerSample}-bit {capFmt.Encoding}, " +
                              $"stream {(rawOk ? "RAW" : "processed — " + rawDetail)}");
            Console.WriteLine($"  render : {renderRate} Hz, {renderCh} ch");
            if (renderRate != sampleRate)
                Console.WriteLine("  NOTE: render and capture rates differ; the sweep is resampled on output.");
        }

        var stim = Dsp.MakeStimulus(sampleRate, o, rand);

        var captured = new List<float>(sampleRate * 12);
        capture.DataAvailable += (_, e) => AppendMono(captured, e.Buffer, e.BytesRecorded, capFmt);

        JoinProAudio();
        capture.StartRecording();
        Thread.Sleep(400);   // let the capture stream settle before anything is emitted

        // Emit at the render endpoint's own channel count. A mono ISampleProvider handed to a
        // stereo endpoint is not reliably up-mixed by WasapiOut, which is a good way to end up
        // playing into one channel or nothing at all.
        var provider = new StimulusProvider(stim.Signal, sampleRate, renderCh);
        using var render = new WasapiOut(outDev, mode, useEventSync: true, latency: exclusive ? 10 : 60);
        render.Init(provider);

        int framesBeforePlay = captured.Count;
        render.Play();

        Thread.Sleep((int)((stim.DurationSec + 1.2) * 1000));
        render.Stop();
        capture.StopRecording();
        Thread.Sleep(150);

        var rec = captured.ToArray();
        var (peakDb, rmsDb) = LevelOf(rec);
        LastCaptureLevel = new[] { peakDb, rmsDb };
        if (verbose)
            Console.WriteLine($"  captured {rec.Length} frames ({rec.Length / (double)sampleRate:F2}s), " +
                              $"peak {peakDb:F1} dBFS, rms {rmsDb:F1} dBFS");

        if (peakDb < -70)
        {
            return new Dsp.Result(false, double.NaN, double.NaN, double.NaN, double.NaN, 0, 0, false,
                0, 0, double.NaN, Array.Empty<double>(),
                $"the microphone captured effectively nothing (peak {peakDb:F0} dBFS) — " +
                (rawOk ? "check it is not muted"
                       : "the endpoint's audio processing could not be bypassed (" + rawDetail +
                         "), so noise suppression is very likely deleting the sweep; " +
                         "run 'delayprobe listen' to confirm"));
        }

        // NOTE: render.Play() returns as soon as the stream is started, but audio does not
        // leave the endpoint until its buffer has filled, so `framesBeforePlay` understates
        // the true emission point by roughly the output latency. That offset is absorbed by
        // the correlation search window rather than corrected here, which is why this tool's
        // ABSOLUTE numbers are not yet trustworthy — see native/README.md. It does not affect
        // a differential between two devices measured the same way.
        int start = Math.Clamp(framesBeforePlay, 0, Math.Max(0, rec.Length - 1));
        var aligned = rec.AsSpan(start).ToArray();

        return Dsp.Measure(aligned, stim, o);
    }

    private sealed class StimulusProvider : ISampleProvider
    {
        private readonly float[] _data;
        private int _pos;
        private readonly int _channels;
        public StimulusProvider(float[] data, int sampleRate, int channels = 1)
        {
            _data = data;
            _channels = Math.Max(1, channels);
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, _channels);
        }
        public WaveFormat WaveFormat { get; }
        public int Read(float[] buffer, int offset, int count)
        {
            // The same mono sweep on every channel: the mic hears one acoustic source
            // either way, and this avoids depending on WasapiOut to up-mix.
            int frames = count / _channels;
            for (int f = 0; f < frames; f++)
            {
                float v = _pos < _data.Length ? _data[_pos++] : 0f;
                for (int c = 0; c < _channels; c++) buffer[offset + f * _channels + c] = v;
            }
            return count; // keep the stream alive so timing stays continuous
        }
    }
}
