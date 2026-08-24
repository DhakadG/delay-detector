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

    private static int ListDevices()
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

    private static int Measure(string[] args)
    {
        bool json = args.Contains("--json");
        bool exclusive = args.Contains("--exclusive");
        bool loopback = args.Contains("--loopback");
        int rounds = int.TryParse(Arg(args, "--rounds"), out var r) ? r : 1;
        int repeats = int.TryParse(Arg(args, "--repeats"), out var rp) ? rp : 6;

        using var en = new MMDeviceEnumerator();
        var outDev = Resolve(en, DataFlow.Render, Arg(args, "--output"));
        var inDev = Resolve(en, DataFlow.Capture, Arg(args, "--input"));

        // Ordinary foreground priority is not enough: a single missed capture
        // buffer shifts every later sample and silently corrupts the delay.
        Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High;

        if (!json)
        {
            Console.WriteLine($"output : {outDev.FriendlyName}");
            Console.WriteLine($"input  : {inDev.FriendlyName}");
            Console.WriteLine($"mode   : {(exclusive ? "exclusive" : "shared")}{(loopback ? " + loopback" : "")}");
            Console.WriteLine();
        }

        var opts = new Dsp.Options(Repeats: repeats);
        var results = new List<Dsp.Result>();
        var rand = new Random(12345);

        for (int round = 1; round <= rounds; round++)
        {
            var res = RunOne(outDev, inDev, opts, exclusive, rand);
            results.Add(res);
            if (!json)
            {
                Console.WriteLine(
                    $"round {round}: {res.DelayMs,8:F2} ms  settled {res.SettledMs,8:F2} ms  " +
                    $"jitter ±{res.JitterMs:F2} ms  drift {res.DriftMsPerSec,6:F2} ms/s  " +
                    $"peak {res.QualityDb:F0} dB  {(res.Ok ? "ok" : res.Reason)}");
            }
        }

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

    private static Dsp.Result RunOne(MMDevice outDev, MMDevice inDev, Dsp.Options o, bool exclusive, Random rand)
    {
        var mode = exclusive ? AudioClientShareMode.Exclusive : AudioClientShareMode.Shared;

        using var capture = new WasapiCapture(inDev)
        {
            // Event-driven at a small buffer: the point of the native path.
            ShareMode = AudioClientShareMode.Shared,
        };
        int sampleRate = capture.WaveFormat.SampleRate;
        int channels = capture.WaveFormat.Channels;

        var stim = Dsp.MakeStimulus(sampleRate, o, rand);

        var captured = new List<float>(sampleRate * 12);
        var gotData = new ManualResetEventSlim(false);
        long capturedFrames = 0;

        capture.DataAvailable += (_, e) =>
        {
            // WasapiCapture hands back IEEE float in shared mode; mix to mono
            // by taking channel 0, which keeps timing exact.
            int bytesPerFrame = capture.WaveFormat.BlockAlign;
            int frames = e.BytesRecorded / bytesPerFrame;
            for (int f = 0; f < frames; f++)
                captured.Add(BitConverter.ToSingle(e.Buffer, f * bytesPerFrame));
            capturedFrames += frames;
            gotData.Set();
        };

        var mmcss = JoinProAudio();
        capture.StartRecording();
        // Let the capture stream stabilise before anything is played, so the
        // first sweep is not landing during stream start-up.
        Thread.Sleep(400);

        var provider = new StimulusProvider(stim.Signal, sampleRate);
        using var render = new WasapiOut(outDev, mode, useEventSync: true, latency: exclusive ? 10 : 60);
        render.Init(provider);

        long framesBeforePlay = Interlocked.Read(ref capturedFrames);
        render.Play();

        double waitSec = stim.DurationSec + 1.0;
        Thread.Sleep((int)(waitSec * 1000));
        render.Stop();
        capture.StopRecording();
        Thread.Sleep(120);

        var rec = captured.ToArray();
        // Playback began at framesBeforePlay; trimming there aligns capture
        // sample 0 with stimulus sample 0, the same convention the web app uses.
        int start = (int)Math.Min(framesBeforePlay, Math.Max(0, rec.Length - 1));
        var aligned = rec.AsSpan(start).ToArray();

        return Dsp.Measure(aligned, stim, o);
    }

    /// Plays a float buffer once, then silence.
    private sealed class StimulusProvider : ISampleProvider
    {
        private readonly float[] _data;
        private int _pos;
        public StimulusProvider(float[] data, int sampleRate)
        {
            _data = data;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 1);
        }
        public WaveFormat WaveFormat { get; }
        public int Read(float[] buffer, int offset, int count)
        {
            int n = Math.Min(count, _data.Length - _pos);
            if (n > 0) { Array.Copy(_data, _pos, buffer, offset, n); _pos += n; }
            for (int i = n; i < count; i++) buffer[offset + i] = 0f;
            return count; // keep the stream alive so timing stays continuous
        }
    }
}
