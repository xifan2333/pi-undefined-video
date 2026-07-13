/**
 * uvid analyze frame-diff — video → change-point JSON only (no stills).
 *
 * Optional [fromMs, toMs) window on the source timeline (ms, half-open).
 * points[].timeMs is always absolute source time, not window-relative.
 */
import { materializeInput, openFilterIo, writeJsonOutput } from "../io.ts";
import { execBuffer } from "../proc.ts";
import { type Ctx, fail } from "../util.ts";

export interface FrameChangePoint {
  timeMs: number;
  score: number;
  level: "high" | "medium" | "low";
}

export interface AnalyzeFrameDiffParams {
  input?: string;
  output?: string;
  fps?: number;
  width?: number;
  height?: number;
  /** Inclusive start of analysis window on source timeline (ms). Default 0. */
  fromMs?: number;
  /** Exclusive end of analysis window on source timeline (ms). Omit = end of media. */
  toMs?: number;
  /**
   * Minimum score to keep a point. When set, replaces the adaptive threshold floor
   * (still uses adaptive thr = max(minScore, median*10, p90*1.5) unless minScore alone is higher).
   * Pass a high value to force manual gating, e.g. 0.02.
   */
  minScore?: number;
  /** Max points after ranking by score; default 40. */
  maxPoints?: number;
  /** Merge points closer than this many ms; default ≈ 2 sample intervals. */
  mergeMs?: number;
}

export interface FrameDiffOpts {
  fps: number;
  width: number;
  height: number;
  fromMs: number;
  toMs?: number;
  minScore?: number;
  maxPoints: number;
  mergeMs: number;
}

export async function computeFrameChanges(
  inputAbs: string,
  opts: FrameDiffOpts,
  ctx: Ctx,
): Promise<FrameChangePoint[]> {
  const fps = opts.fps > 0 ? opts.fps : 5;
  const width = opts.width > 0 ? opts.width : 320;
  const height = opts.height > 0 ? opts.height : Math.max(1, Math.round((width * 9) / 16));
  const fromMs = opts.fromMs > 0 ? Math.floor(opts.fromMs) : 0;
  const toMs = opts.toMs != null ? Math.floor(opts.toMs) : undefined;
  const maxPoints = opts.maxPoints > 0 ? Math.floor(opts.maxPoints) : 40;
  const mergeMs =
    opts.mergeMs > 0 ? Math.floor(opts.mergeMs) : Math.round(1000 / fps) * 2;
  const minScore = opts.minScore != null && Number.isFinite(opts.minScore) ? opts.minScore : undefined;

  if (fromMs < 0) fail(`frame-diff --from-ms must be >= 0, got ${fromMs}`);
  if (toMs != null && toMs <= fromMs) {
    fail(`frame-diff window empty: --from-ms ${fromMs} --to-ms ${toMs} (need toMs > fromMs)`);
  }

  const frameBytes = width * height;

  // Decode only the requested window. -ss after -i keeps time accuracy for short windows.
  const args = ["-hide_banner", "-loglevel", "error", "-i", inputAbs, "-an"];
  if (fromMs > 0) args.push("-ss", (fromMs / 1000).toFixed(3));
  if (toMs != null) args.push("-t", ((toMs - fromMs) / 1000).toFixed(3));
  args.push(
    "-vf",
    `fps=${fps},scale=${width}:${height},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  );

  let buf: Buffer;
  try {
    buf = await execBuffer("ffmpeg", args, { signal: ctx.signal });
  } catch (e: any) {
    fail(`frame-diff failed: ${e?.message || e}`);
  }

  const frameCount = Math.floor(buf.length / frameBytes);
  if (frameCount < 2) return [];

  const scores: { timeMs: number; score: number }[] = [];
  let prev = buf.subarray(0, frameBytes);
  for (let i = 1; i < frameCount; i++) {
    const cur = buf.subarray(i * frameBytes, (i + 1) * frameBytes);
    let sum = 0;
    for (let p = 0; p < frameBytes; p += 4) {
      sum += Math.abs(cur[p] - prev[p]);
    }
    const samples = Math.ceil(frameBytes / 4);
    const score = sum / samples / 255;
    scores.push({
      // absolute source time = window start + offset inside the decoded window
      timeMs: fromMs + Math.round((i * 1000) / fps),
      score: Number(score.toFixed(4)),
    });
    prev = cur;
  }

  // Drop any trailing sample that landed on/after toMs (half-open end).
  const inWindow = toMs == null ? scores : scores.filter((s) => s.timeMs < toMs);

  const sorted = inWindow.map((s) => s.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? median;
  // Adaptive thr; minScore raises the floor (or forces a hard gate when larger).
  let thr = Math.max(1e-4, median * 10, p90 * 1.5);
  if (minScore != null) thr = Math.max(thr, minScore);

  const points: FrameChangePoint[] = [];
  for (const s of inWindow) {
    if (s.score < thr) continue;
    const level: FrameChangePoint["level"] =
      s.score >= thr * 3 ? "high" : s.score >= thr * 1.5 ? "medium" : "low";
    const last = points[points.length - 1];
    if (last && s.timeMs - last.timeMs < mergeMs) {
      if (s.score > last.score) {
        last.timeMs = s.timeMs;
        last.score = s.score;
        last.level = level;
      }
      continue;
    }
    points.push({ timeMs: s.timeMs, score: s.score, level });
  }

  if (points.length > maxPoints) {
    return [...points]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPoints)
      .sort((a, b) => a.timeMs - b.timeMs);
  }
  return points;
}

export async function analyzeFrameDiff(p: AnalyzeFrameDiffParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p);
  const mat = await materializeInput(ctx, input, { ext: ".mp4" });
  try {
    const fps = p.fps ?? 5;
    const width = p.width ?? 320;
    const height = p.height ?? Math.max(1, Math.round((width * 9) / 16));
    const fromMs = p.fromMs ?? 0;
    const toMs = p.toMs;
    const maxPoints = p.maxPoints ?? 40;
    const mergeMs = p.mergeMs ?? Math.round(1000 / fps) * 2;
    const points = await computeFrameChanges(
      mat.path,
      {
        fps,
        width,
        height,
        fromMs,
        toMs,
        minScore: p.minScore,
        maxPoints,
        mergeMs,
      },
      ctx,
    );
    writeJsonOutput(ctx, output, {
      schemaVersion: 1,
      kind: "analyze.frame-diff",
      input: input.label,
      fps,
      width,
      height,
      fromMs,
      toMs: toMs ?? null,
      minScore: p.minScore ?? null,
      maxPoints,
      mergeMs,
      points,
    });
  } finally {
    mat.cleanup();
  }
}
