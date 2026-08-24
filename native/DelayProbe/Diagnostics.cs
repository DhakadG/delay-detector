using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace DelayProbe;

/// <summary>
/// Capture-only diagnostic. Exists because "the measurement records silence"
/// has at least four plausible causes (wrong byte decode, wrong WASAPI setup,
/// a muted/attenuated endpoint, a dead channel in a mic array) and guessing
/// between them wastes more time than printing the evidence does.
///
/// Deliberately shares no code with the measurement path except the decoder,
/// so a bug in playback, DSP or alignment cannot masquerade as a capture bug.
/// </summary>
internal static class Diagnostics
{
    public static int Listen(string[] args)
    {
        bool raw = args.Contains("--raw");
        bool winmm = args.Contains("--winmm");
        bool legacy = args.Contains("--legacy");
        bool processed = args.Contains("--processed");   // opt back INTO the endpoint's APOs
        double seconds = double.TryParse(Program.Arg(args, "--seconds"), out var s) ? s : 5;

        using var en = new MMDeviceEnumerator();
        var dev = Program.ResolveDevice(en, DataFlow.Capture, Program.Arg(args, "--input"));

        Console.WriteLine($"device : {dev.FriendlyName}");
        Console.WriteLine($"id     : {dev.ID}");
        DescribeEndpoint(dev);

        return winmm ? ListenWinMm(dev, seconds) : ListenWasapi(dev, seconds, raw, legacy, !processed);
    }

    /// <summary>Endpoint-level state that silently kills a capture: mute, a master
    /// volume near zero, or one channel of an array turned down on its own.</summary>
    private static void DescribeEndpoint(MMDevice dev)
    {
        try
        {
            var v = dev.AudioEndpointVolume;
            var perCh = new List<string>();
            for (int i = 0; i < v.Channels.Count; i++)
                perCh.Add($"ch{i}={v.Channels[i].VolumeLevelScalar * 100:F0}%");
            Console.WriteLine($"volume : master {v.MasterVolumeLevelScalar * 100:F0}%  " +
                              $"mute {(v.Mute ? "ON" : "off")}  [{string.Join(' ', perCh)}]");
        }
        catch (Exception ex) { Console.WriteLine($"volume : unavailable ({ex.GetType().Name})"); }

        try
        {
            var sm = dev.AudioSessionManager;
            Console.WriteLine($"session: simple volume {sm.SimpleAudioVolume.Volume * 100:F0}%  " +
                              $"mute {(sm.SimpleAudioVolume.Mute ? "ON" : "off")}");
        }
        catch (Exception ex) { Console.WriteLine($"session: unavailable ({ex.GetType().Name})"); }
    }

    private static void DescribeFormat(string tag, WaveFormat f)
    {
        var sb = new StringBuilder($"{tag}: {f.SampleRate} Hz, {f.Channels} ch, {f.BitsPerSample}-bit " +
                                   $"{f.Encoding}, BlockAlign {f.BlockAlign}");
        if (f is WaveFormatExtensible x)
            sb.Append($", SubFormat {x.SubFormat} ({NameOfSubFormat(x.SubFormat)})");
        Console.WriteLine(sb.ToString());
    }

    // KSDATAFORMAT_SUBTYPE_* values. Named here rather than looked up because the
    // whole point is to make a wrong assumption about float-vs-int visible at a glance.
    private static readonly Guid SubPcm = new("00000001-0000-0010-8000-00aa00389b71");
    private static readonly Guid SubFloat = new("00000003-0000-0010-8000-00aa00389b71");

    private static string NameOfSubFormat(Guid g) =>
        g == SubFloat ? "IEEE_FLOAT" : g == SubPcm ? "PCM" : "unknown";

