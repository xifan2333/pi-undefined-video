/**
 * uvid analyze loudness — media → one loudness JSON (ebur128).
 *
 * Optional [fromMs, toMs) measures only that source window.
 */
import { materializeInput, openFilterIo, writeJsonOutput } from "../io.ts";
import { ffmpeg } from "../proc.ts";
import { type Ctx, fail } from "../util.ts";

export interface AnalyzeLoudnessParams {
  input?: string;
  output?: string;
  /** Inclusive start on source timeline (ms). Default 0. */
  fromMs?: number;
  /** Exclusive end on source timeline (ms). Omit = end of media. */
  toMs?: number;
}

/** Read a labeled number from ebur128's final Summary block (not the progressive lines). */
function summaryNumber(summary: string, label: string, unit: string): number | null {
  // e.g. "    I:         -14.8 LUFS" / "    Peak:       -1.5 dBFS"
  // In a string/template, write \\s / \\d so RegExp receives \s / \d.
  const re = new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?)\\s+${unit}`);
  const m = summary.match(re);
  return m ? Number(m[1]) : null;
}

function parseEbur128(log: string): { I: number; LRA: number | null; peak: number | null } {
  // Progressive meter lines are noisy; the trailing Summary is authoritative.
  const summary = log.includes("Summary:") ? log.slice(log.lastIndexOf("Summary:")) : log;
  const I = summaryNumber(summary, "I", "LUFS");
  if (I == null) fail("could not parse integrated loudness from ffmpeg ebur128 Summary");
  return {
    I,
    LRA: summaryNumber(summary, "LRA", "LU"),
    peak: summaryNumber(summary, "Peak", "dBFS"),
  };
}

export async function analyzeLoudness(p: AnalyzeLoudnessParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p);
  const mat = await materializeInput(ctx, input, { ext: ".media" });
  try {
    const fromMs = p.fromMs != null && p.fromMs > 0 ? Math.floor(p.fromMs) : 0;
    const toMs = p.toMs != null ? Math.floor(p.toMs) : undefined;
    if (fromMs < 0) fail(`loudness --from-ms must be >= 0, got ${fromMs}`);
    if (toMs != null && toMs <= fromMs) {
      fail(`loudness window empty: --from-ms ${fromMs} --to-ms ${toMs}`);
    }

    const args = ["-i", mat.path];
    if (fromMs > 0) args.push("-ss", (fromMs / 1000).toFixed(3));
    if (toMs != null) args.push("-t", ((toMs - fromMs) / 1000).toFixed(3));
    args.push("-filter_complex", "ebur128=peak=true", "-f", "null", "-");

    const log = await ffmpeg(args, { signal: ctx.signal });
    const { I, LRA, peak } = parseEbur128(log);

    writeJsonOutput(ctx, output, {
      schemaVersion: 1,
      kind: "analyze.loudness",
      input: input.label,
      fromMs,
      toMs: toMs ?? null,
      I,
      unitI: "LUFS",
      LRA,
      unitLRA: "LU",
      peak,
      unitPeak: "dBFS",
    });
  } finally {
    mat.cleanup();
  }
}
