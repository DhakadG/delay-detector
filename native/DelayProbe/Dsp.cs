namespace DelayProbe;

/// <summary>
/// Port of src/engine.js. Deliberately a straight port rather than a
/// re-derivation: if the native probe and the web app disagreed on the DSP,
/// comparing their numbers would tell you nothing about the audio path, which
/// is the entire reason the native probe exists.
/// </summary>
public static class Dsp
{
    public const double SpeedOfSound = 343.0;

    public sealed record Options(
        double F0 = 500,
        double F1 = 8000,
        double SweepSec = 0.04,
        int Repeats = 6,
        // INVARIANT: GapMinSec > MaxLagSec + SweepSec, or consecutive sweeps
        // alias onto each other and produce confident wrong answers.
        double GapMinSec = 0.65,
        double GapMaxSec = 0.75,
        double MaxLagSec = 0.55,
        bool Warmup = true,
        double Amplitude = 0.25,
        double MinPeakQualityDb = 18,
        double MaxJitterMs = 5,
        double MaxDriftMsPerSec = 2,
        double FirstPeakFrac = 0.7);

    public sealed record Stimulus(float[] Signal, int[] Offsets, float[] Sweep, int SampleRate)
    {
        public double DurationSec => (double)Signal.Length / SampleRate;
    }

