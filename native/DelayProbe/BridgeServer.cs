using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace DelayProbe;

/// <summary>
/// Local HTTP bridge so the hosted web app (https://delay.losthusky.qzz.io) can
/// drive the native probe, which can do things the browser cannot: exclusive
/// mode, MMCSS priority, and Voicemeeter control.
///
/// Two non-obvious constraints shape this file:
///
/// 1. MIXED CONTENT. An https:// page is normally forbidden from fetching
///    http:// URLs. The exception is that Chrome/Edge (per the W3C "Secure
///    Contexts" spec) treat http://127.0.0.1 as *potentially trustworthy*, so
///    plain HTTP to the loopback literal is allowed from an HTTPS page with no
///    certificate anywhere. Note it is the LITERAL 127.0.0.1 that is reliably
///    trusted — "localhost" resolution has historically been squishier — so
///    the client must fetch http://127.0.0.1:PORT, not http://localhost:PORT.
///
/// 2. BINDING. We listen on 127.0.0.1 ONLY, never 0.0.0.0. This endpoint plays
///    audio and rewrites the user's Voicemeeter routing; anything reachable
///    from the LAN could do the same to them. Loopback-only also avoids the
///    admin-level URL ACL that a "+" prefix would need.
///
/// CORS headers go on EVERY response including errors, because a cross-origin
/// fetch whose error response lacks them surfaces in the browser as an opaque
/// network failure rather than the 4xx/5xx we actually sent.
/// </summary>
public static class BridgeServer
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static int Run(int port)
    {
        var prefix = $"http://127.0.0.1:{port}/";
        using var listener = new HttpListener();
        listener.Prefixes.Add(prefix);

        try { listener.Start(); }
        catch (HttpListenerException ex)
        {
            Console.Error.WriteLine($"error: cannot listen on {prefix} — {ex.Message}");
            return 1;
        }

        Console.WriteLine($"delayprobe bridge listening on {prefix}");
        Console.WriteLine("loopback only — not reachable from the network. Ctrl+C to stop.");

        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch (HttpListenerException) { break; }   // listener closed
            catch (ObjectDisposedException) { break; }

            try { Handle(ctx); }
            catch (Exception ex)
            {
                // One bad request must not take the bridge down: the user would
                // have to go back to the console to restart it mid-measurement.
                try { Write(ctx, 500, new { ok = false, error = ex.Message }); } catch { }
            }
        }
        return 0;
    }

    private static void Handle(HttpListenerContext ctx)
    {
        var path = ctx.Request.Url?.AbsolutePath.TrimEnd('/') ?? "";
        if (path.Length == 0) path = "/";

        if (ctx.Request.HttpMethod == "OPTIONS") { Write(ctx, 204, null); return; }

        switch (ctx.Request.HttpMethod + " " + path)
        {
            case "GET /health": Health(ctx); return;
            case "GET /devices": Devices(ctx); return;
            case "POST /measure": Measure(ctx); return;
            case "GET /voicemeeter/state": VmState(ctx); return;
            case "POST /voicemeeter/route": VmRoute(ctx); return;
            case "POST /voicemeeter/delay": VmDelay(ctx); return;
            case "POST /voicemeeter/bus-device": VmBusDevice(ctx); return;
            default:
                Write(ctx, 404, new { ok = false, error = $"no handler for {ctx.Request.HttpMethod} {path}" });
                return;
        }
    }

    // ─── Handlers ────────────────────────────────────────────────────────────

    private static void Health(HttpListenerContext ctx)
    {
        var vm = VoicemeeterControl.Query();
        Write(ctx, 200, new
        {
            ok = true,
            app = "delayprobe",
            version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0",
            voicemeeter = new
            {
                available = vm.Available,
                running = vm.Running,
                type = VoicemeeterControl.TypeName(vm.Type),
            },
        });
    }

    private static void Devices(HttpListenerContext ctx)
    {
        using var en = new MMDeviceEnumerator();
        static object[] List(MMDeviceEnumerator en, DataFlow flow) =>
            en.EnumerateAudioEndPoints(flow, DeviceState.Active)
              .Select((d, i) => (object)new { index = i, id = d.ID, name = d.FriendlyName })
              .ToArray();

        Write(ctx, 200, new
        {
            render = List(en, DataFlow.Render),
            capture = List(en, DataFlow.Capture),
        });
    }

    private static void Measure(HttpListenerContext ctx)
    {
        var body = ReadJson(ctx);
        string? output = Str(body, "output");
        string? input = Str(body, "input");
        bool exclusive = Bool(body, "exclusive") ?? false;
        int repeats = (int?)Num(body, "repeats") ?? 6;
        int rounds = (int?)Num(body, "rounds") ?? 1;

        if (string.IsNullOrWhiteSpace(output))
        {
            Write(ctx, 400, new { ok = false, error = "'output' is required" });
            return;
        }
        // Bounds mirror what a human would type at the CLI; unbounded values
        // here would block the single-threaded listener for minutes.
        if (repeats < 1 || repeats > 64 || rounds < 1 || rounds > 20)
        {
            Write(ctx, 400, new { ok = false, error = "repeats must be 1..64 and rounds 1..20" });
            return;
        }

        using var en = new MMDeviceEnumerator();
        MMDevice outDev, inDev;
        try
        {
            outDev = Program.ResolveDevice(en, DataFlow.Render, output);
            inDev = Program.ResolveDevice(en, DataFlow.Capture, input);
        }
        catch (ArgumentException ex)
        {
            Write(ctx, 400, new { ok = false, error = ex.Message });
            return;
        }

        var results = Program.RunRounds(outDev, inDev, exclusive, repeats, rounds, null);
        var good = results.Where(x => x.Ok).ToList();

        Write(ctx, 200, new
        {
            ok = good.Count == results.Count,
            output = outDev.FriendlyName,
            input = inDev.FriendlyName,
            mode = exclusive ? "exclusive" : "shared",
            rounds = results.Select(x => new
            {
                ok = x.Ok, delayMs = x.DelayMs, settledMs = x.SettledMs,
                jitterMs = x.JitterMs, driftMsPerSec = x.DriftMsPerSec,
                qualityDb = x.QualityDb, usedRepeats = x.UsedRepeats,
                delays = x.Delays, reason = x.Reason,
            }).ToArray(),
            medianDelayMs = good.Count > 0 ? Dsp.Median(good.Select(x => x.DelayMs).ToArray()) : (double?)null,
        });
    }

    private static void VmState(HttpListenerContext ctx)
    {
        var vm = VoicemeeterControl.Query();
        Write(ctx, 200, new
        {
            available = vm.Available,
            running = vm.Running,
            type = VoicemeeterControl.TypeName(vm.Type),
            buses = VoicemeeterControl.Buses()
                .Select(b => new { index = b.Index, label = b.Label, device = b.Device, delayMs = b.DelayMs })
                .ToArray(),
            strips = VoicemeeterControl.Strips()
                .Select(s => new { index = s.Index, label = s.Label, a = s.A, b = s.B })
                .ToArray(),
        });
    }

    private static void VmRoute(HttpListenerContext ctx)
    {
        var body = ReadJson(ctx);
        int? strip = (int?)Num(body, "strip");
        var a = BoolArray(body, "a");
        if (strip is null || a is null) { Write(ctx, 400, new { ok = false, error = "expected {strip:int, a:[bool]}" }); return; }
        Result(ctx, VoicemeeterControl.SetStripRouting(strip.Value, a));
    }

    private static void VmDelay(HttpListenerContext ctx)
    {
        var body = ReadJson(ctx);
        int? bus = (int?)Num(body, "bus");
        double? ms = Num(body, "ms");
        if (bus is null || ms is null) { Write(ctx, 400, new { ok = false, error = "expected {bus:int, ms:number}" }); return; }
        if (ms < 0 || ms > 500) { Write(ctx, 400, new { ok = false, error = "ms must be 0..500" }); return; }
        Result(ctx, VoicemeeterControl.SetBusDelay(bus.Value, ms.Value));
    }

    private static void VmBusDevice(HttpListenerContext ctx)
    {
        var body = ReadJson(ctx);
        int? bus = (int?)Num(body, "bus");
        string? device = Str(body, "device");
        string? driver = Str(body, "driver");
        if (bus is null || device is null || driver is null)
        {
            Write(ctx, 400, new { ok = false, error = "expected {bus:int, device:string, driver:\"wdm\"|\"ks\"|\"mme\"}" });
            return;
        }
        if (driver is not ("wdm" or "ks" or "mme")) { Write(ctx, 400, new { ok = false, error = "driver must be wdm, ks or mme" }); return; }
        Result(ctx, VoicemeeterControl.SetBusDevice(bus.Value, device, driver));
    }

    /// Voicemeeter setters fail for one of two reasons the caller can act on:
    /// it is not running, or the index/name was rejected. Both are 4xx.
    private static void Result(HttpListenerContext ctx, bool ok)
    {
        if (ok) { Write(ctx, 200, new { ok = true }); return; }
        var vm = VoicemeeterControl.Query();
        Write(ctx, 400, new
        {
            ok = false,
            error = !vm.Available ? "Voicemeeter is not installed"
                  : !vm.Running ? "Voicemeeter is not running"
                  : "Voicemeeter rejected the request (index out of range?)",
        });
    }

    // ─── Plumbing ────────────────────────────────────────────────────────────

    private static JsonElement? ReadJson(HttpListenerContext ctx)
    {
        using var sr = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8);
        var text = sr.ReadToEnd();
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { return null; }
    }

    private static string? Str(JsonElement? o, string k) =>
        o?.ValueKind == JsonValueKind.Object && o.Value.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static double? Num(JsonElement? o, string k) =>
        o?.ValueKind == JsonValueKind.Object && o.Value.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetDouble() : null;

    private static bool? Bool(JsonElement? o, string k) =>
        o?.ValueKind == JsonValueKind.Object && o.Value.TryGetProperty(k, out var v)
            && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean() : null;

    private static bool[]? BoolArray(JsonElement? o, string k)
    {
        if (o?.ValueKind != JsonValueKind.Object || !o.Value.TryGetProperty(k, out var v)
            || v.ValueKind != JsonValueKind.Array) return null;
        var list = new List<bool>();
        foreach (var e in v.EnumerateArray())
        {
            if (e.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            list.Add(e.GetBoolean());
        }
        return list.ToArray();
    }

    private static void Write(HttpListenerContext ctx, int status, object? payload)
    {
        var res = ctx.Response;
        res.StatusCode = status;
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type";

        if (payload is null) { res.ContentLength64 = 0; res.Close(); return; }

        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, Json));
        res.ContentType = "application/json";
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }
}
