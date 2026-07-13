/**
 * uvid generate normalize — media → one loudnorm-normalized media file.
 *
 * Default audio format: mp3 (smaller intermediates). Override with -f / -o ext.
 *   -f mp3|wav|aac  → audio only
 *   -f mp4          → keep video stream copy + normalized aac (video inputs)
 *
 * Editing knobs: --lufs/--tp/--lra, -f, --bitrate, --sample-rate, --from-ms/--to-ms.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  audioEncodeArgs,
  formatExt,
  isAudioFormat,
  resolveFormat,
  type MediaFormat,
} from "../format.ts";
import { materializeInput, openFilterIo, publishFileOutput } from "../io.ts";
import {
  ffmpeg,
  hasVideoStream,
  LOUDNORM_PASSTHROUGH_NOTE,
  loudnormMeasure,
  loudnormSecondPassFilter,
} from "../proc.ts";
import { type Ctx, ensureDir, fail, rel } from "../util.ts";

export interface GenerateNormalizeParams {
  input?: string;
  output?: string;
  /** Output format: mp3 (default) | wav | aac | mp4 */
  format?: string;
  lufs: number;
  tp: number;
  lra: number;
  /** Audio bitrate for lossy encodes, e.g. 192k / 128k. Default 192k. */
  bitrate?: string;
  /** Output sample rate Hz. Default 48000. */
  sampleRate?: number;
  /** Optional half-open source window to normalize (trim). */
  fromMs?: number;
  toMs?: number;
}

function tmpPath(format: MediaFormat): string {
  return path.join(os.tmpdir(), `uvid-norm-${process.pid}-${Date.now()}${formatExt(format)}`);
}

function seekArgs(fromMs: number, toMs?: number): string[] {
  const args: string[] = [];
  if (fromMs > 0) args.push("-ss", (fromMs / 1000).toFixed(3));
  if (toMs != null) args.push("-t", ((toMs - fromMs) / 1000).toFixed(3));
  return args;
}

export async function generateNormalize(p: GenerateNormalizeParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p, { binaryOutput: true });
  const mat = await materializeInput(ctx, input, { ext: ".media" });

  try {
    const hasVideo = await hasVideoStream(mat.path, { signal: ctx.signal });
    const format = resolveFormat({
      format: p.format,
      outputPath: output.path,
      defaultFormat: "mp3",
    });

    if (format === "mp4" && !hasVideo) {
      fail("format mp4 requires a video input; use -f mp3|wav|aac for audio-only");
    }

    const fromMs = p.fromMs != null && p.fromMs > 0 ? Math.floor(p.fromMs) : 0;
    const toMs = p.toMs != null ? Math.floor(p.toMs) : undefined;
    if (fromMs < 0) fail(`normalize --from-ms must be >= 0, got ${fromMs}`);
    if (toMs != null && toMs <= fromMs) {
      fail(`normalize window empty: --from-ms ${fromMs} --to-ms ${toMs}`);
    }

    const sampleRate = p.sampleRate ?? 48000;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) fail(`invalid sampleRate: ${sampleRate}`);
    const bitrate = (p.bitrate ?? "192k").trim();
    if (!bitrate) fail("invalid bitrate");

    const outPath = output.path ?? tmpPath(format);
    ensureDir(path.dirname(outPath));

    ctx.log(`normalize ${input.label} → ${output.path ? rel(ctx, output.path) : "stdout"}`);
    ctx.log(
      `  format=${format}  I=${p.lufs} LUFS  TP=${p.tp} dBTP  LRA=${p.lra}  br=${bitrate}  ar=${sampleRate}` +
        (fromMs > 0 || toMs != null ? `  window=[${fromMs},${toMs ?? "end"})` : ""),
    );

    const m = await loudnormMeasure(mat.path, p.lufs, p.tp, p.lra, {
      signal: ctx.signal,
      fromMs,
      toMs,
    });
    const { filter, mode } = loudnormSecondPassFilter(m, {
      lufs: p.lufs,
      tp: p.tp,
      lra: p.lra,
      sampleRate,
    });
    if (mode === "passthrough") {
      ctx.log(LOUDNORM_PASSTHROUGH_NOTE);
    }
    const window = seekArgs(fromMs, toMs);

    if (format === "mp4") {
      await ffmpeg(
        [
          ...window,
          "-i",
          mat.path,
          "-c:v",
          "copy",
          "-af",
          filter,
          "-c:a",
          "aac",
          "-b:a",
          bitrate,
          "-ar",
          String(sampleRate),
          outPath,
        ],
        { signal: ctx.signal },
      );
    } else if (isAudioFormat(format)) {
      await ffmpeg(
        [
          ...window,
          "-i",
          mat.path,
          "-vn",
          "-af",
          filter,
          ...audioEncodeArgs(format, { bitrate, sampleRate }),
          outPath,
        ],
        { signal: ctx.signal },
      );
    } else {
      fail(`unsupported format: ${format}`);
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fail("normalize produced empty output");
    }

    // -o: emit absolute path on stdout; no -o: stream bytes (then drop temp).
    publishFileOutput(ctx, output, outPath);
    if (!output.path) {
      try {
        fs.unlinkSync(outPath);
      } catch {
        /* ignore */
      }
    }
  } finally {
    mat.cleanup();
  }
}