    private static int ListenWasapi(MMDevice dev, double seconds, bool raw, bool legacy, bool wantRaw)
    {
        // MixFormat is what WASAPI actually opens the shared-mode stream with;
        // WasapiCapture.WaveFormat is NAudio's flattened view of it. Print both,
        // because a disagreement between them is exactly the decode bug we suspect.
        DescribeFormat("mix    ", dev.AudioClient.MixFormat);

        // --legacy reproduces the measurement path's construction exactly, so the
        // two can be compared on the same device in the same minute.
        using var capture = legacy
            ? new WasapiCapture(dev) { ShareMode = AudioClientShareMode.Shared }
            : new WasapiCapture(dev, useEventSync: true, audioBufferMillisecondsLength: 50)
              { ShareMode = AudioClientShareMode.Shared };
        Console.WriteLine(wantRaw
            ? "stream : RAW requested — " + (RawMode.TryEnable(capture, out var d) ? "granted" : "DENIED (" + d + ")")
            : "stream : processed (endpoint APOs active)");

        var fmt = capture.WaveFormat;
        DescribeFormat("capture", fmt);
        Console.WriteLine();

        return Meter(fmt, seconds, raw,
            onData => { capture.DataAvailable += (_, e) => onData(e.Buffer, e.BytesRecorded); },
            capture.StartRecording, capture.StopRecording);
    }

    /// <summary>WinMM cross-check. If this hears the room and WASAPI does not, the
    /// fault is in our WASAPI setup, not in the driver or the machine.</summary>
    private static int ListenWinMm(MMDevice dev, double seconds)
    {
        // WinMM truncates product names to 31 chars, so match on the prefix
        // rather than expecting the MMDevice friendly name back verbatim.
        int number = -1;
        for (int i = 0; i < WaveInEvent.DeviceCount; i++)
        {
            var caps = WaveInEvent.GetCapabilities(i);
            if (dev.FriendlyName.StartsWith(caps.ProductName, StringComparison.OrdinalIgnoreCase))
            { number = i; break; }
        }
        if (number < 0) { Console.Error.WriteLine("error: no WinMM device matches that endpoint"); return 1; }

        var fmt = new WaveFormat(48000, 16, Math.Min(2, dev.AudioClient.MixFormat.Channels));
        using var wi = new WaveInEvent { DeviceNumber = number, WaveFormat = fmt, BufferMilliseconds = 50 };
        Console.WriteLine($"winmm  : device {number} \"{WaveInEvent.GetCapabilities(number).ProductName}\"");
        DescribeFormat("capture", fmt);
        Console.WriteLine();

        return Meter(fmt, seconds, false,
            onData => { wi.DataAvailable += (_, e) => onData(e.Buffer, e.BytesRecorded); },
            wi.StartRecording, wi.StopRecording);
    }

    /// <summary>
    /// Shared metering loop. Levels are tracked PER CHANNEL: a microphone array
    /// can present a live channel next to a near-dead one, and a mono mixdown
    /// hides that while a per-channel column makes it obvious.
    /// </summary>
    private static int Meter(WaveFormat fmt, double seconds, bool raw,
                             Action<Action<byte[], int>> subscribe, Action start, Action stop)
    {
        int ch = Math.Max(1, fmt.Channels);
        var winPeak = new double[ch];
        var winSum = new double[ch];
        long winCount = 0;
        var allPeak = new double[ch];
        var allSum = new double[ch];
        long allCount = 0;
        bool dumped = !raw;
        var gate = new object();
        var slots = new List<string>();

        subscribe((buf, bytes) =>
        {
            lock (gate)
            {
                int frames = bytes / fmt.BlockAlign;
                for (int f = 0; f < frames; f++)
                    for (int c = 0; c < ch; c++)
                    {
                        double v = Math.Abs(Audio.Sample(buf, f * fmt.BlockAlign, c, fmt));
                        if (v > winPeak[c]) winPeak[c] = v;
                        if (v > allPeak[c]) allPeak[c] = v;
                        winSum[c] += v * v;
                        allSum[c] += v * v;
                    }
                winCount += frames;
                allCount += frames;

                // "Non-trivial" means the block is not all zero bytes; a hex dump of
                // a zero-filled warm-up block tells us nothing about the encoding.
                if (!dumped && bytes >= 64 && HasNonZero(buf, bytes))
                {
                    dumped = true;
                    slots.Add(HexDump(buf, Math.Min(64, bytes), fmt));
                }
            }
        });

        start();
        var t0 = DateTime.UtcNow;
        while ((DateTime.UtcNow - t0).TotalSeconds < seconds)
        {
            Thread.Sleep(100);
            lock (gate)
            {
                foreach (var line in slots) Console.WriteLine(line);
                slots.Clear();
                if (winCount == 0) continue;
                var cols = new List<string>();
                for (int c = 0; c < ch; c++)
                    cols.Add($"ch{c} {Db(winPeak[c]),6:F1}/{Db(Math.Sqrt(winSum[c] / winCount)),6:F1}");
                Console.WriteLine($"  {(DateTime.UtcNow - t0).TotalSeconds,5:F1}s  " + string.Join("  ", cols));
                Array.Clear(winPeak); Array.Clear(winSum); winCount = 0;
            }
        }
        stop();
        Thread.Sleep(150);

        Console.WriteLine();
        lock (gate)
        {
            Console.WriteLine($"captured {allCount} frames ({allCount / (double)fmt.SampleRate:F2}s)");
            for (int c = 0; c < ch; c++)
                Console.WriteLine($"  channel {c}: peak {Db(allPeak[c]):F1} dBFS, " +
                                  $"rms {Db(allCount > 0 ? Math.Sqrt(allSum[c] / allCount) : 0):F1} dBFS");
        }
        return 0;
    }

