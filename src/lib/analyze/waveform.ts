/**
 * uvid analyze waveform — media → one windowed RMS/peak JSON.
 *
 * Optional [fromMs, toMs) on the source timeline; windows use absolute ms.
 */
import { materializeInput, openFilterIo, writeJsonOutput } from "../io.ts";
import { decodeMonoPcm } from "../proc.ts";
import { type Ctx, fail } from "../util.ts";

export interface WaveformWindow {
  startMs: number;
  endMs: number;
  rmsDb: number | null;
  peakDb: number | null;
}

export interface WaveformReport {
  schemaVersion: 1;
  kind: "analyze.waveform";
  input: string;
  sampleRate: number;
  windowMs: number;
  fromMs: number;
  toMs: number | null;
  durationMs: number;
  windows: WaveformWindow[];
}

export interface AnalyzeWaveformParams {
  input?: string;
  output?: string;
  windowMs?: number;
  sampleRate?: number;
  /** Inclusive start on source timeline (ms). Default 0. */
  fromMs?: number;
  /** Exclusive end on source timeline (ms). Omit = end of media. */
  toMs?: number;
}

export async function computeWaveform(
  inputAbs: string,
  opts: {
    windowMs?: number;
    sampleRate?: number;
    fromMs?: number;
    toMs?: number;
    inputLabel?: string;
  },
  ctx: Ctx,
): Promise<WaveformReport> {
  const sampleRate = opts.sampleRate ?? 48000;
  const windowMs = opts.windowMs ?? 50;
  const fromMs = opts.fromMs != null && opts.fromMs > 0 ? Math.floor(opts.fromMs) : 0;
  const toMs = opts.toMs != null ? Math.floor(opts.toMs) : undefined;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) fail(`invalid sampleRate: ${sampleRate}`);
  if (!Number.isFinite(windowMs) || windowMs <= 0) fail(`invalid windowMs: ${windowMs}`);
  if (fromMs < 0) fail(`waveform --from-ms must be >= 0, got ${fromMs}`);
  if (toMs != null && toMs <= fromMs) {
    fail(`waveform window empty: --from-ms ${fromMs} --to-ms ${toMs} (need toMs > fromMs)`);
  }

  const samples = await decodeMonoPcm(inputAbs, sampleRate, {
    signal: ctx.signal,
    fromMs,
    toMs,
  });
  const totalSamples = samples.length;
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const windows: WaveformWindow[] = [];
  for (let start = 0; start < totalSamples; start += windowSamples) {
    const end = Math.min(totalSamples, start + windowSamples);
    let sumSq = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i] / 32768;
      const a = Math.abs(v);
      sumSq += v * v;
      if (a > peak) peak = a;
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(sumSq / count);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    windows.push({
      // absolute source times
      startMs: fromMs + Math.round((start / sampleRate) * 1000),
      endMs: fromMs + Math.round((end / sampleRate) * 1000),
      rmsDb: Number.isFinite(rmsDb) ? Number(rmsDb.toFixed(2)) : null,
      peakDb: Number.isFinite(peakDb) ? Number(peakDb.toFixed(2)) : null,
    });
  }

  const decodedMs = Math.round((totalSamples / sampleRate) * 1000);
  return {
    schemaVersion: 1,
    kind: "analyze.waveform",
    input: opts.inputLabel ?? inputAbs,
    sampleRate,
    windowMs,
    fromMs,
    toMs: toMs ?? null,
    durationMs: fromMs + decodedMs,
    windows,
  };
}

export async function analyzeWaveform(p: AnalyzeWaveformParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p);
  const mat = await materializeInput(ctx, input, { ext: ".media" });
  try {
    const report = await computeWaveform(
      mat.path,
      {
        windowMs: p.windowMs,
        sampleRate: p.sampleRate,
        fromMs: p.fromMs,
        toMs: p.toMs,
        inputLabel: input.label,
      },
      ctx,
    );
    writeJsonOutput(ctx, output, report);
  } finally {
    mat.cleanup();
  }
}
