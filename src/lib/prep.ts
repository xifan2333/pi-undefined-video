/**
 * Audio commands: loudness normalization/measurement and generic waveform reports.
 */
import path from "node:path";
import { type Ctx, ensureDir, fail, outputJson, rel, resolveExisting, resolvePath } from "./util.ts";
import { decodeMonoPcm, ffmpeg, hasVideoStream, loudnormMeasure } from "./proc.ts";

export interface LoudnessCreateParams {
  input: string;
  output: string;
  lufs: number;
  tp: number;
  lra: number;
}

/** Two-pass linear loudnorm to a fixed LUFS target. Video streams are copied untouched. */
export async function audioCreateLoudness(p: LoudnessCreateParams, ctx: Ctx): Promise<void> {
  const input = resolveExisting(ctx, p.input, "input");
  const output = resolvePath(ctx, p.output);
  ensureDir(path.dirname(output));

  const isVideo = await hasVideoStream(input, ctx);
  ctx.log(`uvid prep normalize: ${rel(ctx, input)} → ${rel(ctx, output)}`);
  ctx.log(`  target: I=${p.lufs} LUFS, TP=${p.tp} dBTP, LRA=${p.lra}, ar=48000`);
  ctx.log("  pass 1: measuring loudness");
  const m = await loudnormMeasure(input, p.lufs, p.tp, p.lra, ctx);
  ctx.log(`  measured: I=${m.input_i} LUFS, TP=${m.input_tp} dBTP, LRA=${m.input_lra}, thresh=${m.input_thresh}, offset=${m.target_offset}`);

  const filter = [
    `loudnorm=I=${p.lufs}:TP=${p.tp}:LRA=${p.lra}`,
    `measured_I=${m.input_i}`,
    `measured_TP=${m.input_tp}`,
    `measured_LRA=${m.input_lra}`,
    `measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}`,
    "linear=true",
    "print_format=summary",
  ].join(":") + ",aresample=48000";

  ctx.log("  pass 2: writing normalized output");
  if (isVideo) {
    await ffmpeg(["-i", input, "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output], ctx);
  } else {
    await ffmpeg(["-i", input, "-af", filter, "-ar", "48000", output], ctx);
  }
  ctx.log("uvid prep normalize: done");
}

export interface LoudnessGetParams {
  input: string;
}

/** Measure integrated loudness with ffmpeg ebur128. */
export async function audioGetLoudness(p: LoudnessGetParams, ctx: Ctx): Promise<void> {
  const input = resolveExisting(ctx, p.input, "input");
  const log = await ffmpeg(["-i", input, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], ctx);

  const integrated = [...log.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/g)].at(-1)?.[1];
  const lra = [...log.matchAll(/LRA:\s*(-?\d+(?:\.\d+)?)\s+LU/g)].at(-1)?.[1];
  const peak = [...log.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/g)].at(-1)?.[1];
  if (!integrated) fail("could not parse integrated loudness from ffmpeg ebur128 output");

  ctx.log(`uvid prep loudness: ${rel(ctx, input)}`);
  ctx.log(`  I: ${integrated} LUFS`);
  if (lra) ctx.log(`  LRA: ${lra} LU`);
  if (peak) ctx.log(`  Peak: ${peak} dBFS`);
}

export interface WaveformGetParams {
  input: string;
  output?: string;
  windowMs?: number;
  sampleRate?: number;
}

/** Windowed RMS/peak waveform report for one media file. */
export async function audioGetWaveform(p: WaveformGetParams, ctx: Ctx): Promise<void> {
  const input = resolveExisting(ctx, p.input, "input");
  const sampleRate = p.sampleRate ?? 48000;
  const windowMs = p.windowMs ?? 50;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) fail(`invalid --sample-rate: ${p.sampleRate}`);
  if (!Number.isFinite(windowMs) || windowMs <= 0) fail(`invalid --window-ms: ${p.windowMs}`);

  const samples = await decodeMonoPcm(input, sampleRate, ctx);
  const totalSamples = samples.length;
  const windowSamples = Math.max(1, Math.round(sampleRate * windowMs / 1000));
  const windows: any[] = [];
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
      startMs: Math.round(start / sampleRate * 1000),
      endMs: Math.round(end / sampleRate * 1000),
      rmsDb: Number.isFinite(rmsDb) ? Number(rmsDb.toFixed(2)) : null,
      peakDb: Number.isFinite(peakDb) ? Number(peakDb.toFixed(2)) : null,
    });
  }

  outputJson(ctx, {
    schemaVersion: 1,
    kind: "audio.waveform",
    input: rel(ctx, input),
    sampleRate,
    windowMs,
    durationMs: Math.round(totalSamples / sampleRate * 1000),
    windows,
  }, p.output);
}