    private static bool HasNonZero(byte[] b, int n)
    {
        for (int i = 0; i < n; i++) if (b[i] != 0) return true;
        return false;
    }

    private static string HexDump(byte[] b, int n, WaveFormat fmt)
    {
        var sb = new StringBuilder("  first non-silent buffer, first ").Append(n).Append(" bytes:\n");
        for (int i = 0; i < n; i += 16)
        {
            sb.Append("    ");
            for (int j = i; j < i + 16 && j < n; j++) sb.Append(b[j].ToString("x2")).Append(' ');
            sb.Append('\n');
        }
        // Both readings side by side settle "is this float32 or int32?" without
        // anyone having to decode hex in their head.
        sb.Append("    as float32: ");
        for (int i = 0; i + 4 <= n && i < 32; i += 4) sb.Append(BitConverter.ToSingle(b, i).ToString("G4")).Append(' ');
        sb.Append("\n    as int32  : ");
        for (int i = 0; i + 4 <= n && i < 32; i += 4) sb.Append(BitConverter.ToInt32(b, i) / 2147483648.0).Append(' ');
        sb.Append("\n    as int16  : ");
        for (int i = 0; i + 2 <= n && i < 32; i += 2) sb.Append(BitConverter.ToInt16(b, i) / 32768.0).Append(' ');
        return sb.ToString();
    }

    private static double Db(double x) => 20 * Math.Log10(x <= 0 ? 1e-12 : x);
}

/// <summary>Single place that turns interleaved endpoint bytes into floats.
/// Duplicating this per call site is how one path ends up decoding int32 as
/// float while another does not.</summary>
internal static class Audio
{
    public static float Sample(byte[] buf, int frameOffset, int channel, WaveFormat fmt)
    {
        int bytesPerSample = fmt.BitsPerSample / 8;
        int at = frameOffset + channel * bytesPerSample;
        if (at + bytesPerSample > buf.Length) return 0f;

        // Extensible is resolved by SubFormat, never by bit depth: a 32-bit
        // Extensible endpoint can legitimately be integer PCM.
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat
            || (fmt is WaveFormatExtensible x && x.SubFormat == new Guid("00000003-0000-0010-8000-00aa00389b71"));

        return fmt.BitsPerSample switch
        {
            32 => isFloat ? BitConverter.ToSingle(buf, at) : BitConverter.ToInt32(buf, at) / 2147483648f,
            16 => BitConverter.ToInt16(buf, at) / 32768f,
            24 => ((buf[at + 2] << 16 | buf[at + 1] << 8 | buf[at]) - (buf[at + 2] >= 0x80 ? 1 << 24 : 0)) / 8388608f,
            8 => (buf[at] - 128) / 128f,
            _ => 0f,
        };
    }
}

