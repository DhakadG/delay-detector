using System.Reflection;
using NAudio.CoreAudioApi;

namespace DelayProbe;

/// <summary>
/// Console presentation, shared by the interactive menu and the CLI so the two
/// never drift into describing the same state differently.
///
/// Everything drawn here is ASCII. Box-drawing characters render as mojibake in
/// the default Windows console codepage (437/850), and a table whose borders are
/// garbage is worse than one made of dashes.
/// </summary>
internal static class Ui
{
    public static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    public static void Write(ConsoleColor c, string text)
    {
        var prev = Console.ForegroundColor;
        // Colour may be unavailable (redirected output, some terminals); the text
        // still has to appear, so failure to set it is not failure to print.
        try { Console.ForegroundColor = c; Console.Write(text); }
        finally { try { Console.ForegroundColor = prev; } catch { } }
    }

    public static void Line(ConsoleColor c, string text) { Write(c, text); Console.WriteLine(); }

    public static void Rule(string title)
    {
        Console.WriteLine();
        Line(ConsoleColor.DarkCyan, "-- " + title + " " + new string('-', Math.Max(3, 60 - title.Length)));
    }

    public static void Header()
    {
        var vm = VoicemeeterControl.Query();
        Console.WriteLine();
        Line(ConsoleColor.White, $"  delayprobe {Version}   acoustic output-latency measurement over WASAPI");
        Write(ConsoleColor.Gray, "  Voicemeeter: ");
        if (!vm.Available) Line(ConsoleColor.DarkGray, "not installed");
        else if (!vm.Running) Line(ConsoleColor.Yellow, "installed, not running");
        else Line(ConsoleColor.Green, $"{VoicemeeterControl.TypeName(vm.Type)} running");
    }

    // ─── Devices ─────────────────────────────────────────────────────────────

