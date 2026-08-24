using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace DelayProbe;

/// <summary>
/// P/Invoke wrapper around VoicemeeterRemote64.dll.
///
/// Why this lives in a latency tool at all: measuring the delay of two outputs
/// is only half the job. Voicemeeter is what actually plays one source to two
/// devices at once (Strip[i].A1 + Strip[i].A2 both set to 1) and what applies
/// the correction (Option.delay[i] holds the wired bus back until it lines up
/// with the Bluetooth one). So the probe measures, and this sets.
///
/// Nothing here throws out of the public surface: Voicemeeter is optional and
/// frequently absent, so callers get <see cref="Query"/> reporting
/// available=false rather than an exception to unwrap on every request.
/// </summary>
public static class VoicemeeterControl
{
    public enum Edition { None = 0, Standard = 1, Banana = 2, Potato = 3 }

    public sealed record State(bool Available, bool Running, Edition Type);

    /// <summary>Bus/strip/A-button counts per edition. Voicemeeter's own docs
    /// state these as fixed per edition; there is no runtime query for them.</summary>
    public static int BusCount(Edition e) => e switch
        { Edition.Standard => 2, Edition.Banana => 5, Edition.Potato => 8, _ => 0 };
    public static int StripCount(Edition e) => e switch
        { Edition.Standard => 3, Edition.Banana => 5, Edition.Potato => 8, _ => 0 };
    /// A1..An physical bus assignment buttons.
    public static int ACount(Edition e) => e switch
        { Edition.Standard => 1, Edition.Banana => 3, Edition.Potato => 5, _ => 0 };
    /// B1..Bn virtual bus assignment buttons.
    public static int BCount(Edition e) => e switch
        { Edition.Standard => 1, Edition.Banana => 2, Edition.Potato => 3, _ => 0 };

    // ─── DLL resolution ──────────────────────────────────────────────────────
    //
    // The DLL is NOT on PATH and its folder differs per install (Program Files
    // vs Program Files (x86), and users relocate it). Voicemeeter's own docs
    // tell clients to read the install folder out of the uninstall registry
    // key, which is what the user's existing VoicemeeterApi.cs does — same
    // approach copied here so both tools agree on which DLL they load.

    private const string RegKey32 = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
    private const string RegKey64 = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
    private const string Dll = "VoicemeeterRemote64.dll";

    private static readonly object Gate = new();
    private static string? _dllPath;
    private static bool _resolverInstalled;
    private static bool _loggedIn;
    private static bool _loadFailed;

    public static string? FindDllPath()
    {
        try
        {
            foreach (var key in new[] { RegKey64, RegKey32 })
            {
                using var hk = Registry.LocalMachine.OpenSubKey(key);
                if (hk is null) continue;

                // UninstallString is "C:\Program Files (x86)\VB\Voicemeeter\uninstall.exe";
                // the DLL ships alongside it.
                if (hk.GetValue("UninstallString") is string uninstall)
                {
                    var dir = Path.GetDirectoryName(uninstall.Trim('"'));
                    if (dir != null)
                    {
                        var p = Path.Combine(dir, Dll);
                        if (File.Exists(p)) return p;
                    }
                }
                if (hk.GetValue("INSTDIR") is string instDir)
                {
                    var p = Path.Combine(instDir, Dll);
                    if (File.Exists(p)) return p;
                }
            }

            foreach (var c in new[]
            {
                @"C:\Program Files (x86)\VB\Voicemeeter\" + Dll,
                @"C:\Program Files\VB\Voicemeeter\" + Dll,
            })
                if (File.Exists(c)) return c;
        }
        catch { /* registry access can fail under restricted tokens; treat as absent */ }

        return null;
    }

    // ─── Imports ─────────────────────────────────────────────────────────────

    [DllImport(Dll, EntryPoint = "VBVMR_Login", CallingConvention = CallingConvention.StdCall)]
    private static extern int VBVMR_Login();

    [DllImport(Dll, EntryPoint = "VBVMR_Logout", CallingConvention = CallingConvention.StdCall)]
    private static extern int VBVMR_Logout();

    [DllImport(Dll, EntryPoint = "VBVMR_RunVoicemeeter", CallingConvention = CallingConvention.StdCall)]
    private static extern int VBVMR_RunVoicemeeter(int vType);