/// <summary>
/// Opens a WASAPI capture stream in RAW mode.
///
/// WHY THIS EXISTS. The Realtek "Microphone Array" endpoint on this machine runs
/// a noise-suppression/voice-focus APO in the shared-mode signal path. It emits
/// EXACT digital zeros whenever it decides the input is not speech, which is
/// every measurement sweep this tool plays. The captured buffers arrive at the
/// right rate and count and are simply empty — the failure looks like a broken
/// decoder, a muted device or a WASAPI misconfiguration, and is none of those.
/// Chrome does not see it because getUserMedia with the processing constraints
/// off asks for the raw stream; NAudio 2.2.1 never does.
///
/// AUDCLNT_STREAMOPTIONS_RAW tells the audio engine to bypass every APO on the
/// endpoint. It must be set on IAudioClient2 BEFORE IAudioClient::Initialize,
/// and NAudio exposes no hook for that — WasapiCapture initialises lazily inside
/// StartRecording, so the window to reach its client is after construction and
/// before StartRecording. Getting at it needs two private fields of NAudio
/// 2.2.1 (the version pinned in DelayProbe.csproj). If that ever breaks, this
/// returns false and capture continues unprocessed-but-gated rather than dying.
/// </summary>
internal static class RawMode
{
    private const int AudclntStreamoptionsRaw = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientProperties
    {
        public uint CbSize;
        public int IsOffload;      // BOOL
        public int Category;       // AUDIO_STREAM_CATEGORY
        public int Options;        // AUDCLNT_STREAMOPTIONS
    }

    // Only the last three slots are ever called; the twelve before them exist
    // solely to place SetClientProperties at the right vtable offset.
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("726778CD-F60A-4eda-82DE-E47610CD78AA")]
    private interface IAudioClient2
    {
        void Initialize_(); void GetBufferSize_(); void GetStreamLatency_(); void GetCurrentPadding_();
        void IsFormatSupported_(); void GetMixFormat_(); void GetDevicePeriod_(); void Start_();
        void Stop_(); void Reset_(); void SetEventHandle_(); void GetService_();
        [PreserveSig] int IsOffloadCapable(int category, out bool capable);
        [PreserveSig] int SetClientProperties(ref AudioClientProperties properties);
        [PreserveSig] int GetBufferSizeLimits(IntPtr format, bool eventDriven, out long min, out long max);
    }

    /// <summary>Call after constructing <paramref name="capture"/> and before
    /// StartRecording. Returns false if RAW could not be requested.</summary>
    public static bool TryEnable(WasapiCapture capture, out string detail)
    {
        try
        {
            var clientField = typeof(WasapiCapture).GetField("audioClient",
                BindingFlags.NonPublic | BindingFlags.Instance);
            var client = clientField?.GetValue(capture);
            if (client is null) { detail = "NAudio WasapiCapture.audioClient not found"; return false; }

            var ifaceField = client.GetType().GetField("audioClientInterface",
                BindingFlags.NonPublic | BindingFlags.Instance);
            if (ifaceField?.GetValue(client) is not object com)
            { detail = "NAudio AudioClient.audioClientInterface not found"; return false; }

            // Casting the RCW to our interface issues the QueryInterface for us.
            if (com is not IAudioClient2 c2) { detail = "endpoint does not implement IAudioClient2"; return false; }

            var props = new AudioClientProperties
            {
                CbSize = (uint)Marshal.SizeOf<AudioClientProperties>(),
                IsOffload = 0,
                Category = 0,                       // AudioCategory_Other
                Options = AudclntStreamoptionsRaw,
            };
            int hr = c2.SetClientProperties(ref props);
            detail = hr == 0 ? "raw" : $"SetClientProperties returned 0x{hr:X8}";
            return hr == 0;
        }
        catch (Exception ex) { detail = ex.GetType().Name + ": " + ex.Message; return false; }
    }
}