    public static float[] MakeSweep(int sampleRate, Options o)
    {
        int n = (int)Math.Round(o.SweepSec * sampleRate);
        var outp = new float[n];
        double k = (o.F1 - o.F0) / o.SweepSec;
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / sampleRate;
            double phase = 2 * Math.PI * (o.F0 * t + 0.5 * k * t * t);
            double w = 0.5 * (1 - Math.Cos(2 * Math.PI * i / (n - 1)));
            outp[i] = (float)(o.Amplitude * w * Math.Sin(phase));
        }
        return outp;
    }

    public static Stimulus MakeStimulus(int sampleRate, Options o, Random rand)
    {
        if (o.GapMaxSec < o.GapMinSec)
            throw new ArgumentException($"GapMaxSec ({o.GapMaxSec}) must be >= GapMinSec ({o.GapMinSec})");
        double minGapNeeded = o.MaxLagSec + o.SweepSec;
        if (o.GapMinSec <= minGapNeeded)
            throw new ArgumentException(
                $"GapMinSec ({o.GapMinSec}s) must exceed MaxLagSec + SweepSec ({minGapNeeded:F3}s), " +
                "otherwise consecutive sweeps alias onto each other");

        var sweep = MakeSweep(sampleRate, o);
        int RandomGap() => (int)Math.Round((o.GapMinSec + rand.NextDouble() * (o.GapMaxSec - o.GapMinSec)) * sampleRate);

        var offsets = new List<int>();
        var parts = new List<float[]>();
        int cursor = 0;

        // Throwaway leading sweep: BT links power the path down when idle and
        // mangle whichever sweep goes first. Not added to Offsets.
        if (o.Warmup)
        {
            parts.Add(sweep); cursor += sweep.Length;
            int g0 = RandomGap(); parts.Add(new float[g0]); cursor += g0;
        }

        for (int i = 0; i < o.Repeats; i++)
        {
            offsets.Add(cursor);
            parts.Add(sweep); cursor += sweep.Length;
            int g = RandomGap(); parts.Add(new float[g]); cursor += g;
        }

        var signal = new float[cursor];
        int p = 0;
        foreach (var part in parts) { Array.Copy(part, 0, signal, p, part.Length); p += part.Length; }
        return new Stimulus(signal, offsets.ToArray(), sweep, sampleRate);
    }

    public static float[] Correlate(float[] rec, float[] reference, int maxLag)
    {
        int m = reference.Length;
        int lastLag = Math.Min(maxLag, rec.Length - m);
        if (lastLag < 0) return Array.Empty<float>();
        var outp = new float[lastLag + 1];

        double refEnergy = 0;
        for (int k = 0; k < m; k++) refEnergy += reference[k] * reference[k];
        if (refEnergy == 0) return outp;

        double winEnergy = 0;
        for (int k = 0; k < m; k++) winEnergy += rec[k] * rec[k];

        for (int lag = 0; lag <= lastLag; lag++)
        {
            double dot = 0;
            for (int k = 0; k < m; k++) dot += rec[lag + k] * reference[k];
            double denom = Math.Sqrt(winEnergy * refEnergy);
            outp[lag] = denom > 0 ? (float)(dot / denom) : 0f;
            double add = lag + m < rec.Length ? rec[lag + m] : 0;
            winEnergy += add * add - (double)rec[lag] * rec[lag];
            if (winEnergy < 0) winEnergy = 0;
        }
        return outp;
    }

    private static double SubSample(float[] c, int i)
    {
        if (i <= 0 || i >= c.Length - 1) return 0;
        double a = Math.Abs(c[i - 1]), b = Math.Abs(c[i]), d = Math.Abs(c[i + 1]);
        double denom = a - 2 * b + d;
        if (denom == 0) return 0;
        double frac = 0.5 * (a - d) / denom;
        return Math.Abs(frac) <= 1 ? frac : 0;
    }

    public sealed record Arrival(double Index, double QualityDb);

    /// First-peak rule: the earliest crest above FirstPeakFrac * max, not the
    /// global max. A reflection can be louder than the direct sound; it can
    /// never arrive before it.
    public static Arrival? PickArrival(float[] c, int from, int to, int refLen, Options o)
    {
        int hi = Math.Min(to, c.Length);
        if (from >= hi) return null;

        double max = 0;
        for (int i = from; i < hi; i++) max = Math.Max(max, Math.Abs(c[i]));
        if (max == 0) return null;

        double thresh = o.FirstPeakFrac * max;
        int peak = -1;
        for (int i = from; i < hi; i++)
        {
            if (Math.Abs(c[i]) >= thresh)
            {
                int j = i;
                while (j + 1 < hi && Math.Abs(c[j + 1]) > Math.Abs(c[j])) j++;
                peak = j;
                break;
            }
        }
        if (peak < 0) return null;

        double sum = 0; int n = 0;
        for (int i = from; i < hi; i++)
        {
            if (Math.Abs(i - peak) <= refLen) continue;
            sum += (double)c[i] * c[i]; n++;
        }
        double noiseRms = n > 0 ? Math.Sqrt(sum / n) : 0;
        double qualityDb = noiseRms > 0 ? 20 * Math.Log10(Math.Abs(c[peak]) / noiseRms) : double.PositiveInfinity;
        return new Arrival(peak + SubSample(c, peak), qualityDb);
    }

    public static double Median(IReadOnlyList<double> xs)
    {
        if (xs.Count == 0) return double.NaN;
        var s = xs.OrderBy(x => x).ToArray();
        int mid = s.Length / 2;
        return s.Length % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    public static double Mad(IReadOnlyList<double> xs)
    {
        double m = Median(xs);
        return Median(xs.Select(x => Math.Abs(x - m)).ToArray());
    }

    public static (double Slope, double Intercept) LinearFit(IReadOnlyList<double> xs, IReadOnlyList<double> ys)
    {
        int n = xs.Count;
        if (n < 2) return (0, n == 1 ? ys[0] : 0);
        double sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (int i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
        double det = n * sxx - sx * sx;
        if (det == 0) return (0, sy / n);
        double slope = (n * sxy - sx * sy) / det;
        return (slope, (sy - slope * sx) / n);
    }

    public sealed record Result(
        bool Ok, double DelayMs, double SettledMs, double SpreadMs, double JitterMs,
        double DriftMsPerSec, double DriftTotalMs, bool Drifting,
        int UsedRepeats, int TrimmedOutliers, double QualityDb,
        double[] Delays, string? Reason);

    public static Result Measure(float[] rec, Stimulus st, Options o)
    {
        int maxLagSamples = (int)Math.Round(o.MaxLagSec * st.SampleRate);
        var c = Correlate(rec, st.Sweep, st.Offsets[^1] + maxLagSamples);

        var tSec = new List<double>();
        var delayMs = new List<double>();
        var quality = new List<double>();
        int rejected = 0;

        foreach (int off in st.Offsets)
        {
            var hit = PickArrival(c, off, off + maxLagSamples, st.Sweep.Length, o);
            if (hit is null || hit.QualityDb < o.MinPeakQualityDb) { rejected++; continue; }
            tSec.Add((double)off / st.SampleRate);
            delayMs.Add((hit.Index - off) / st.SampleRate * 1000.0);
            quality.Add(hit.QualityDb);
        }

        if (delayMs.Count < 3)
            return new Result(false, double.NaN, double.NaN, double.NaN, double.NaN, 0, 0, false,
                delayMs.Count, 0, double.NaN, delayMs.ToArray(), "too few usable repeats");

        // Coarse trim against the median, before fitting, so one wild value
        // cannot drag the trend line with it.
        double rawMedian = Median(delayMs);
        double coarseBound = Math.Max(8, o.MaxJitterMs * 3);
        var keep = Enumerable.Range(0, delayMs.Count)
            .Where(i => Math.Abs(delayMs[i] - rawMedian) <= coarseBound).ToList();
        if (keep.Count < 3) keep = Enumerable.Range(0, delayMs.Count).ToList();

        var (slope, intercept) = LinearFit(keep.Select(i => tSec[i]).ToArray(), keep.Select(i => delayMs[i]).ToArray());
        double Residual(int i) => delayMs[i] - (intercept + slope * tSec[i]);

        // Fine trim against the fitted line, so a genuinely drifting series is
        // not mistaken for a series full of outliers.
        double resMad = Mad(keep.Select(Residual).ToArray());
        double fineBound = Math.Max(3, resMad * 3);
        var keep2 = keep.Where(i => Math.Abs(Residual(i)) <= fineBound).ToList();
        if (keep2.Count >= 3)
        {
            keep = keep2;
            (slope, intercept) = LinearFit(keep.Select(i => tSec[i]).ToArray(), keep.Select(i => delayMs[i]).ToArray());
        }

        var kept = keep.Select(i => delayMs[i]).ToArray();
        double spanSec = tSec[keep[^1]] - tSec[keep[0]];
        double driftTotal = slope * spanSec;
        bool drifting = Math.Abs(slope) > o.MaxDriftMsPerSec;
        double jitter = Mad(keep.Select(Residual).ToArray());
        double settled = intercept + slope * tSec[keep[^1]];

        bool ok = jitter <= o.MaxJitterMs && !drifting;
        string? reason = jitter > o.MaxJitterMs
            ? "inconsistent repeats — unstable link, reflections, or the mic moved"
            : drifting
                ? $"latency drifted {driftTotal:+0.0;-0.0} ms across the run — the device clock has not settled"
                : null;

        return new Result(ok, Median(kept), settled, Mad(kept), jitter, slope, driftTotal, drifting,
            kept.Length, delayMs.Count - kept.Length, Median(keep.Select(i => quality[i]).ToArray()),
            kept, reason);
    }
}