    [DllImport(Dll, EntryPoint = "VBVMR_GetVoicemeeterType", CallingConvention = CallingConvention.StdCall)]
    private static extern int VBVMR_GetVoicemeeterType(out int type);

    [DllImport(Dll, EntryPoint = "VBVMR_IsParametersDirty", CallingConvention = CallingConvention.StdCall)]
    private static extern int VBVMR_IsParametersDirty();

    [DllImport(Dll, EntryPoint = "VBVMR_GetParameterFloat", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int VBVMR_GetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string name, out float value);

    [DllImport(Dll, EntryPoint = "VBVMR_SetParameterFloat", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int VBVMR_SetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string name, float value);

    [DllImport(Dll, EntryPoint = "VBVMR_GetParameterStringA", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int VBVMR_GetParameterStringA([MarshalAs(UnmanagedType.LPStr)] string name, byte[] buffer);

    [DllImport(Dll, EntryPoint = "VBVMR_SetParameterStringA", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int VBVMR_SetParameterStringA([MarshalAs(UnmanagedType.LPStr)] string name,
                                                        [MarshalAs(UnmanagedType.LPStr)] string value);

    // ─── Connection ──────────────────────────────────────────────────────────

    /// <summary>
    /// Ensures the DLL is loaded and we are logged in. Returns false (never
    /// throws) when Voicemeeter is not installed or the remote service refuses.
    /// </summary>
    public static bool Connect()
    {
        lock (Gate)
        {
            if (_loggedIn) return true;
            if (_loadFailed) return false;

            _dllPath ??= FindDllPath();
            if (_dllPath is null) { _loadFailed = true; return false; }

            if (!_resolverInstalled)
            {
                // DllImport by bare name would search PATH and fail; redirect it
                // to the absolute path we found in the registry.
                var path = _dllPath;
                NativeLibrary.SetDllImportResolver(typeof(VoicemeeterControl).Assembly,
                    (name, _, _) => name == Dll ? NativeLibrary.Load(path) : IntPtr.Zero);
                _resolverInstalled = true;
            }

            try
            {
                // Login succeeds (returning 1) even when Voicemeeter itself is
                // not running — that is a valid state, not a failure.
                int rc = VBVMR_Login();
                if (rc < 0) { _loadFailed = true; return false; }
                _loggedIn = true;
                try { VBVMR_IsParametersDirty(); } catch { }
                return true;
            }
            catch (DllNotFoundException) { _loadFailed = true; return false; }
            catch (EntryPointNotFoundException) { _loadFailed = true; return false; }
            catch (BadImageFormatException) { _loadFailed = true; return false; }
        }
    }

    public static void Logout()
    {
        lock (Gate)
        {
            if (!_loggedIn) return;
            _loggedIn = false;
            try { VBVMR_Logout(); } catch { }
        }
    }

    /// <summary>Launches Voicemeeter. vType 1=Standard, 2=Banana, 3=Potato.</summary>
    public static bool RunVoicemeeter(Edition edition = Edition.Banana)
    {
        if (!Connect()) return false;
        try { return VBVMR_RunVoicemeeter((int)edition) == 0; } catch { return false; }
    }

    public static State Query()
    {
        if (!Connect()) return new State(false, false, Edition.None);
        try
        {
            // GetVoicemeeterType fails while the audio engine is not up, which
            // is how "installed but not running" is distinguished from absent.
            if (VBVMR_GetVoicemeeterType(out int t) != 0 || t < 1 || t > 3)
                return new State(true, false, Edition.None);
            return new State(true, true, (Edition)t);
        }
        catch { return new State(false, false, Edition.None); }
    }

    public static string TypeName(Edition e) => e switch
    {
        Edition.Standard => "standard",
        Edition.Banana => "banana",
        Edition.Potato => "potato",
        _ => "none",
    };

    // ─── Parameters ──────────────────────────────────────────────────────────

    public static bool TryGetFloat(string name, out float value)
    {
        value = 0f;
        if (!Connect()) return false;
        try { return VBVMR_GetParameterFloat(name, out value) == 0; } catch { return false; }
    }

    public static bool SetFloat(string name, float value)
    {
        if (!Connect()) return false;
        try { return VBVMR_SetParameterFloat(name, value) == 0; } catch { return false; }
    }

    public static string GetString(string name)
    {
        if (!Connect()) return "";
        try
        {
            // 512 is the buffer size Voicemeeter's own C example uses.
            var buf = new byte[512];
            if (VBVMR_GetParameterStringA(name, buf) != 0) return "";
            int n = Array.IndexOf(buf, (byte)0);
            // Latin1, not ASCII: the ...StringA entry points return single-byte
            // ANSI, and ASCII.GetString would replace every byte >127 with '?',
            // mangling accented device names. Characters Voicemeeter itself
            // could not fit in one byte (e.g. an emoji in a device name) arrive
            // already substituted — that loss is in the A API, not here.
            return Encoding.Latin1.GetString(buf, 0, n < 0 ? buf.Length : n);
        }
        catch { return ""; }
    }

    public static bool SetString(string name, string value)
    {
        if (!Connect()) return false;
        try { return VBVMR_SetParameterStringA(name, value) == 0; } catch { return false; }
    }

    // ─── Typed views ─────────────────────────────────────────────────────────
    // All Voicemeeter indices are ZERO-based: Bus[0] is the bus labelled "A1"
    // in the GUI, Strip[0] is the leftmost input strip. Callers pass GUI-order
    // numbers minus one; the HTTP layer takes the zero-based form directly.

    public sealed record BusInfo(int Index, string Label, string Device, double DelayMs);
    public sealed record StripInfo(int Index, string Label, bool[] A, bool[] B);

    public static List<BusInfo> Buses()
    {
        var st = Query();
        var list = new List<BusInfo>();
        for (int i = 0; i < BusCount(st.Type); i++)
        {
            // device.name is read-only and empty for virtual buses — expected,
            // not an error. Option.delay[i] likewise only exists on physical ones.
            TryGetFloat($"Option.delay[{i}]", out float delay);
            list.Add(new BusInfo(i, GetString($"Bus[{i}].Label"),
                                 GetString($"Bus[{i}].device.name"), delay));
        }
        return list;
    }

    public static List<StripInfo> Strips()
    {
        var st = Query();
        var list = new List<StripInfo>();
        int na = ACount(st.Type), nb = BCount(st.Type);
        for (int i = 0; i < StripCount(st.Type); i++)
        {
            var a = new bool[na];
            for (int k = 0; k < na; k++)
                a[k] = TryGetFloat($"Strip[{i}].A{k + 1}", out float v) && v >= 0.5f;
            var b = new bool[nb];
            for (int k = 0; k < nb; k++)
                b[k] = TryGetFloat($"Strip[{i}].B{k + 1}", out float v) && v >= 0.5f;
            list.Add(new StripInfo(i, GetString($"Strip[{i}].Label"), a, b));
        }
        return list;
    }

    /// <summary>
    /// Sets Strip[strip].A1..An. Setting two entries true is exactly how one
    /// source is played to two physical outputs at once — the case this whole
    /// tool exists to align.
    /// </summary>
    public static bool SetStripRouting(int strip, IReadOnlyList<bool> a)
    {
        var st = Query();
        if (!st.Running) return false;
        if (strip < 0 || strip >= StripCount(st.Type)) return false;
        int na = ACount(st.Type);
        bool ok = true;
        for (int k = 0; k < a.Count && k < na; k++)
            ok &= SetFloat($"Strip[{strip}].A{k + 1}", a[k] ? 1f : 0f);
        return ok;
    }

    /// <summary>Per-bus output delay, 0..500 ms. The compensation knob.</summary>
    public static bool SetBusDelay(int bus, double ms)
    {
        var st = Query();
        if (!st.Running) return false;
        if (bus < 0 || bus >= BusCount(st.Type)) return false;
        return SetFloat($"Option.delay[{bus}]", (float)Math.Clamp(ms, 0, 500));
    }

    /// <summary>Assigns a device to a bus. These parameters are write-only;
    /// the result shows up afterwards in Bus[i].device.name.</summary>
    public static bool SetBusDevice(int bus, string device, string driver)
    {
        var st = Query();
        if (!st.Running) return false;
        if (bus < 0 || bus >= BusCount(st.Type)) return false;
        driver = driver.ToLowerInvariant();
        if (driver is not ("wdm" or "ks" or "mme")) return false;
        return SetString($"Bus[{bus}].device.{driver}", device);
    }
}