    /// <summary>Device tables in aligned columns. Returns the lists so a caller
    /// that then asks the user to pick one is choosing from what was displayed.</summary>
    public static (List<MMDevice> Render, List<MMDevice> Capture) DeviceTables(MMDeviceEnumerator en, bool withIds)
    {
        var render = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).ToList();
        var capture = en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active).ToList();
        string? defRender = TryDefaultId(en, DataFlow.Render), defCapture = TryDefaultId(en, DataFlow.Capture);

        Rule("outputs (render)");
        Table(render, defRender, withIds);
        Rule("inputs (capture)");
        Table(capture, defCapture, withIds);
        return (render, capture);
    }

    private static string? TryDefaultId(MMDeviceEnumerator en, DataFlow flow)
    {
        try { return en.GetDefaultAudioEndpoint(flow, Role.Multimedia).ID; } catch { return null; }
    }

    private static void Table(List<MMDevice> devs, string? defaultId, bool withIds)
    {
        int w = devs.Count == 0 ? 4 : Math.Min(52, devs.Max(d => d.FriendlyName.Length));
        for (int i = 0; i < devs.Count; i++)
        {
            bool isDefault = devs[i].ID == defaultId;
            Write(ConsoleColor.DarkGray, $"  [{i}] ");
            // Pad only when something follows, so non-default rows do not end in
            // trailing spaces (emoji in device names make the width a guess anyway).
            Write(isDefault ? ConsoleColor.Green : ConsoleColor.Gray,
                  isDefault ? devs[i].FriendlyName.PadRight(w) : devs[i].FriendlyName);
            Line(ConsoleColor.DarkGray, isDefault ? "  (default)" : "");
            if (withIds) Line(ConsoleColor.DarkGray, "      " + devs[i].ID);
        }
        if (devs.Count == 0) Line(ConsoleColor.DarkGray, "  (none)");
    }

    // ─── Voicemeeter ─────────────────────────────────────────────────────────

    public static int ShowVoicemeeter()
    {
        var vm = VoicemeeterControl.Query();
        if (!vm.Available)
        {
            Line(ConsoleColor.Yellow, "Voicemeeter is not installed (VoicemeeterRemote64.dll not found).");
            return 1;
        }
        if (!vm.Running)
        {
            Line(ConsoleColor.Yellow, "Voicemeeter is installed but not running.");
            return 1;
        }

        Rule($"Voicemeeter {VoicemeeterControl.TypeName(vm.Type)}");
        Line(ConsoleColor.DarkGray, "  bus   label             delay   device");
        foreach (var b in VoicemeeterControl.Buses())
        {
            Write(ConsoleColor.DarkGray, $"  [{b.Index}]   ");
            Write(ConsoleColor.Gray, b.Label.PadRight(16));
            Write(b.DelayMs > 0 ? ConsoleColor.Cyan : ConsoleColor.DarkGray, $"{b.DelayMs,5:F0}ms");
            Line(b.Device.Length > 0 ? ConsoleColor.Gray : ConsoleColor.DarkGray,
                 "   " + (b.Device.Length > 0 ? b.Device : "(no device)"));
        }

        Console.WriteLine();
        Line(ConsoleColor.DarkGray, "  strip label             A-buses   B-buses");
        foreach (var s in VoicemeeterControl.Strips())
        {
            Write(ConsoleColor.DarkGray, $"  [{s.Index}]   ");
            Write(ConsoleColor.Gray, s.Label.PadRight(16));
            Write(ConsoleColor.Gray, Bits(s.A).PadRight(10));
            Line(ConsoleColor.Gray, Bits(s.B));
        }
        Console.WriteLine();
        Line(ConsoleColor.DarkGray,
             "  Voicemeeter accepts at most 4 remote clients; delayprobe holds one while it runs.");
        return 0;
    }

    /// Assignment buttons as "A1 A2 -" rather than "110": the second form needs
    /// the reader to count columns to work out which bus is on.
    private static string Bits(bool[] flags) =>
        flags.Length == 0 ? "-" : string.Join(' ', flags.Select((on, i) => on ? $"{i + 1}" : "-"));

    // ─── Results ─────────────────────────────────────────────────────────────

    public static void ResultsTable(IReadOnlyList<Dsp.Result> results)
    {
        Rule("results");
        Line(ConsoleColor.DarkGray, "  round     delay    settled    jitter      drift   peak  status");
        for (int i = 0; i < results.Count; i++)
        {
            var r = results[i];
            Write(ConsoleColor.DarkGray, $"  {i + 1,5}  ");
            Write(r.Ok ? ConsoleColor.White : ConsoleColor.DarkGray,
                  $"{Fmt(r.DelayMs),8} {Fmt(r.SettledMs),10} {Fmt(r.JitterMs),9} " +
                  $"{Fmt(r.DriftMsPerSec),10} {Fmt(r.QualityDb),6}  ");
            Line(r.Ok ? ConsoleColor.Green : ConsoleColor.Red, r.Ok ? "ok" : r.Reason ?? "failed");
        }

        var good = results.Where(x => x.Ok).ToList();
        Console.WriteLine();
        if (good.Count == 0) Line(ConsoleColor.Red, "  no usable rounds.");
        else
            Line(ConsoleColor.Cyan,
                 $"  median across {good.Count}/{results.Count} good round(s): " +
                 $"{Dsp.Median(good.Select(x => x.DelayMs).ToArray()):F2} ms");
    }

    private static string Fmt(double v) => double.IsNaN(v) ? "-" : v.ToString("F2");
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
            Ui.Header();
            Ui.Rule("menu");
            Console.WriteLine("  1) list audio devices");
            Console.WriteLine("  2) run a measurement");
            Console.WriteLine("  3) Voicemeeter state");
            Console.WriteLine("  4) start bridge server (for the web app)");
            Console.WriteLine("  5) listen to an input (capture diagnostic)");
            Console.WriteLine("  6) open the run-log folder");
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
                    case "3": Ui.ShowVoicemeeter(); break;
                    case "4": StartBridge(); break;
                    case "5": ListenPrompt(); break;
                    case "6": RunLog.ShowFolder(open: true); break;
                    default: Ui.Line(ConsoleColor.Yellow, "pick 1-6 or q"); break;
                }
            }
            catch (Exception ex)
            {
                Ui.Line(ConsoleColor.Red, "error: " + ex.Message);
            }
        }
    }

    private static string Ask(string prompt, string fallback)
    {
        Ui.Write(ConsoleColor.DarkGray, prompt);
        var s = Console.ReadLine()?.Trim();
        return string.IsNullOrWhiteSpace(s) ? fallback : s;
    }

    private static void MeasurePrompt()
    {
        using var en = new MMDeviceEnumerator();
        Ui.DeviceTables(en, withIds: false);
        Console.WriteLine();

        var output = Ask("output device (index, id or name): ", "");
        if (output.Length == 0) { Ui.Line(ConsoleColor.Yellow, "cancelled"); return; }
        var input = Ask("input device (blank = system default): ", "");
        var rounds = Ask("rounds [1]: ", "1");
        var exclusive = Ask("exclusive mode? [y/N]: ", "n");

        var args = new List<string> { "measure", "--output", output, "--rounds", rounds };
        if (input.Length > 0) { args.Add("--input"); args.Add(input); }
        if (exclusive.StartsWith('y') || exclusive.StartsWith('Y')) args.Add("--exclusive");

        // Echo what the words actually resolved to: "Speakers" matching a different
        // endpoint than the user meant is otherwise only visible in the result.
        Ui.Rule("running");
        try
        {
            Ui.Line(ConsoleColor.Gray, "  output : " + Program.ResolveDevice(en, DataFlow.Render, output).FriendlyName);
            Ui.Line(ConsoleColor.Gray, "  input  : " +
                Program.ResolveDevice(en, DataFlow.Capture, input.Length > 0 ? input : null).FriendlyName);
        }
        catch (Exception ex) { Ui.Line(ConsoleColor.Red, "  " + ex.Message); return; }
        Ui.Line(ConsoleColor.Gray, "  rounds : " + rounds);
        Ui.Line(ConsoleColor.Gray, "  mode   : " + (args.Contains("--exclusive") ? "exclusive" : "shared"));

        Program.Measure(args.ToArray());
    }

    private static void ListenPrompt()
    {
        using var en = new MMDeviceEnumerator();
        Ui.DeviceTables(en, withIds: false);
        Console.WriteLine();
        var input = Ask("input device (blank = system default): ", "");
        var seconds = Ask("seconds [5]: ", "5");
        var args = new List<string> { "listen", "--seconds", seconds };
        if (input.Length > 0) { args.Add("--input"); args.Add(input); }
        Diagnostics.Listen(args.ToArray());
    }

    private static void StartBridge()
    {
        var port = Ask("port [8765]: ", "8765");
        if (!int.TryParse(port, out int p)) { Ui.Line(ConsoleColor.Red, "not a port number"); return; }
        BridgeServer.Run(p);   // blocks until the listener is closed
    }
}
