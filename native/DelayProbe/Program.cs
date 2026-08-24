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

                  delayprobe serve [--port 8765]
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
                "serve" => BridgeServer.Run(int.TryParse(Arg(args, "--port"), out var p) ? p : 8765),
                _ => Fail($"unknown command '{args[0]}' — try --help"),
            };
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    private static int Fail(string msg)
    {
        Console.Error.WriteLine("error: " + msg);
        return 1;
    }

    internal static int ListDevices()
    {
        using var en = new MMDeviceEnumerator();
        Console.WriteLine("Render (outputs):");
        var render = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).ToList();
        for (int i = 0; i < render.Count; i++)
            Console.WriteLine($"  [{i}] {render[i].FriendlyName}\n      {render[i].ID}");

        Console.WriteLine("\nCapture (inputs):");
        var capture = en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active).ToList();
        for (int i = 0; i < capture.Count; i++)
            Console.WriteLine($"  [{i}] {capture[i].FriendlyName}\n      {capture[i].ID}");
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

    private static string? Arg(string[] a, string name)
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
            Console.WriteLine(
                $"round {round}: {res.DelayMs,8:F2} ms  settled {res.SettledMs,8:F2} ms  " +
                $"jitter ±{res.JitterMs:F2} ms  drift {res.DriftMsPerSec,6:F2} ms/s  " +
                $"peak {res.QualityDb:F0} dB  {(res.Ok ? "ok" : res.Reason)}"), !json);

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
        else if (good.Count > 0)
        {
            Console.WriteLine($"\nmedian across {good.Count} good round(s): " +
                              $"{Dsp.Median(good.Select(x => x.DelayMs).ToArray()):F2} ms");
        }

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

        for (int round = 1; round <= rounds; round++)
        {
            var res = RunOne(outDev, inDev, opts, exclusive, rand, verbose);
            results.Add(res);
            onRound?.Invoke(round, res);
        }
        return results;
    }

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
    /// Converts one WASAPI capture block to mono floats. The previous version assumed the
    /// shared-mode format was always IEEE float and read it with BitConverter.ToSingle
    /// unconditionally; against a 16-bit PCM endpoint that reinterprets two PCM samples as
    /// one float and yields pure garbage, which is exactly how a measurement ends up with
    /// "too few usable repeats" and no clue why. Handle what the endpoint actually reports.
    /// </summary>
    private static void AppendMono(List<float> dst, byte[] buf, int bytes, WaveFormat fmt)
    {
        int block = fmt.BlockAlign;
        int frames = bytes / block;
        // WASAPI reports Extensible for most shared-mode endpoints; at 32 bits that is
        // float in every case this tool will meet. Integer 32-bit is handled below anyway.
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat
            || (fmt.Encoding == WaveFormatEncoding.Extensible && fmt.BitsPerSample == 32);

        for (int f = 0; f < frames; f++)
        {
            int at = f * block;                       // channel 0 only: keeps timing exact
            if (isFloat && fmt.BitsPerSample == 32) dst.Add(BitConverter.ToSingle(buf, at));
            else if (fmt.BitsPerSample == 16) dst.Add(BitConverter.ToInt16(buf, at) / 32768f);
            else if (fmt.BitsPerSample == 32) dst.Add(BitConverter.ToInt32(buf, at) / 2147483648f);
            else if (fmt.BitsPerSample == 24)
                dst.Add(((buf[at + 2] << 16) | (buf[at + 1] << 8) | buf[at]) / 8388608f
                        - (buf[at + 2] >= 0x80 ? 2f : 0f));
            else dst.Add(0f);
        }
    }

    private static Dsp.Result RunOne(MMDevice outDev, MMDevice inDev, Dsp.Options o, bool exclusive,
                                     Random rand, bool verbose)
    {
        var mode = exclusive ? AudioClientShareMode.Exclusive : AudioClientShareMode.Shared;

        using var capture = new WasapiCapture(inDev) { ShareMode = AudioClientShareMode.Shared };
        var capFmt = capture.WaveFormat;
        int sampleRate = capFmt.SampleRate;

        // The matched filter correlates the CAPTURED signal against a reference generated at
        // the capture rate. If the render endpoint runs at a different rate the emitted sweep
        // is resampled on the way out, arriving time-stretched relative to that reference and
        // correlating poorly. Warn rather than silently produce a bad number.
        int renderRate = outDev.AudioClient.MixFormat.SampleRate;
        int renderCh = Math.Max(1, outDev.AudioClient.MixFormat.Channels);
        if (verbose)
        {
            Console.WriteLine($"  capture: {sampleRate} Hz, {capFmt.Channels} ch, " +
                              $"{capFmt.BitsPerSample}-bit {capFmt.Encoding}");
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
        if (verbose)
            Console.WriteLine($"  captured {rec.Length} frames ({rec.Length / (double)sampleRate:F2}s), " +
                              $"peak {peakDb:F1} dBFS, rms {rmsDb:F1} dBFS");

        if (peakDb < -70)
        {
            return new Dsp.Result(false, double.NaN, double.NaN, double.NaN, double.NaN, 0, 0, false,
                0, 0, double.NaN, Array.Empty<double>(),
                $"the microphone captured effectively nothing (peak {peakDb:F0} dBFS) — check it is not muted");
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

/// <summary>
/// Menu shown when the exe is launched with no arguments from a real console —
/// i.e. double-clicked in Explorer. Without it the process printed help and
/// exited instantly, so the window flashed and the user saw nothing. Every
/// entry just builds the argv the CLI already understands, so there is one
/// implementation of each command, not two.
/// </summary>
internal static class Interactive
{
    public static int Run()
    {
        while (true)
        {
            Console.WriteLine();
            Console.WriteLine("delayprobe — interactive");
            Console.WriteLine("  1) list audio devices");
            Console.WriteLine("  2) run a measurement");
            Console.WriteLine("  3) Voicemeeter state");
            Console.WriteLine("  4) start bridge server (for the web app)");
            Console.WriteLine("  q) quit");
            Console.Write("> ");

            // Console.ReadLine returns null if stdin closes underneath us
            // (window closed, redirect appearing late) — exit instead of spinning.
            var choice = Console.ReadLine()?.Trim();
            if (choice is null or "q" or "Q" or "quit" or "exit") return 0;

            try
            {
                switch (choice)
                {
                    case "1": Program.ListDevices(); break;
                    case "2": MeasurePrompt(); break;
                    case "3": ShowVoicemeeter(); break;
                    case "4": StartBridge(); break;
                    default: Console.WriteLine("pick 1-4 or q"); break;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("error: " + ex.Message);
            }
        }
    }

    private static string Ask(string prompt, string fallback)
    {
        Console.Write(prompt);
        var s = Console.ReadLine()?.Trim();
        return string.IsNullOrWhiteSpace(s) ? fallback : s;
    }

    private static void MeasurePrompt()
    {
        Program.ListDevices();
        Console.WriteLine();
        var output = Ask("output device (index, id or name): ", "");
        if (output.Length == 0) { Console.WriteLine("cancelled"); return; }
        var input = Ask("input device (blank = system default): ", "");
        var rounds = Ask("rounds [1]: ", "1");
        var exclusive = Ask("exclusive mode? [y/N]: ", "n");

        var args = new List<string> { "measure", "--output", output, "--rounds", rounds };
        if (input.Length > 0) { args.Add("--input"); args.Add(input); }
        if (exclusive.StartsWith('y') || exclusive.StartsWith('Y')) args.Add("--exclusive");

        Console.WriteLine();
        Program.Measure(args.ToArray());
    }

    private static void ShowVoicemeeter()
    {
        var vm = VoicemeeterControl.Query();
        if (!vm.Available) { Console.WriteLine("Voicemeeter is not installed (VoicemeeterRemote64.dll not found)."); return; }
        if (!vm.Running) { Console.WriteLine("Voicemeeter is installed but not running."); return; }

        Console.WriteLine($"edition: {VoicemeeterControl.TypeName(vm.Type)}");
        Console.WriteLine("buses:");
        foreach (var b in VoicemeeterControl.Buses())
            Console.WriteLine($"  [{b.Index}] {b.Label,-16} delay {b.DelayMs,5:F0} ms  {b.Device}");
        Console.WriteLine("strips:");
        foreach (var s in VoicemeeterControl.Strips())
            Console.WriteLine($"  [{s.Index}] {s.Label,-16} A:{string.Concat(s.A.Select(x => x ? '1' : '0'))}" +
                              $" B:{string.Concat(s.B.Select(x => x ? '1' : '0'))}");
    }

    private static void StartBridge()
    {
        var port = Ask("port [8765]: ", "8765");
        if (!int.TryParse(port, out int p)) { Console.WriteLine("not a port number"); return; }
        BridgeServer.Run(p);   // blocks until the listener is closed
    }
}
