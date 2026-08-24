using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace DelayProbe;

/// <summary>
/// Per-run archive under %LOCALAPPDATA%\delayprobe\runs. Latency numbers are only
/// worth anything next to the conditions they were taken in — device, format,
/// capture level, mode — and a console that has scrolled away holds none of that.
///
/// Every method swallows its own IO errors. A full disk, a roaming profile that
/// is not writable, an antivirus holding the file: none of those are reasons to
/// lose a measurement the user just spent ten seconds making noise for.
/// </summary>
internal sealed class RunLog : IDisposable
{
    public static string Root =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                     "delayprobe", "runs");

    private readonly StreamWriter? _log;
    private readonly TextWriter? _previousOut;
    public string? Folder { get; }

    private RunLog(string? folder, StreamWriter? log, TextWriter? previousOut)
    {
        Folder = folder; _log = log; _previousOut = previousOut;
    }

    /// <summary>Opens a run folder and starts teeing Console.Out into run.log, so the
    /// transcript is captured without every print site having to know about logging.</summary>
    public static RunLog Start(string deviceLabel)
    {
        try
        {
            var now = DateTime.Now;
            var dir = Path.Combine(Root, now.ToString("yyyy-MM-dd"),
                                   now.ToString("HHmmss") + "-" + Sanitise(deviceLabel));
            Directory.CreateDirectory(dir);

            var log = new StreamWriter(Path.Combine(dir, "run.log"), append: true, Encoding.UTF8)
                { AutoFlush = true };
            log.WriteLine($"delayprobe {Ui.Version}  {now:yyyy-MM-dd HH:mm:ss}");

            var prev = Console.Out;
            Console.SetOut(new TeeWriter(prev, log));
            return new RunLog(dir, log, prev);
        }
        catch { return new RunLog(null, null, null); }
    }

    public void Note(string line) { try { _log?.WriteLine(line); } catch { } }

    public void Finish(object payload)
    {
        if (Folder is null) return;
        try
        {
            File.WriteAllText(Path.Combine(Folder, "run.json"),
                JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    public void Dispose()
    {
        try { if (_previousOut is not null) Console.SetOut(_previousOut); } catch { }
        try { _log?.Dispose(); } catch { }
    }

    /// <summary>Folder names come from device friendly names, which contain path
    /// separators, parentheses and emoji. Keep it to characters every shell and
    /// every archive tool handles.</summary>
    private static string Sanitise(string s)
    {
        var sb = new StringBuilder();
        foreach (var c in s)
        {
            if (char.IsAsciiLetterOrDigit(c)) sb.Append(c);
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
            if (sb.Length >= 48) break;
        }
        var name = sb.ToString().Trim('-');
        return name.Length == 0 ? "device" : name;
    }

    public static int ShowFolder(bool open)
    {
        Console.WriteLine(Root);
        if (!Directory.Exists(Root))
        {
            Ui.Line(ConsoleColor.DarkGray, "(no runs recorded yet)");
            return 0;
        }
        if (open)
        {
            // UseShellExecute is what makes this open Explorer rather than try to
            // execute a directory.
            try { Process.Start(new ProcessStartInfo(Root) { UseShellExecute = true }); }
            catch (Exception ex) { Ui.Line(ConsoleColor.Yellow, "could not open it: " + ex.Message); }
        }
        return 0;
    }

    private sealed class TeeWriter : TextWriter
    {
        private readonly TextWriter _a, _b;
        public TeeWriter(TextWriter a, TextWriter b) { _a = a; _b = b; }
        public override Encoding Encoding => _a.Encoding;
        public override void Write(char c) { _a.Write(c); try { _b.Write(c); } catch { } }
        public override void Write(string? s) { _a.Write(s); try { _b.Write(s); } catch { } }
        public override void WriteLine(string? s) { _a.WriteLine(s); try { _b.WriteLine(s); } catch { } }
        public override void Flush() { _a.Flush(); try { _b.Flush(); } catch { } }
    }
}
